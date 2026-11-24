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
    if (ph === 'Conception') {
      if (plan && plan.status === 'validee') { state = 'd'; label = `${plan.version} validée`; }
      else if (plan) { state = 'c'; label = `${plan.version} à valider`; }
      else { state = 'c'; label = 'À démarrer'; }
    } else if (ph === 'Accord') {
      if (!project.client_id || !project.deposit_needed) { state = 'n'; label = 'Sans objet'; }
      else if (project.deposit_at) { state = 'd'; label = 'Acompte reçu'; }
      else { state = 'p'; label = 'Acompte attendu'; }
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
  if (!project.due_date) return { text: 'à fixer', color: '#7A4E00' };
  const left = q.get("SELECT COALESCE(SUM(est_hours), 0) h, COUNT(*) n FROM steps WHERE project_id = ? AND status != 'done'", project.id);
  const avail = workdays(today(), project.due_date);
  if (avail === null) return { text: '', color: '#5F5A52' };
  const need = Math.ceil(left.h / 8);
  const m = avail - need;
  if (avail <= 0 && left.n) return { text: 'en retard', color: '#8A2B1E' };
  if (m < 0) return { text: 'en retard', color: '#8A2B1E' };
  if (m <= 2) return { text: 'tendu', color: '#8A2B1E' };
  return { text: `${m} j de marge`, color: '#2F5D3A' };
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
    items.push({ kind: qt.status === 'refused' ? 'ko' : 'wa', tag: 'Portail', title: `${qt.status === 'refused' ? 'Devis refusé' : 'Modification demandée'} · ${qt.project_name || qt.number}`, text: `${qt.signer_name} : « ${qt.response_text || '—'} »`, href: `/portails#q${qt.id}`, cta: 'Voir la demande' });
  }
  for (const n of q.all("SELECT needs.*, people.name pname FROM needs LEFT JOIN people ON people.id = needs.person_id WHERE status = 'todo' AND acknowledged = 0 AND source IN ('stock','ipad') ORDER BY created_at DESC")) {
    items.push({ kind: 'wa', tag: 'Achat', title: `${n.text} · ${n.source === 'stock' ? 'signalé vide' : 'il manque'}`, text: `Par ${n.pname || 'l’atelier'} ${n.source === 'ipad' ? 'depuis l’iPad' : 'dans le stock'}`, href: '/achats', cta: 'Valider', ack: n.id });
  }
  for (const p of q.all("SELECT * FROM projects WHERE status = 'en_cours' AND client_id IS NOT NULL AND deposit_needed = 1 AND deposit_at IS NULL")) {
    const since = p.deposit_asked_at || p.created_at;
    const blocks = q.get("SELECT COUNT(*) n FROM needs WHERE project_id = ? AND status = 'todo' AND needs_deposit = 1", p.id).n;
    items.push({ kind: 'ko', tag: 'Acompte', title: `${p.name} · acompte non reçu`, text: `Demandé ${relDays(since)}${blocks ? ' · bloque des achats' : ''}`, href: `/projets/${p.id}#acompte`, cta: 'Noter reçu' });
  }
  for (const m of q.all('SELECT messages.*, steps.title st, steps.project_id pid, people.name pname FROM messages JOIN steps ON steps.id = messages.step_id LEFT JOIN people ON people.id = messages.person_id WHERE read_by_patron = 0 ORDER BY messages.created_at DESC')) {
    items.push({ kind: 'no', tag: 'Message', title: `${m.pname} · ${m.st}`, text: `« ${m.body} »`, href: `/carnets/${m.pid}?fiche=${m.step_id}`, cta: 'Répondre' });
  }
  return items;
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
    clientId = existing ? existing.id : Number(q.run('INSERT INTO clients (name, email, kind) VALUES (?, ?, ?)', quote.signer_name, quote.signer_email, 'Particulier').lastInsertRowid);
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
const PCOLORS = ['#5B4636', '#3D5A73', '#B7791F', '#2F5D3A', '#6B4E71', '#8A2B1E'];
const projectColor = (id) => PCOLORS[id % PCOLORS.length];

module.exports = { people, peopleMap, patron, personName, frise, currentPhase, slack, workdays, projectSummary, toDecide, projectFromQuote, stepsFor, projectColor, relDays, iso, addDays };
