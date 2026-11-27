'use strict';
// Règles métier partagées : frise des projets, marge, « À décider », création de projet depuis un devis.
const { q, PHASES } = require('./db');
const { today, parseDate, ddmm, addDays, iso } = require('./html');

const people = () => q.all('SELECT * FROM people WHERE active = 1 ORDER BY role = \'patron\', id');
const peopleMap = () => Object.fromEntries(q.all('SELECT * FROM people').map((p) => [p.id, p]));
const patron = () => q.get("SELECT * FROM people WHERE role = 'patron' ORDER BY id LIMIT 1");
const personName = (p) => (p && p.role === 'patron' ? 'toi' : p ? p.name : 'personne');

// État de chaque étape de la frise : d = fait, c = en cours, p = bloque, w = à venir, n = sans objet.
function frise(project) {
  const steps = q.all('SELECT phase, status FROM steps WHERE project_id = ?', project.id);
  const over = Object.fromEntries(q.all('SELECT * FROM phase_overrides WHERE project_id = ?', project.id).map((o) => [o.phase, o]));
  const plan = q.get("SELECT * FROM plans WHERE project_id = ? ORDER BY (status = 'validee') DESC, id DESC LIMIT 1", project.id);
  const trip = q.get('SELECT * FROM trips WHERE project_id = ? ORDER BY date LIMIT 1', project.id);
  const openIssue = q.get("SELECT id FROM issues WHERE project_id = ? AND status = 'open' LIMIT 1", project.id);
  const blockedNeed = q.get("SELECT id FROM needs WHERE project_id = ? AND status = 'todo' AND needs_deposit = 1 AND force = 0 LIMIT 1", project.id);
  return PHASES.map((ph) => {
    if (over[ph]) return { phase: ph, state: over[ph].state, label: over[ph].label || defaultLabel(over[ph].state) };
    const mine = steps.filter((s) => s.phase === ph);
    let state = 'w', label = 'À venir';
    if (ph === 'Conception' && project.model_id) { state = 'd'; label = 'Modèle du catalogue'; }
    else if (ph === 'Conception') {
      if (plan && plan.status === 'validee') { state = 'd'; label = `${plan.version} validée`; }
      else if (plan) { state = 'c'; label = `${plan.version} à valider`; }
      else { state = 'c'; label = 'À démarrer'; }
    } else if (ph === 'Accord') {
      if (!project.client_id || !project.deposit_needed) { state = 'n'; label = 'Sans objet'; }
      else if (project.deposit_at) { state = 'd'; label = 'Acompte reçu'; }
      else { state = 'p'; label = 'Acompte attendu'; }
    } else if (ph === 'Bois' && !mine.length && q.get('SELECT id FROM wood_lots WHERE project_id = ?', project.id)) {
      state = 'd'; label = 'Bois réservé';
    } else if (ph === 'Bois' && blockedNeed && !mine.length) {
      state = 'w'; label = 'À commander';
    } else if (ph === 'Livraison' && trip && !mine.length) {
      state = trip.done_at ? 'd' : 'w'; label = trip.done_at ? 'Livré' : `Pose ${ddmm(trip.date)}`;
    } else if (ph === 'Réception' && !mine.length) {
      if (trip && trip.pv_signed_at) { state = 'd'; label = trip.pv_reserves ? 'PV avec réserve' : 'PV signé'; }
      else if (!project.client_id) { state = 'n'; label = 'Sans objet'; }
      else { label = 'PV à signer'; }
    }
    if (mine.length) {
      const done = mine.filter((s) => s.status === 'done').length;
      if (done === mine.length) { state = 'd'; label = 'Fait'; }
      else if (done || mine.some((s) => s.status === 'doing')) { state = 'c'; label = `${done}/${mine.length} fiches`; }
      else { state = 'w'; label = `${mine.length} fiche${mine.length > 1 ? 's' : ''}`; }
    }
    if (openIssue && state === 'c') state = 'p';
    return { phase: ph, state, label };
  });
}
const defaultLabel = (s) => ({ d: 'Fait', c: 'En cours', p: 'À traiter', w: 'À venir', n: 'Sans objet' })[s];

