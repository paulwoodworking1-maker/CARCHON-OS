'use strict';
// Assistant de l'atelier : on lui pose une question en français, il cherche la réponse dans les
// données de Carchon OS (outils en lecture) et peut faire trois actions sûres et réversibles :
// noter un achat, ajouter une fiche en brouillon dans un carnet, ajouter une absence.
// Rien n'est envoyé à l'atelier ni aux clients par l'assistant.
const AnthropicMod = require('@anthropic-ai/sdk');
const { q, db, logActivity } = require('./db');
const { today } = require('./html');
const ai = require('./ai');

const Anthropic = AnthropicMod.default || AnthropicMod;
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;
const api = () => (client = client || new Anthropic({ timeout: 120000 }));

db.exec(`CREATE TABLE IF NOT EXISTS assistant_msgs (
  id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
)`);

const SYSTEM = `Tu es l'assistant de Carchon OS, le logiciel de fabrication de Carchon Les Ateliers (ébénisterie : luminaires et mobilier en série limitée et sur-mesure, atelier de Couternon). Tu parles au patron, en français, en le tutoyant.

Comment travailler :
- Pour toute question sur l'atelier, appelle d'abord les outils : n'invente jamais un chiffre, une date, un nom, un stock ou une heure. Si l'information n'est pas dans les outils, dis-le simplement.
- Réponds court et concret : la réponse d'abord, puis le détail utile (références d'OF, numéros de pièces, dates au format jj/mm). Pas de titres, des listes courtes si besoin.
- Tu peux faire trois actions : noter un achat, ajouter une fiche en brouillon dans un carnet, ajouter une absence. Fais-les seulement si le patron le demande clairement, puis dis exactement ce que tu as fait. Tu ne peux rien envoyer à l'atelier ni aux clients : le patron le fait lui-même.
- Quand une page du logiciel aide, donne son chemin (ex. « Planifier › Charge »).`;

const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const s = (description) => ({ type: 'string', description });
const TOOLS = [
  { name: 'tableau_de_bord', description: "Le point du jour : ce qui attend une décision, OF en cours avec leur étape et leur date, problèmes signalés, alertes machines.", input_schema: obj({}) },
  { name: 'chercher_of', description: 'Liste les ordres de fabrication (OF), filtrés par texte (nom, client, référence) et statut.', input_schema: obj({ texte: s('Mot à chercher, vide pour tout'), statut: { type: 'string', enum: ['en_cours', 'termine', 'tous'] } }, ['texte', 'statut']) },
  { name: 'detail_of', description: "Tout sur un OF : frise, fiches du carnet (qui, heures prévues et faites), pièces numérotées, bois réservé, achats, livraison.", input_schema: obj({ ref: s('Référence de l’OF, ex. P2026-004') }, ['ref']) },
  { name: 'charge_atelier', description: "Heures prévues et disponibles par personne et par semaine sur 12 semaines, absences déduites.", input_schema: obj({}) },
  { name: 'stock', description: "Bois noble par lot, pièces finies par modèle (prêtes, réservées, seuil), consommables bientôt vides ou vides.", input_schema: obj({}) },
  { name: 'machines', description: "État du parc : pannes, entretiens dépassés ou proches, usage estimé.", input_schema: obj({}) },
  { name: 'achats_et_commandes', description: "Achats à faire et commandes fournisseurs en cours.", input_schema: obj({}) },
  { name: 'sav_et_expeditions', description: "Demandes SAV ouvertes et expéditions en route.", input_schema: obj({}) },
  { name: 'temps_par_geste', description: "Heures réelles moyennes par geste et par modèle, comparées au prévu.", input_schema: obj({}) },
  { name: 'noter_achat', description: "Action : ajoute une ligne à « À commander » (rien n'est commandé).", input_schema: obj({ texte: s('Ce qu’il faut acheter, avec la quantité'), ref_of: s('Référence de l’OF concerné, ou vide') }, ['texte', 'ref_of']) },
  { name: 'ajouter_fiche_brouillon', description: "Action : ajoute une fiche NON envoyée à la fin du carnet d'un OF.", input_schema: obj({ ref_of: s('Référence de l’OF'), titre: s('Titre court de la fiche'), qui: s('Prénom de la personne, ou vide'), heures: { type: 'number', description: 'Heures prévues, 0 si inconnu' }, mot: s('Consigne du patron, ou vide') }, ['ref_of', 'titre', 'qui', 'heures', 'mot']) },
  { name: 'ajouter_absence', description: 'Action : ajoute une absence (congé, formation…) qui sera déduite de la charge.', input_schema: obj({ qui: s('Prénom'), du: s('Date de début AAAA-MM-JJ'), au: s('Date de fin AAAA-MM-JJ'), motif: s('Motif') }, ['qui', 'du', 'au', 'motif']) },
];

