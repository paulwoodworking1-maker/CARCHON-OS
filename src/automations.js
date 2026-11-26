'use strict';
// Automatisations : planning calculé depuis les carnets, estimations apprises, résumé du matin,
// rappel J-2 avant une pose. Tourne toutes les 10 minutes et après chaque changement utile.
const { q, tx, setting, setSetting } = require('./db');
const { today, addDays, parseDate, ddmm, longDate } = require('./html');
const mail = require('./mail');

const HOURS_PER_DAY = 7;
const DEFAULT_HOURS = 4;
const on = (key, def = '1') => (setting(key, def) === '1');

// --- Ce que chaque geste prend vraiment (moyenne des heures déclarées à l'atelier) ---
function averages() {
  const rows = q.all("SELECT geste, AVG(declared_hours) h, COUNT(*) n FROM steps WHERE status = 'done' AND declared_hours > 0 AND geste != '' GROUP BY geste");
  return Object.fromEntries(rows.filter((r) => r.n >= 1).map((r) => [r.geste, r.h]));
}
// Heures à prévoir pour une fiche : la sienne, sinon la moyenne de son geste, sinon 4 h.
function stepHours(step, avg = averages()) {
  return step.est_hours > 0 ? step.est_hours : avg[step.geste] || DEFAULT_HOURS;
}

const isWorkday = (d) => { const w = parseDate(d).getDay(); return w !== 0 && w !== 6; };
const nextWorkday = (d) => { let x = d; while (!isWorkday(x)) x = addDays(x, 1); return x; };

// --- Planning automatique ---
// Pour chaque personne : ses fiches pas finies, dans l'ordre (en cours d'abord, puis échéance du
// projet, puis ordre du carnet), posées jour après jour selon ses heures par jour, en sautant les
// week-ends, ses absences et les jours déjà pris par une barre posée à la main.
// Renvoie aussi les heures posées par jour : c'est la base de la page « Charge ».
function allocate(person, { includeUnsent = false, avg = averages() } = {}) {
  const start = nextWorkday(today());
  const perDay = Math.max(1, (person.hours_week || 35) / 5);
  const steps = q.all(`SELECT steps.*, projects.name pname, projects.ref pref FROM steps JOIN projects ON projects.id = steps.project_id
    WHERE ${includeUnsent ? '' : 'steps.sent = 1 AND '}steps.who_id = ? AND steps.status != 'done' AND projects.status = 'en_cours'
    ORDER BY steps.status = 'doing' DESC, projects.due_date IS NULL, projects.due_date, steps.ord`, person.id);
  const busy = new Set();
  for (const b of q.all("SELECT start_date, end_date FROM bars WHERE person_id = ? AND auto = 0 AND kind != 'free' AND kind != 'work' AND end_date >= ?", person.id, start)) {
    for (let d = b.start_date; d <= b.end_date; d = addDays(d, 1)) busy.add(d);
  }
  for (const a of q.all('SELECT start_date, end_date FROM absences WHERE person_id = ? AND end_date >= ?', person.id, start)) {
    for (let d = a.start_date; d <= a.end_date; d = addDays(d, 1)) busy.add(d);
  }
  const days = {}; // jour -> [{step, hours}]
  let day = start, used = 0, guard = 0;
  const advance = () => { day = addDays(day, 1); used = 0; while (!isWorkday(day) || busy.has(day)) day = addDays(day, 1); };
  if (busy.has(day)) advance();
  const runs = [];
  for (const s of steps) {
    let left = stepHours(s, avg);
    if (used >= perDay) advance();
    const from = day;
    while (left > 0 && guard++ < 4000) {
      const take = Math.min(perDay - used, left);
      (days[day] = days[day] || []).push({ step: s, hours: take });
      used += take; left -= take;
      if (left > 0) advance();
    }
    const last = runs[runs.length - 1];
    if (last && last.project_id === s.project_id) { last.end = day; last.titles.push(s.title); last.sent = last.sent && !!s.sent; }
    else runs.push({ project_id: s.project_id, pname: s.pname, start: from, end: day, titles: [s.title], sent: !!s.sent });
  }
  return { days, runs, busy };
}

function autoPlan() {
  if (!on('auto_plan')) return { skipped: true };
  const avg = averages();
  const people = q.all('SELECT * FROM people WHERE active = 1');
  const created = [];
  tx(() => {
    q.run('DELETE FROM bars WHERE auto = 1');
    for (const p of people) {
      for (const r of allocate(p, { avg }).runs) {
        q.run("INSERT INTO bars (person_id, lane, project_id, label, detail, kind, start_date, end_date, auto) VALUES (?, 'person', ?, ?, ?, 'work', ?, ?, 1)",
          p.id, r.project_id, r.pname, r.titles.join(' · '), r.start, r.end);
        created.push(r);
      }
    }
  });
  setSetting('last_plan', new Date().toISOString());
  return { bars: created.length };
}