// Phase « courante » : la première pas faite (pour l'en-tête des cartes).
function currentPhase(fr) { return fr.find((f) => f.state === 'c' || f.state === 'p') || fr.find((f) => f.state === 'w') || fr[fr.length - 1]; }

// Jours ouvrés entre deux dates.
function workdays(from, to) {
  let n = 0; const d = parseDate(from); const end = parseDate(to);
  if (!d || !end) return null;
  while (d < end) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n++; }
  return n;
}
// Marge : jours ouvrés restants avant l'échéance moins les jours de travail encore prévus.
function slack(project) {
  if (!project.due_date) return { text: 'à fixer', color: '#6B635A' };
  const left = q.get("SELECT COALESCE(SUM(est_hours), 0) h, COUNT(*) n FROM steps WHERE project_id = ? AND status != 'done'", project.id);
  const avail = workdays(today(), project.due_date);
  if (avail === null) return { text: '', color: '#6B635A' };
  const need = Math.ceil(left.h / 8);
  const m = avail - need;
  if (avail <= 0 && left.n) return { text: 'en retard', color: '#A20212' };
  if (m < 0) return { text: 'en retard', color: '#A20212' };
  if (m <= 2) return { text: 'tendu', color: '#A20212' };
  return { text: `${m} j de marge`, color: '#1A1714' };
}

function projectSummary(p) {
  const fr = frise(p);
  const cur = currentPhase(fr);
  const client = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  const lead = p.lead_id ? q.get('SELECT * FROM people WHERE id = ?', p.lead_id) : null;
  return { ...p, frise: fr, cur, client, lead, slack: slack(p), next: p.next_action || `${cur.phase} · ${cur.label}` };
}