const L = () => require('./logic');
function ofRow(p) {
  const sm = L().projectSummary(p);
  const h = q.get('SELECT COALESCE(SUM(est_hours),0) e, COALESCE(SUM(declared_hours),0) d FROM steps WHERE project_id = ?', p.id);
  return { ref: p.ref, nom: p.name, canal: p.canal, client: sm.client?.name || p.for_whom || '', etape: `${sm.cur.phase} · ${sm.cur.label}`, livraison: p.due_date, marge: sm.slack.text, heures_prevues: h.e, heures_faites: h.d, statut: p.status };
}
const person = (name) => q.get('SELECT * FROM people WHERE active = 1 AND (lower(name) = lower(?) OR (role = \'patron\' AND lower(?) IN (\'toi\', \'moi\', \'patron\')))', name, name);

const RUN = {
  tableau_de_bord: () => ({ date: today(), a_decider: L().toDecide().map((d) => `[${d.tag}] ${d.title} — ${d.text}`),
    of_en_cours: q.all("SELECT * FROM projects WHERE status = 'en_cours' ORDER BY due_date").map(ofRow),
    problemes: q.all("SELECT issues.body, projects.ref FROM issues LEFT JOIN projects ON projects.id = issues.project_id WHERE issues.status = 'open'"),
    machines: require('./machines').alerts().map((a) => `${a.title} (${a.text})`) }),
  chercher_of: ({ texte, statut }) => {
    const like = `%${texte || ''}%`;
    return q.all(`SELECT projects.* FROM projects LEFT JOIN clients ON clients.id = projects.client_id WHERE (projects.name LIKE ? OR projects.ref LIKE ? OR clients.name LIKE ? OR projects.for_whom LIKE ?)
      AND (? = 'tous' OR projects.status = ?) ORDER BY projects.id DESC LIMIT 30`, like, like, like, like, statut || 'tous', statut || 'tous').map(ofRow);
  },
  detail_of: ({ ref }) => {
    const p = q.get('SELECT * FROM projects WHERE ref = ?', ref);
    if (!p) return { erreur: `Aucun OF ${ref}` };
    const pm = L().peopleMap();
    return { ...ofRow(p), frise: L().frise(p).map((f) => `${f.phase} : ${f.label}`),
      fiches: q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord', p.id).map((x) => ({ titre: x.title, qui: pm[x.who_id]?.name || 'à prendre', prevu_h: x.est_hours, fait_h: x.declared_hours, etat: x.status, envoyee: !!x.sent })),
      pieces: q.all('SELECT serial, status, reserved_for FROM units WHERE project_id = ?', p.id),
      bois: q.all('SELECT code, essence, thickness, volume FROM wood_lots WHERE project_id = ?', p.id),
      achats: q.all("SELECT text, status FROM needs WHERE project_id = ? AND status != 'arrived'", p.id),
      livraison_pose: q.get('SELECT date, what, pv_signed_at FROM trips WHERE project_id = ? ORDER BY date LIMIT 1', p.id) || null };
  },
  charge_atelier: () => {
    const { weeks, rows } = require('./routes/charge').compute();
    return rows.map((x) => ({ personne: x.p.name, heures_semaine: x.p.hours_week, semaines: x.cells.map((c, i) => ({ debut: weeks[i], prevu_h: Math.round(c.hrs * 10) / 10, dispo_h: Math.round(c.cap * 10) / 10, charge_pct: c.pct, absent_jours: c.absent })) }));
  },
  stock: () => ({
    bois: q.all('SELECT wood_lots.code, essence, thickness, volume, projects.ref reserve_pour FROM wood_lots LEFT JOIN projects ON projects.id = wood_lots.project_id WHERE volume > 0'),
    pieces_finies: q.all(`SELECT models.name, models.threshold seuil, SUM(units.status = 'en_stock') pretes, SUM(units.status = 'en_stock' AND units.reserved_for != '') reservees
      FROM models LEFT JOIN units ON units.model_id = models.id WHERE models.active = 1 GROUP BY models.id`),
    consommables_a_surveiller: q.all('SELECT category, name, state FROM stock_items WHERE state > 0').map((x) => `${x.name} (${x.category}) : ${x.state === 2 ? 'vide' : 'bientôt vide'}`) }),
  machines: () => require('./machines').all().map((m) => ({ machine: m.name, en_panne: m.down_since ? m.down_note || 'oui' : null,
    entretiens: m.tasks.map((t) => ({ quoi: t.title, frequence: t.freq, echeance: t.st.label, en_retard: t.st.late })) })),
  achats_et_commandes: () => ({
    a_commander: q.all("SELECT needs.text, suppliers.name fournisseur, projects.ref FROM needs LEFT JOIN suppliers ON suppliers.id = needs.supplier_id LEFT JOIN projects ON projects.id = needs.project_id WHERE needs.status = 'todo'"),
    commandes_en_cours: q.all('SELECT suppliers.name fournisseur, what, ordered_at, expected_at FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE arrived_at IS NULL') }),
  sav_et_expeditions: () => ({
    sav_ouverts: q.all("SELECT units.serial, sav.client, sav.body, sav.status, sav.warranty, sav.created_at FROM sav LEFT JOIN units ON units.id = sav.unit_id WHERE sav.status != 'close'"),
    expeditions_en_route: q.all('SELECT recipient, carrier, tracking, shipped_at FROM shipments WHERE shipped_at IS NOT NULL AND delivered_at IS NULL') }),
  temps_par_geste: () => ({
    par_geste: q.all("SELECT COALESCE(NULLIF(geste,''),'Autre') geste, COUNT(*) fiches, ROUND(AVG(est_hours),2) prevu_moyen_h, ROUND(AVG(declared_hours),2) reel_moyen_h FROM steps WHERE status = 'done' AND declared_hours > 0 GROUP BY geste"),
    par_modele: q.all("SELECT models.name, COUNT(DISTINCT projects.id) lots, ROUND(SUM(steps.declared_hours) / NULLIF(SUM(DISTINCT projects.qty), 0), 2) heures_par_piece FROM projects JOIN models ON models.id = projects.model_id JOIN steps ON steps.project_id = projects.id AND steps.status = 'done' GROUP BY models.id") }),
  noter_achat: ({ texte, ref_of }) => {
    const p = ref_of ? q.get('SELECT id FROM projects WHERE ref = ?', ref_of) : null;
    q.run("INSERT INTO needs (text, project_id, person_id, source, acknowledged) VALUES (?, ?, ?, 'note', 1)", String(texte).slice(0, 200), p?.id || null, L().patron().id);
    return { fait: `Ajouté à « À commander » : ${texte}${p ? ` (OF ${ref_of})` : ''}` };
  },
  ajouter_fiche_brouillon: ({ ref_of, titre, qui, heures, mot }) => {
    const p = q.get('SELECT id FROM projects WHERE ref = ?', ref_of);
    if (!p) return { erreur: `Aucun OF ${ref_of}` };
    const who = qui ? person(qui) : null;
    const ord = (q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', p.id).m || 0) + 1;
    q.run('INSERT INTO steps (project_id, ord, title, who_id, est_hours, note, ai_generated) VALUES (?, ?, ?, ?, ?, ?, 1)', p.id, ord, String(titre).slice(0, 120), who?.id || null, Math.max(0, Math.min(200, Number(heures) || 0)), String(mot || ''));
    logActivity(p.id, null, `Fiche ajoutée en brouillon par l’assistant : ${titre}`, 'Assistant');
    return { fait: `Fiche « ${titre} » ajoutée en brouillon au carnet de ${ref_of}${who ? ` pour ${who.name}` : ''}. Elle n'est pas envoyée à l'atelier.` };
  },
  ajouter_absence: ({ qui, du, au, motif }) => {
    const who = person(qui);
    if (!who) return { erreur: `Personne inconnue : ${qui}` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(du) || !/^\d{4}-\d{2}-\d{2}$/.test(au)) return { erreur: 'Dates au format AAAA-MM-JJ' };
    const [a, b] = du <= au ? [du, au] : [au, du];
    q.run('INSERT INTO absences (person_id, start_date, end_date, label) VALUES (?, ?, ?, ?)', who.id, a, b, motif || 'Congé');
    return { fait: `Absence ajoutée : ${who.name} du ${a} au ${b} (${motif || 'Congé'}).` };
  },
};

const history = () => q.all('SELECT * FROM assistant_msgs ORDER BY id').map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
const save = (role, content) => q.run('INSERT INTO assistant_msgs (role, content) VALUES (?, ?)', role, JSON.stringify(content));
function reset() { q.run('DELETE FROM assistant_msgs'); }

// Une question : boucle outils jusqu'à la réponse finale. Le fil est gardé en base (blocs renvoyés tels quels).
async function ask(question) {
  if (!ai.enabled()) throw new ai.AIError('L’assistant n’est pas activé (clé ANTHROPIC_API_KEY absente).');
  save('user', [{ type: 'text', text: `${String(question).slice(0, 4000)}\n\n(Aujourd'hui : ${today()})` }]);
  for (let turn = 0; turn < 10; turn++) {
    let res;
    try {
      res = await api().beta.messages.create({
        model: MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages: history(),
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', cache_control: { type: 'ephemeral' },
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new ai.AIError('La clé de l’assistant est refusée : vérifie ANTHROPIC_API_KEY.');
      if (e instanceof Anthropic.RateLimitError) throw new ai.AIError('L’assistant est très demandé : réessaie dans une minute.');
      if (e instanceof Anthropic.APIConnectionError) throw new ai.AIError('Impossible de joindre l’assistant (réseau).');
      if (e instanceof Anthropic.APIError) throw new ai.AIError(`Erreur de l’assistant (${e.status}).`);
      throw e;
    }
    save('assistant', res.content);
    if (res.stop_reason === 'refusal') return;
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) return;
    const results = uses.map((u) => {
      let out;
      try { out = RUN[u.name] ? RUN[u.name](u.input || {}) : { erreur: 'Outil inconnu' }; } catch (e) { out = { erreur: e.message }; }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60000), ...(out && out.erreur ? { is_error: true } : {}) };
    });
    save('user', results);
  }
}

// Ce que la page affiche : questions et réponses en texte, actions faites.
function transcript() {
  const out = [];
  for (const m of q.all('SELECT * FROM assistant_msgs ORDER BY id')) {
    const c = JSON.parse(m.content);
    if (m.role === 'user') {
      const t = c.find((b) => b.type === 'text');
      if (t) out.push({ who: 'toi', text: t.text.replace(/\n\n\(Aujourd'hui : .*\)$/, ''), at: m.created_at });
      for (const r of c.filter((b) => b.type === 'tool_result')) { try { const v = JSON.parse(r.content); if (v.fait) out.push({ who: 'action', text: v.fait, at: m.created_at }); } catch { /* résultat de lecture */ } }
    } else {
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) out.push({ who: 'assistant', text, at: m.created_at });
    }
  }
  return out;
}

module.exports = { ask, reset, transcript, TOOLS, RUN };