// Fin de fabrication estimée par projet (dernière barre automatique).
function projectedEnds() {
  return Object.fromEntries(q.all('SELECT project_id, MAX(end_date) e FROM bars WHERE auto = 1 GROUP BY project_id').map((r) => [r.project_id, r.e]));
}

// --- Alertes calculées (s'ajoutent à « À décider ») ---
const mailto = (to, subject, body) => `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
function alerts() {
  const out = [];
  const t = today();
  // Retard prévu : la fabrication finit après la livraison promise.
  const ends = projectedEnds();
  for (const p of q.all("SELECT * FROM projects WHERE status = 'en_cours' AND due_date IS NOT NULL")) {
    const e = ends[p.id];
    if (e && e >= p.due_date) out.push({ kind: 'ko', tag: 'Retard prévu', title: `${p.name} · fin de fabrication estimée le ${ddmm(e)}`, text: `Livraison promise le ${ddmm(p.due_date)}. Le planning automatique est calculé depuis les heures du carnet.`, href: '/planning', cta: 'Voir le planning' });
  }
  // Devis sans réponse qui expire bientôt.
  for (const x of q.all("SELECT * FROM quotes WHERE status = 'sent' AND valid_until BETWEEN ? AND ?", t, addDays(t, 3))) {
    out.push({ kind: 'wa', tag: 'Devis', title: `${x.signer_name} · ${x.number} sans réponse`, text: `Le lien expire le ${ddmm(x.valid_until)}.`, href: '/portails', cta: 'Voir',
      href2: mailto(x.signer_email, `Votre devis ${x.number}`, `Bonjour,\n\nJe me permets de revenir vers vous au sujet du devis ${x.number}, dont le lien de validation expire le ${ddmm(x.valid_until)}. Avez-vous des questions ou souhaitez-vous des ajustements ?\n\nBien cordialement,\nCarchon Les Ateliers`), cta2: 'Relancer par e-mail' });
  }
  // Commande fournisseur en retard.
  for (const o of q.all('SELECT orders.*, suppliers.name sname, suppliers.email semail, suppliers.phone sphone FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE arrived_at IS NULL AND expected_at < ?', t)) {
    out.push({ kind: 'wa', tag: 'Commande', title: `${o.sname || 'Fournisseur'} · en retard`, text: `${o.what} · attendue le ${ddmm(o.expected_at)}`, href: '/commandes', cta: 'Arrivé ?',
      href2: o.semail ? mailto(o.semail, 'Suivi de notre commande', `Bonjour,\n\nNous attendions le ${ddmm(o.expected_at)} notre commande : ${o.what}.\nPouvez-vous nous donner une nouvelle date de livraison ?\n\nMerci,\nCarchon Les Ateliers`) : o.sphone ? `tel:${o.sphone}` : '', cta2: o.semail ? 'Relancer' : 'Appeler' });
  }
  // Pose dans 3 jours ou moins, camion pas prêt.
  for (const tr of q.all('SELECT trips.*, projects.name pname FROM trips JOIN projects ON projects.id = trips.project_id WHERE done_at IS NULL AND date BETWEEN ? AND ?', t, addDays(t, 3))) {
    const items = JSON.parse(tr.items); const n = items.filter((i) => i.done).length;
    if (n < items.length) out.push({ kind: 'wa', tag: 'Pose', title: `${tr.pname} · ${longDate(tr.date)}`, text: `Camion : ${n} / ${items.length} prêts.`, href: '/poses', cta: 'Préparer' });
  }
  // Acompte qui traîne : relance prête à envoyer.
  for (const p of q.all("SELECT projects.*, clients.email cemail, clients.name cname FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.status = 'en_cours' AND deposit_needed = 1 AND deposit_at IS NULL AND COALESCE(deposit_asked_at, projects.created_at) <= datetime('now', '-7 days')")) {
    if (p.cemail) out.push({ kind: 'ko', tag: 'Relance', title: `${p.cname} · acompte attendu depuis plus d'une semaine`, text: p.name, href: `/projets/${p.id}#acompte`, cta: 'Ouvrir', act: `/projets/${p.id}/acompte`, actLabel: 'Reçu aujourd’hui',
      href2: mailto(p.cemail, `Acompte · ${p.name}`, `Bonjour,\n\nPour lancer la fabrication de votre projet « ${p.name} », nous attendons le règlement de l'acompte prévu au devis.\nSi c'est déjà fait, merci de ne pas tenir compte de ce message.\n\nBien cordialement,\nCarchon Les Ateliers`), cta2: 'Relancer par e-mail' });
  }
  // Stock fini sous le seuil boutique (pièces libres + en fabrication).
  for (const m of q.all(`SELECT models.*, (SELECT COUNT(*) FROM units WHERE model_id = models.id AND status = 'en_stock' AND reserved_for = '') free,
      (SELECT COUNT(*) FROM units u JOIN projects p ON p.id = u.project_id WHERE u.model_id = models.id AND u.status = 'a_faire' AND p.status = 'en_cours') coming
      FROM models WHERE active = 1 AND threshold > 0`)) {
    if (m.free + m.coming < m.threshold) out.push({ kind: 'wa', tag: 'Stock fini', title: `${m.name} : ${m.free} libre(s), seuil ${m.threshold}`, text: `${m.coming} en fabrication`, href: `/catalogue?m=${m.id}&qty=${Math.max(1, m.threshold * 2 - m.free - m.coming)}#lancer`, cta: 'Lancer un lot' });
  }
  out.push(...require('./machines').alerts());
  return out;
}