// Tout ce qui attend une réponse du patron.
function toDecide() {
  const items = [];
  for (const qt of q.all("SELECT * FROM quotes WHERE status = 'accepted' AND treated = 0 ORDER BY accepted_at DESC")) {
    items.push({ kind: 'ok', tag: 'Devis accepté', title: qt.signer_name, text: `Accepté sur son portail le ${ddmm(qt.accepted_at)} · la commande est créée`, href: `/portails#q${qt.id}`, cta: 'Ouvrir son espace client', primary: true });
  }
  for (const qt of q.all("SELECT * FROM quotes WHERE status IN ('modif','refused') AND treated = 0 ORDER BY responded_at DESC")) {
    items.push({ kind: qt.status === 'refused' ? 'ko' : 'wa', tag: 'Portail', title: `${qt.status === 'refused' ? 'Devis refusé' : 'Modification demandée'} · ${qt.project_name || qt.number}`, text: `${qt.signer_name} : « ${qt.response_text || '—'} »`, href: `/portails#q${qt.id}r`, cta: 'Voir la demande' });
  }
  for (const n of q.all("SELECT needs.*, people.name pname FROM needs LEFT JOIN people ON people.id = needs.person_id WHERE status = 'todo' AND acknowledged = 0 AND source IN ('stock','ipad') ORDER BY created_at DESC")) {
    items.push({ kind: 'wa', tag: 'Achat', title: `${n.text} · ${n.source === 'stock' ? 'signalé vide' : 'il manque'}`, text: `Par ${n.pname || 'l’atelier'} ${n.source === 'ipad' ? 'depuis l’iPad' : 'dans le stock'}`, href: '/achats', cta: 'Valider', ack: n.id });
  }
  for (const p of q.all("SELECT * FROM projects WHERE status = 'en_cours' AND client_id IS NOT NULL AND deposit_needed = 1 AND deposit_at IS NULL")) {
    const since = p.deposit_asked_at || p.created_at;
    const blocks = q.get("SELECT COUNT(*) n FROM needs WHERE project_id = ? AND status = 'todo' AND needs_deposit = 1", p.id).n;
    items.push({ kind: 'ko', tag: 'Acompte', title: `${p.name} · acompte non reçu`, text: `Demandé ${relDays(since)}${blocks ? ' · bloque des achats' : ''}`, href: `/projets/${p.id}#acompte`, cta: 'Ouvrir', act: `/projets/${p.id}/acompte`, actLabel: 'Reçu aujourd’hui' });
  }
  for (const m of q.all('SELECT messages.*, steps.title st, steps.project_id pid, people.name pname FROM messages JOIN steps ON steps.id = messages.step_id LEFT JOIN people ON people.id = messages.person_id WHERE read_by_patron = 0 ORDER BY messages.created_at DESC')) {
    items.push({ kind: 'no', tag: 'Message', title: `${m.pname} · ${m.st}`, text: `« ${m.body} »`, href: `/carnets/${m.pid}?fiche=${m.step_id}`, cta: 'Répondre' });
  }
  // Sous-traitance : retour en retard, ou prestation proposée encore à commander alors que la livraison approche.
  for (const s of q.all(`SELECT subcontracts.*, projects.name pname, suppliers.name sname FROM subcontracts JOIN projects ON projects.id = subcontracts.project_id
    LEFT JOIN suppliers ON suppliers.id = subcontracts.supplier_id WHERE projects.status = 'en_cours' AND subcontracts.back_at IS NULL AND subcontracts.status != 'a_commander' AND subcontracts.due_at < ?`, today())) {
    items.push({ kind: 'ko', tag: 'Sous-traitance', title: `${s.pname} · ${s.what}`, text: `Retour prévu le ${ddmm(s.due_at)}${s.sname ? ` chez ${s.sname}` : ''} · pas encore revenu`, href: `/projets/${s.project_id}#sst${s.id}`, cta: 'Ouvrir' });
  }
  // Chaîne de production générée depuis le devis : à vérifier, puis le carnet part à l'atelier.
  for (const p of q.all("SELECT * FROM projects WHERE status = 'en_cours' AND prod_status IN ('pret', 'erreur')")) {
    if (p.prod_status === 'erreur') { items.push({ kind: 'ko', tag: 'Chaîne', title: `${p.name} · chaîne de production non générée`, text: p.prod_error || '', href: `/projets/${p.id}#chaine`, cta: 'Voir' }); continue; }
    const n = q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ? AND sent = 0', p.id).n;
    if (n) items.push({ kind: 'wa', tag: 'Chaîne', title: `${p.name} · carnet préparé par l’assistant (${n} fiches)`, text: 'Vérifie les fiches et la matière, puis envoie le carnet à l’atelier. Le planning les montre déjà en prévisionnel.', href: `/carnets/${p.id}`, cta: 'Vérifier le carnet' });
  }
  // Devis signé, acompte attendu, mais pas encore de facture d'acompte sur le portail.
  for (const p of q.all(`SELECT projects.* FROM projects JOIN quotes ON quotes.project_id = projects.id AND quotes.status = 'accepted'
      WHERE projects.status = 'en_cours' AND projects.deposit_needed = 1 AND projects.deposit_at IS NULL AND quotes.accepted_at <= datetime('now', '-1 day')
      AND NOT EXISTS (SELECT 1 FROM documents WHERE documents.project_id = projects.id AND documents.kind = 'facture_acompte') GROUP BY projects.id`)) {
    items.push({ kind: 'wa', tag: 'Facture', title: `${p.name} · facture d’acompte pas encore sur le portail`, text: 'Cockpit ne l’a pas encore envoyée. Tu peux déposer le PDF sur l’OF.', href: `/projets/${p.id}#facture`, cta: 'Déposer' });
  }
  const all = [...items, ...require('./automations').alerts()];
  const later = new Set(q.all('SELECT key FROM snoozes WHERE until > ?', today()).map((x) => x.key));
  const order = { ko: 0, wa: 1, ok: 2, no: 3 };
  return all.map((d) => ({ ...d, key: `${d.tag}|${d.href}|${d.title}` }))
    .filter((d) => !later.has(d.key))
    .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
}
// Au-delà de 3 alertes du même genre, une seule ligne les résume (le détail est sur la page À décider).
const GROUP_LINK = { Acompte: '/projets?f=acompte', Relance: '/projets?f=acompte', 'Retard prévu': '/projets?f=retard', Entretien: '/machines' };
function groupDecide(items, max = 3) {
  const byTag = {};
  for (const d of items) (byTag[d.tag] = byTag[d.tag] || []).push(d);
  const out = [], seen = new Set();
  for (const d of items) {
    const g = byTag[d.tag];
    if (g.length <= max) { out.push(d); continue; }
    if (seen.has(d.tag)) continue;
    seen.add(d.tag);
    out.push({ kind: d.kind, tag: d.tag, group: g.length, title: `${g.length} × ${d.tag.toLowerCase()}`, text: g.slice(0, 3).map((x) => x.title.split(' · ')[0]).join(', ') + (g.length > 3 ? '…' : ''),
      href: GROUP_LINK[d.tag] || `/decider?tag=${encodeURIComponent(d.tag)}`, cta: 'Voir la liste' });
  }
  return out;
}
function relDays(s) {
  const n = Math.round((parseDate(today()) - parseDate(String(s).slice(0, 10))) / 86400000);
  return n <= 0 ? 'aujourd’hui' : n === 1 ? 'hier' : `il y a ${n} jours`;
}