// --- Résumé du matin par e-mail ---
function digestText() {
  const { toDecide } = require('./logic');
  const t = today();
  const items = toDecide();
  const crew = q.all("SELECT people.name, bars.label, bars.detail FROM bars JOIN people ON people.id = bars.person_id WHERE bars.start_date <= ? AND bars.end_date >= ? ORDER BY people.id", t, t);
  const issues = q.all("SELECT issues.body, projects.name pname FROM issues LEFT JOIN projects ON projects.id = issues.project_id WHERE issues.status = 'open'");
  return [
    `Bonjour,\n\nVoici ta journée du ${longDate(t)}.`,
    `\nÀ DÉCIDER (${items.length})`, ...(items.length ? items.map((i) => `- [${i.tag}] ${i.title} — ${i.text}`) : ['- rien']),
    `\nL'ATELIER AUJOURD'HUI`, ...(crew.length ? crew.map((c) => `- ${c.name} : ${c.label}${c.detail ? ` (${c.detail})` : ''}`) : ['- rien de planifié']),
    ...(issues.length ? ['\nPROBLÈMES SIGNALÉS', ...issues.map((i) => `- ${i.pname || ''} : ${i.body}`)] : []),
    `\nOuvrir Carchon OS : ${process.env.PUBLIC_URL || ''}/`,
  ].join('\n');
}
async function sendDigest() {
  const to = setting('patron_email');
  if (!to) return { skipped: 'pas d’adresse' };
  return mail.send({ to, subject: `Carchon OS · ta journée du ${ddmm(today())}`, text: digestText() });
}

// --- Rappel au client deux jours avant la livraison / pose ---
async function poseReminders() {
  if (!on('auto_reminder_pose', '0') || !mail.configured()) return 0;
  let n = 0;
  const rows = q.all(`SELECT trips.*, projects.name pname, clients.email cemail, clients.name cname FROM trips JOIN projects ON projects.id = trips.project_id
    JOIN clients ON clients.id = projects.client_id WHERE trips.date = ? AND trips.reminder_sent_at IS NULL AND trips.done_at IS NULL`, addDays(today(), 2));
  for (const r of rows) {
    if (!r.cemail) continue;
    await mail.send({ to: r.cemail, subject: `Votre livraison du ${longDate(r.date)}`, text: `Bonjour,\n\nNous vous rappelons notre venue le ${longDate(r.date)} pour : ${r.what || 'la livraison de votre projet'} (« ${r.pname} »).\nMerci de prévoir un accès dégagé. En cas d'empêchement, répondez simplement à ce message.\n\nÀ bientôt,\nL'équipe Carchon` });
    q.run("UPDATE trips SET reminder_sent_at = datetime('now') WHERE id = ?", r.id);
    n++;
  }
  return n;
}

// --- Boucle ---
async function tick() {
  try {
    const t = today();
    if (setting('last_plan_day') !== t) { autoPlan(); setSetting('last_plan_day', t); }
    try { require('./backup').daily(); } catch (e) { console.error('[sauvegarde]', e); }
    if (on('digest_email') && mail.configured() && new Date().getHours() >= 7 && setting('last_digest') !== t) {
      await sendDigest(); setSetting('last_digest', t);
    }
    await poseReminders();
  } catch (e) { console.error('[automatisations]', e); }
}
let timer = null;
function start() {
  if (timer) return;
  setTimeout(tick, 5000);
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
}
// Après un changement (carnet envoyé, fiche finie…) : on replanifie tout de suite.
function changed() { try { autoPlan(); } catch (e) { console.error('[planning auto]', e); } }

module.exports = { allocate, isWorkday, averages, stepHours, autoPlan, projectedEnds, alerts, digestText, sendDigest, poseReminders, tick, start, changed, mailto };