// Un devis accepté crée (ou rattache) le client et la commande.
function projectFromQuote(quote) {
  let clientId = quote.client_id;
  if (!clientId) {
    const existing = q.get('SELECT id FROM clients WHERE lower(email) = lower(?)', quote.signer_email);
    clientId = existing ? existing.id : Number(q.run('INSERT INTO clients (name, email, phone, kind) VALUES (?, ?, ?, ?)', quote.signer_name, quote.signer_email, quote.signer_phone || '', 'Particulier').lastInsertRowid);
    q.run('UPDATE quotes SET client_id = ? WHERE id = ?', clientId, quote.id);
  }
  let projectId = quote.project_id;
  if (!projectId) {
    const name = quote.project_name || `Commande ${quote.signer_name}`;
    projectId = Number(q.run("INSERT INTO projects (name, kind, client_id, next_action, deposit_asked_at, lead_id) VALUES (?, 'Particulier', ?, 'Lancer le projet', datetime('now'), ?)", name, clientId, patron().id).lastInsertRowid);
    q.run('UPDATE quotes SET project_id = ? WHERE id = ?', projectId, quote.id);
  }
  q.run("INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, 'Conception', 'c', 'À démarrer')", projectId);
  return projectId;
}

// Fiches de l'atelier pour une personne, dans l'ordre du carnet.
function stepsFor(personId) {
  return q.all(`SELECT steps.*, projects.name pname, projects.id pid FROM steps JOIN projects ON projects.id = steps.project_id
    WHERE steps.sent = 1 AND steps.who_id = ? AND steps.status != 'done' AND projects.status = 'en_cours'
    ORDER BY steps.status = 'doing' DESC, projects.due_date IS NULL, projects.due_date, steps.ord`, personId);
}

// Couleur stable par projet (pastilles de l'iPad).
const PCOLORS = ['#1A1714', '#6B635A', '#4A443E', '#8C8279', '#2E2925', '#5A534B'];
const projectColor = (id) => PCOLORS[id % PCOLORS.length];

module.exports = { people, peopleMap, patron, personName, frise, currentPhase, slack, workdays, projectSummary, toDecide, groupDecide, projectFromQuote, stepsFor, projectColor, relDays, iso, addDays };
