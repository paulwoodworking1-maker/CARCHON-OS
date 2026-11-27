'use strict';
// Analyse : tous les chiffres de la base, comparés aux objectifs de la stratégie 2027,
// et un diagnostic classé (ce qui freine, ce qui marche, les pistes).
const { q, setting, FAMILIES, CORE_FAMILIES, SOURCES } = require('./db');
const { today, addDays, parseDate, iso } = require('./html');

// --- Objectifs (modifiables sur la page) ---
const OBJECTIVES = [
  ['obj_rate', 'Taux horaire réel minimum (€ HT / h)', 78],
  ['obj_ca_month', 'Chiffre d’affaires signé par mois (€ HT)', 50000],
  ['obj_sign', 'Signature sur devis envoyés (%)', 40],
  ['obj_gap', 'Écart heures prévues / réelles maximum (%)', 10],
  ['obj_load', 'Charge planifiée maximum (%)', 85],
  ['obj_backlog_min', 'Carnet de commandes minimum (mois)', 3],
  ['obj_backlog_max', 'Carnet de commandes maximum (mois)', 4],
  ['obj_network', 'Affaires via prescripteurs et clients livrés (%)', 50],
  ['obj_min_order', 'Commande minimum (€ HT)', 1500],
  ['obj_posts_month', 'Photos publiables par mois', 12],
];
const objectives = () => Object.fromEntries(OBJECTIVES.map(([k, , d]) => [k.replace('obj_', ''), Number(String(setting(k, '') || d).replace(',', '.')) || d]));

const PERIODS = [['90', '3 mois'], ['182', '6 mois'], ['365', '12 mois'], ['0', 'Depuis le début']];
const NETWORK = SOURCES.slice(0, 2);

const days = (a, b) => (a && b ? (parseDate(String(b).slice(0, 10)) - parseDate(String(a).slice(0, 10))) / 864e5 : null);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rate = () => Number(String(setting('hourly_rate', '0')).replace(',', '.')) || 0;
const monthKey = (s) => String(s || '').slice(0, 7);

function compute(periodDays = 365) {
  const O = objectives();
  const t = today();
  const since = periodDays ? addDays(t, -periodDays) : '1970-01-01';
  const inP = (d) => d && String(d).slice(0, 10) >= since;
  const R = { O, since, periodDays, today: t };

  // ---------- Affaires (projets avec client ou montant) ----------
  const projects = q.all(`SELECT p.*, c.name cname,
      (SELECT COALESCE(SUM(declared_hours), 0) FROM steps WHERE project_id = p.id) hd,
      (SELECT COALESCE(SUM(est_hours), 0) FROM steps WHERE project_id = p.id) he,
      (SELECT COALESCE(SUM(est_hours), 0) FROM steps WHERE project_id = p.id AND status != 'done') hleft,
      (SELECT accepted_at FROM quotes WHERE project_id = p.id AND status = 'accepted' ORDER BY id DESC LIMIT 1) qacc,
      (SELECT MAX(done_at) FROM steps WHERE project_id = p.id) lastdone
    FROM projects p LEFT JOIN clients c ON c.id = p.client_id`);
  for (const p of projects) {
    p.signed_at = (p.qacc || p.deposit_at || p.created_at || '').slice(0, 10);
    p.isClient = !!p.client_id || p.amount_ht > 0;
  }
  const clientProjects = projects.filter((p) => p.isClient && p.canal !== 'SAV');
  R.projects = projects;

  // ---------- 1. Ventes et devis ----------
  const quotesAll = q.all('SELECT * FROM quotes ORDER BY number, version');
  const real = quotesAll.filter((x) => !x.test);
  const qs = real.length ? real : quotesAll;
  R.quotesTestOnly = !real.length && quotesAll.length > 0;
  const byNumber = {};
  for (const x of qs) (byNumber[x.number] = byNumber[x.number] || []).push(x);
  const dossiers = Object.values(byNumber).map((vs) => {
    const last = vs[vs.length - 1];
    const status = last.status === 'sent' && last.valid_until < t ? 'expired' : last.status;
    return { number: last.number, first: vs[0], last, versions: vs.length, status, opened: vs.some((v) => v.opened_at), pdf: vs.some((v) => v.pdf_opened_at), code: vs.some((v) => v.code_sent_at),
      amount: last.amount_ht ?? vs.find((v) => v.amount_ht)?.amount_ht ?? null, source: last.source || '', family: last.family || '',
      sentAt: (vs[0].link_at || vs[0].created_at || '').slice(0, 10), decidedAt: last.accepted_at || last.responded_at || null, reason: (() => { try { return JSON.parse(last.response_json || '{}').reason || ''; } catch { return ''; } })() };
  }).filter((d) => inP(d.sentAt));
  const accepted = dossiers.filter((d) => d.status === 'accepted');
  const decided = accepted.length + dossiers.filter((d) => d.status === 'refused' || d.status === 'expired').length;
  R.sales = {
    n: dossiers.length, accepted: accepted.length, refused: dossiers.filter((d) => d.status === 'refused').length, expired: dossiers.filter((d) => d.status === 'expired').length,
    pending: dossiers.filter((d) => d.status === 'sent' || d.status === 'modif').length, modif: dossiers.filter((d) => d.versions > 1 || d.status === 'modif').length,
    funnel: [['Devis envoyés', dossiers.length], ['Lien ouvert', dossiers.filter((d) => d.opened).length], ['PDF consulté', dossiers.filter((d) => d.pdf).length], ['Code de signature demandé', dossiers.filter((d) => d.code).length], ['Signés', accepted.length]],
    signRate: decided ? accepted.length / decided : null,
    signRateAll: dossiers.length ? accepted.length / dossiers.length : null,
    decisionDays: median(accepted.map((d) => days(d.sentAt, d.decidedAt)).filter((x) => x !== null)),
    versionsSigned: avg(accepted.map((d) => d.versions)),
    reasons: Object.entries(dossiers.filter((d) => d.status === 'refused').reduce((a, d) => { const k = d.reason || 'Sans motif'; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
    unopened: dossiers.filter((d) => d.status === 'sent' && !d.opened && days(d.sentAt, t) >= 3),
    lostAmount: sum(dossiers.filter((d) => d.status === 'refused' || d.status === 'expired'), (d) => d.amount),
    pendingAmount: sum(dossiers.filter((d) => d.status === 'sent' || d.status === 'modif'), (d) => d.amount),
    withAmount: dossiers.filter((d) => d.amount).length,
  };

  // ---------- 2. Chiffre d'affaires signé ----------
  const months = [];
  { const d = parseDate(t); d.setDate(1); for (let i = 11; i >= 0; i--) { const x = new Date(d); x.setMonth(x.getMonth() - i); months.push(iso(x).slice(0, 7)); } }
  const signedP = clientProjects.filter((p) => p.amount_ht > 0);
  R.ca = {
    months: months.map((m) => ({ m, v: sum(signedP.filter((p) => monthKey(p.signed_at) === m), (p) => p.amount_ht), n: signedP.filter((p) => monthKey(p.signed_at) === m).length })),
    period: sum(signedP.filter((p) => inP(p.signed_at)), (p) => p.amount_ht),
    nPeriod: signedP.filter((p) => inP(p.signed_at)).length,
    backlogEur: sum(clientProjects.filter((p) => p.status === 'en_cours'), (p) => p.amount_ht),
    missingAmount: clientProjects.filter((p) => !(p.amount_ht > 0) && (p.status === 'en_cours' || inP(p.finished_at))).length,
  };
  const last3 = R.ca.months.slice(-3);
  R.ca.avg3 = sum(last3, (x) => x.v) / 3;
  R.ca.basket = R.ca.nPeriod ? R.ca.period / R.ca.nPeriod : null;
  R.ca.small = signedP.filter((p) => inP(p.signed_at) && p.amount_ht < O.min_order);

  // ---------- 3. Rentabilité (affaires terminées avec montant et heures) ----------
  const finished = clientProjects.filter((p) => p.status === 'termine' && inP(p.finished_at || p.lastdone));
  const priced = finished.filter((p) => p.amount_ht > 0 && p.hd > 0).map((p) => ({ ...p, net: p.amount_ht - (p.material_ht || 0), rate: (p.amount_ht - (p.material_ht || 0)) / p.hd, matShare: p.material_ht ? p.material_ht / p.amount_ht : null }));
  const groupRate = (key, list) => Object.entries(list.reduce((a, p) => { const k = p[key] || 'Non renseigné'; (a[k] = a[k] || []).push(p); return a; }, {}))
    .map(([k, ps]) => ({ k, n: ps.length, ca: sum(ps, (p) => p.amount_ht), h: sum(ps, (p) => p.hd), rate: sum(ps, (p) => p.net) / (sum(ps, (p) => p.hd) || 1) })).sort((a, b) => b.rate - a.rate);
  R.profit = {
    list: priced.sort((a, b) => a.rate - b.rate),
    rate: priced.length ? sum(priced, (p) => p.net) / sum(priced, (p) => p.hd) : null,
    below: priced.filter((p) => p.rate < O.rate),
    shortfall: sum(priced.filter((p) => p.rate < O.rate), (p) => (O.rate - p.rate) * p.hd),
    byFamily: groupRate('family', priced), byCanal: groupRate('canal', priced), bySource: groupRate('source', priced),
    unpriced: finished.filter((p) => !(p.amount_ht > 0) || !(p.hd > 0)).length,
    noMaterial: priced.filter((p) => !p.material_ht).length,
    labourRate: rate(),
  };

  // ---------- 4. Chiffrage : prévu contre réel ----------
  const doneSteps = q.all(`SELECT s.*, p.name pname, p.ref pref FROM steps s JOIN projects p ON p.id = s.project_id WHERE s.status = 'done' AND COALESCE(s.done_at, '') >= ?`, since);
  const measured = doneSteps.filter((s) => s.est_hours > 0 && s.declared_hours > 0);
  const byGeste = Object.entries(measured.reduce((a, s) => { const k = s.geste || 'Autre'; (a[k] = a[k] || []).push(s); return a; }, {}))
    .map(([g, ss]) => { const e = sum(ss, (s) => s.est_hours), d = sum(ss, (s) => s.declared_hours); return { g, n: ss.length, e, d, gap: (d - e) / e, extra: d - e }; })
    .sort((a, b) => b.extra - a.extra);
  const added = doneSteps.filter((s) => s.added_by_atelier);
  const tE = sum(measured, (s) => s.est_hours), tD = sum(measured, (s) => s.declared_hours);
  R.estim = {
    gap: tE ? (tD - tE) / tE : null, est: tE, decl: tD, n: measured.length, byGeste,
    over: sum(measured, (s) => Math.max(0, s.declared_hours - s.est_hours)),
    noDeclared: doneSteps.filter((s) => s.declared_hours == null).length, doneN: doneSteps.length,
    noGeste: doneSteps.filter((s) => !s.geste).length,
    added: added.length, addedH: sum(added, (s) => s.declared_hours),
    worstProjects: Object.values(measured.reduce((a, s) => { const k = s.project_id; a[k] = a[k] || { name: s.pname, ref: s.pref, id: k, e: 0, d: 0 }; a[k].e += s.est_hours; a[k].d += s.declared_hours; return a; }, {}))
      .map((x) => ({ ...x, gap: (x.d - x.e) / x.e })).filter((x) => x.e >= 4).sort((a, b) => b.gap - a.gap).slice(0, 5),
  };

  // ---------- 5. Délais ----------
  const delivered = clientProjects.filter((p) => p.status === 'termine' && p.finished_at && inP(p.finished_at));
  const withDue = delivered.filter((p) => p.due_date);
  const late = withDue.filter((p) => p.finished_at.slice(0, 10) > p.due_date);
  const depositWait = clientProjects.filter((p) => p.deposit_at && p.deposit_needed && inP(p.deposit_at)).map((p) => days(p.deposit_asked_at || p.created_at, p.deposit_at)).filter((x) => x !== null && x >= 0);
  const waiting = clientProjects.filter((p) => p.status === 'en_cours' && p.deposit_needed && !p.deposit_at && p.client_id);
  const ends = require('./automations').projectedEnds();
  const projectedLate = projects.filter((p) => p.status === 'en_cours' && p.due_date && ends[p.id] && ends[p.id] >= p.due_date);
  R.delays = {
    delivered: delivered.length, onTime: withDue.length ? (withDue.length - late.length) / withDue.length : null, late, lateDays: avg(late.map((p) => days(p.due_date, p.finished_at))),
    leadTime: median(delivered.map((p) => days(p.signed_at || p.created_at, p.finished_at)).filter((x) => x !== null && x >= 0)),
    depositDays: median(depositWait), waiting: waiting.map((p) => ({ ...p, since: days(p.deposit_asked_at || p.created_at, t) })).sort((a, b) => b.since - a.since),
    waitingEur: sum(waiting, (p) => p.amount_ht), projectedLate,
    noDue: projects.filter((p) => p.status === 'en_cours' && !p.due_date).length,
  };

  // ---------- 6. Capacité et équipe ----------
  const charge = require('./routes/charge').compute();
  const four = [0, 1, 2, 3].reduce((a, i) => { for (const x of charge.rows) { a.h += x.cells[i].hrs; a.c += x.cells[i].cap; } return a; }, { h: 0, c: 0 });
  const twelve = charge.weeks.map((w, i) => ({ w, h: sum(charge.rows, (x) => x.cells[i].hrs), c: sum(charge.rows, (x) => x.cells[i].cap) }));
  const people = q.all('SELECT * FROM people WHERE active = 1 ORDER BY role = \'patron\' DESC, id');
  const capMonth = sum(people, (p) => p.hours_week || 35) * 52 / 12 * (O.load / 100);
  const left = q.all(`SELECT s.who_id, COALESCE(SUM(CASE WHEN s.est_hours > 0 THEN s.est_hours ELSE 4 END), 0) h FROM steps s JOIN projects p ON p.id = s.project_id
    WHERE s.status != 'done' AND p.status = 'en_cours' GROUP BY s.who_id`);
  const leftTotal = sum(left, (x) => x.h);
  const patron = people.find((p) => p.role === 'patron');
  const perPerson = people.map((p) => {
    const st = q.get("SELECT COUNT(*) n, COALESCE(SUM(declared_hours), 0) h, COALESCE(SUM(est_hours), 0) e FROM steps WHERE who_id = ? AND status = 'done' AND COALESCE(done_at, '') >= ?", p.id, since);
    const iss = q.get('SELECT COUNT(*) n FROM issues WHERE person_id = ? AND created_at >= ?', p.id, since).n;
    const row = charge.rows.find((x) => x.p.id === p.id);
    const l4 = row ? [0, 1, 2, 3].reduce((a, i) => ({ h: a.h + row.cells[i].hrs, c: a.c + row.cells[i].cap }), { h: 0, c: 0 }) : { h: 0, c: 0 };
    return { p, done: st.n, h: st.h, e: st.e, issues: iss, load4: l4.c ? l4.h / l4.c : null, left: left.find((x) => x.who_id === p.id)?.h || 0 };
  });
  R.capacity = {
    load4: four.c ? four.h / four.c : null, h4: four.h, c4: four.c, twelve, capMonth, leftTotal,
    backlogMonths: capMonth ? leftTotal / capMonth : null,
    patronShare: leftTotal && patron ? (left.find((x) => x.who_id === patron.id)?.h || 0) / leftTotal : null,
    unassigned: left.find((x) => x.who_id === null)?.h || 0,
    perPerson, overWeeks: charge.rows.flatMap((x) => x.cells.slice(0, 6).filter((c) => c.pct > 100).map((c) => ({ p: x.p, c }))),
    teamSize: people.length,
  };

  // ---------- 7. Qualité et SAV ----------
  const issues = q.all(`SELECT i.*, s.geste FROM issues i LEFT JOIN steps s ON s.id = i.step_id WHERE i.created_at >= ?`, since);
  const sav = q.all('SELECT * FROM sav WHERE created_at >= ?', since);
  const unitsOut = q.get("SELECT COUNT(*) n FROM units WHERE status IN ('livree', 'expediee')").n;
  const trips = q.all('SELECT * FROM trips WHERE pv_signed_at IS NOT NULL AND pv_signed_at >= ?', since);
  R.quality = {
    issues: issues.length, openIssues: q.get("SELECT COUNT(*) n FROM issues WHERE status = 'open'").n,
    issuesPerProject: (() => { const n = new Set(issues.map((i) => i.project_id)).size; return n ? issues.length / n : null; })(),
    issuesByGeste: Object.entries(issues.reduce((a, i) => { const k = i.geste || 'Sans fiche'; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
    sav: sav.length, savOpen: q.get("SELECT COUNT(*) n FROM sav WHERE status != 'close'").n, savHours: sum(sav, (s) => s.hours),
    savRate: unitsOut ? q.get('SELECT COUNT(*) n FROM sav').n / unitsOut : null, unitsOut,
    savClose: median(sav.filter((s) => s.closed_at).map((s) => days(s.created_at, s.closed_at))),
    pv: trips.length, pvReserves: trips.filter((x) => x.pv_reserves).length,
  };

  // ---------- 8. Achats et matière ----------
  const orders = q.all('SELECT o.*, s.name sname FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE COALESCE(o.ordered_at, \'\') >= ?', since);
  const arrived = orders.filter((o) => o.arrived_at && o.expected_at);
  const lateO = arrived.filter((o) => o.arrived_at.slice(0, 10) > o.expected_at);
  const bySup = Object.values(orders.reduce((a, o) => { const k = o.sname || 'Sans fournisseur'; a[k] = a[k] || { k, n: 0, late: 0, delay: [] }; a[k].n++;
    if (o.arrived_at && o.expected_at) { const dd = days(o.expected_at, o.arrived_at); if (dd > 0) a[k].late++; a[k].delay.push(dd); }
    else if (!o.arrived_at && o.expected_at && o.expected_at < t) a[k].late++; return a; }, {})).map((x) => ({ ...x, avgDelay: avg(x.delay) })).sort((a, b) => b.late - a.late);
  R.supply = {
    orders: orders.length, lateRate: arrived.length ? lateO.length / arrived.length : null,
    openLate: q.all('SELECT o.*, s.name sname FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE arrived_at IS NULL AND expected_at < ?', t),
    bySup, blocked: q.get("SELECT COUNT(*) n FROM needs WHERE status = 'todo' AND needs_deposit = 1 AND force = 0").n,
    needsTodo: q.get("SELECT COUNT(*) n FROM needs WHERE status = 'todo'").n,
    needsOld: q.get("SELECT COUNT(*) n FROM needs WHERE status = 'todo' AND created_at <= datetime('now', '-7 days')").n,
    empty: q.all('SELECT name FROM stock_items WHERE state = 2').map((x) => x.name),
    materialShare: (() => { const ps = priced.filter((p) => p.material_ht); return ps.length ? sum(ps, (p) => p.material_ht) / sum(ps, (p) => p.amount_ht) : null; })(),
  };

  // ---------- 9. Machines ----------
  const M = require('./machines').all();
  const ev = q.all('SELECT e.*, m.name mname FROM machine_events e JOIN machines m ON m.id = e.machine_id WHERE e.date >= ?', since);
  R.machines = {
    n: M.length, down: M.filter((m) => m.down_since), late: M.flatMap((m) => m.tasks.filter((x) => x.st.late).map((x) => ({ m, t: x }))),
    pannes: ev.filter((e) => e.kind === 'panne').length, daysDown: sum(ev.filter((e) => e.kind === 'panne'), (e) => e.days_down),
    worst: Object.entries(ev.filter((e) => e.kind === 'panne').reduce((a, e) => { a[e.mname] = (a[e.mname] || 0) + (e.days_down || 0); return a; }, {})).sort((a, b) => b[1] - a[1]),
    entretiens: ev.filter((e) => e.kind !== 'panne').length,
  };

  // ---------- 10. Acquisition, image, relation client ----------
  const withSource = clientProjects.filter((p) => inP(p.signed_at) && p.source);
  const bySource = Object.entries(clientProjects.filter((p) => inP(p.signed_at)).reduce((a, p) => { const k = p.source || 'Non renseigné'; a[k] = a[k] || { n: 0, ca: 0 }; a[k].n++; a[k].ca += p.amount_ht || 0; return a; }, {}))
    .map(([k, v]) => ({ k, ...v })).sort((a, b) => b.ca - a.ca || b.n - a.n);
  const byFamily = Object.entries(clientProjects.filter((p) => inP(p.signed_at)).reduce((a, p) => { const k = p.family || 'Non renseigné'; a[k] = a[k] || { n: 0, ca: 0 }; a[k].n++; a[k].ca += p.amount_ht || 0; return a; }, {}))
    .map(([k, v]) => ({ k, ...v })).sort((a, b) => b.ca - a.ca || b.n - a.n);
  const famKnown = clientProjects.filter((p) => inP(p.signed_at) && p.family);
  const photos30 = q.get("SELECT COUNT(*) n FROM photos WHERE publishable = 1 AND created_at >= datetime('now', '-30 days')").n;
  const clients = q.all('SELECT c.id, COUNT(p.id) n FROM clients c JOIN projects p ON p.client_id = c.id GROUP BY c.id');
  const openPortals = clientProjects.filter((p) => p.status === 'en_cours' && p.client_id);
  R.market = {
    bySource, byFamily, sourceKnown: withSource.length,
    network: withSource.length ? withSource.filter((p) => NETWORK.includes(p.source)).length / withSource.length : null,
    core: famKnown.length ? famKnown.filter((p) => CORE_FAMILIES.includes(p.family)).length / famKnown.length : null,
    coreCa: (() => { const ca = sum(famKnown, (p) => p.amount_ht); return ca ? sum(famKnown.filter((p) => CORE_FAMILIES.includes(p.family)), (p) => p.amount_ht) / ca : null; })(),
    photos30, photosTotal: q.get('SELECT COUNT(*) n FROM photos WHERE publishable = 1').n,
    repeat: clients.length ? clients.filter((c) => c.n > 1).length / clients.length : null, clients: clients.length,
    portalOpen: openPortals.length ? openPortals.filter((p) => p.portal_state === 'open').length / openPortals.length : null,
    portalSeen: openPortals.filter((p) => p.portal_state === 'open' && p.portal_views > 0).length, openPortals: openPortals.length,
    sharedPhotos: q.get("SELECT COUNT(*) n FROM photos WHERE shared_client = 1 AND created_at >= ?", since).n,
    canal: Object.entries(projects.filter((p) => inP(p.created_at)).reduce((a, p) => { a[p.canal] = (a[p.canal] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
  };

  // ---------- 11. Qualité des données ----------
  const active = clientProjects.filter((p) => p.status === 'en_cours' || inP(p.finished_at));
  R.data = [
    ['Affaires sans montant HT', active.filter((p) => !(p.amount_ht > 0)).length, active.length, 'Sans montant, pas de taux horaire réel ni de CA.', '/projets'],
    ['Affaires sans famille', active.filter((p) => !p.family).length, active.length, 'Impossible de savoir quelle famille rapporte.', '/projets'],
    ['Affaires sans origine', active.filter((p) => !p.source).length, active.length, 'Impossible de savoir quel canal amène les bons clients.', '/projets'],
    ['Terminées sans coût matière', finished.filter((p) => !p.material_ht).length, finished.length, 'Le taux horaire est surestimé sans la matière.', '/projets?vue=termines'],
    ['Fiches finies sans heures déclarées', R.estim.noDeclared, R.estim.doneN, 'Chaque fiche sans « Ça t’a pris combien ? » fausse le chiffrage.', '/pilotage'],
    ['Fiches finies sans geste', R.estim.noGeste, R.estim.doneN, 'Sans geste, l’écart ne se rattache à rien.', '/carnets'],
    ['OF en cours sans échéance', R.delays.noDue, projects.filter((p) => p.status === 'en_cours').length, 'Sans date, pas d’alerte de retard.', '/projets'],
  ];
  R.hourlyRateMissing = !rate();

  R.findings = diagnose(R);
  return R;
}

// ---------- Diagnostic : ce qui freine, ce qui marche, les pistes ----------
const eur = (x) => `${Math.round(x).toLocaleString('fr-FR')} €`;
const pc = (x) => `${Math.round(x * 100)} %`;
const hr = (x) => `${Math.round(x).toLocaleString('fr-FR')} h`;

function diagnose(R) {
  const O = R.O; const F = [];
  const add = (level, area, title, text, action, href, weight = 1) => F.push({ level, area, title, text, action, href, weight });

  // Rentabilité
  if (R.profit.rate !== null) {
    if (R.profit.rate < O.rate) add('ko', 'Rentabilité', `Taux horaire réel : ${eur(R.profit.rate)} / h, sous ton objectif de ${eur(O.rate)}`,
      `Sur ${R.profit.list.length} affaire(s) terminée(s), ${R.profit.below.length} ne paient pas le temps passé. Manque à gagner : ${eur(R.profit.shortfall)} sur la période.`,
      'Recalcule tes prix avec les heures réelles (page Heures et chiffrage) et augmente les familles sous l’objectif.', '/pilotage/couts', 10);
    else add('ok', 'Rentabilité', `Taux horaire réel : ${eur(R.profit.rate)} / h`, `Au-dessus de l’objectif de ${eur(O.rate)} sur ${R.profit.list.length} affaire(s) terminée(s).`, 'Garde la même méthode de chiffrage ; vérifie qu’elle tient sur les grosses affaires.', '/pilotage/couts', 3);
    const fams = R.profit.byFamily.filter((f) => f.k !== 'Non renseigné' && f.n >= 1);
    if (fams.length >= 2) {
      const best = fams[0], worst = fams[fams.length - 1];
      if (best.rate - worst.rate > 15) add('idea', 'Positionnement', `« ${best.k} » rapporte ${eur(best.rate - worst.rate)} de plus par heure que « ${worst.k} »`,
        `${eur(best.rate)} / h contre ${eur(worst.rate)} / h. Chaque heure basculée de l’une vers l’autre vaut ce différentiel.`, `Montre davantage « ${best.k} » (site, Instagram, prescripteurs) et remonte le prix de « ${worst.k} » ou refuse-la plus souvent.`, '#rentabilite', 7);
    }
    const srcs = R.profit.bySource.filter((f) => f.k !== 'Non renseigné');
    if (srcs.length >= 2 && srcs[0].rate - srcs[srcs.length - 1].rate > 15) add('idea', 'Acquisition', `Les clients venus par « ${srcs[0].k} » sont les plus rentables`,
      `${eur(srcs[0].rate)} / h, contre ${eur(srcs[srcs.length - 1].rate)} / h pour « ${srcs[srcs.length - 1].k} ».`, 'Mets ton temps commercial là où les clients paient le mieux l’heure.', '#marche', 6);
  } else add('wa', 'Rentabilité', 'Ton taux horaire réel n’est pas encore mesurable',
    'Il faut des affaires terminées avec un montant HT et des heures déclarées. C’est l’indicateur n° 1 de ta stratégie.', 'Renseigne le montant HT (et la matière) dans chaque fiche projet, ou fais-le envoyer par Cockpit.', '/projets?vue=termines', 9);
  if (R.ca.small.length) add('wa', 'Positionnement', `${R.ca.small.length} affaire(s) sous ta commande minimum de ${eur(O.min_order)}`,
    'Le temps de devis, de préparation et de livraison est le même que pour une grosse pièce.', 'Oriente ces demandes vers un confrère ou regroupe-les avec une commande plus grosse.', '#marche', 4);

  // Chiffre d'affaires
  if (R.ca.avg3 > 0 || R.ca.period > 0) {
    const ratio = R.ca.avg3 / O.ca_month;
    if (ratio < 0.8) add('ko', 'Chiffre d’affaires', `${eur(R.ca.avg3)} signés par mois en moyenne (3 derniers mois) : ${pc(ratio)} de l’objectif`,
      `Il manque ${eur(O.ca_month - R.ca.avg3)} par mois pour atteindre ${eur(O.ca_month)}.${R.ca.basket ? ` Au panier moyen actuel (${eur(R.ca.basket)}), cela représente ${Math.ceil((O.ca_month - R.ca.avg3) / R.ca.basket)} affaire(s) de plus par mois.` : ''}`,
      R.ca.basket && R.ca.basket < 8000 ? 'Le levier le plus court : monter le panier moyen (agencements, pièces signature) plutôt que multiplier les petites affaires.' : 'Augmente le nombre de devis qualifiés : prescripteurs et clients livrés d’abord.', '#ca', 9);
    else add('ok', 'Chiffre d’affaires', `${eur(R.ca.avg3)} signés par mois en moyenne`, `${pc(ratio)} de l’objectif de ${eur(O.ca_month)}.`, 'Vérifie que l’atelier suit : carnet et charge ci-dessous.', '#ca', 3);
    // Capacité à produire l'objectif
    if (R.profit.rate && R.capacity.capMonth) {
      const needH = O.ca_month * (1 - (R.supply.materialShare ?? 0.3)) / Math.max(R.profit.rate, O.rate);
      if (needH > R.capacity.capMonth * 1.05) add('idea', 'Équipe', `Ton objectif de ${eur(O.ca_month)} / mois demande environ ${hr(needH)} d’atelier par mois`,
        `Ton équipe actuelle en fournit ${hr(R.capacity.capMonth)} (à ${O.load} % de charge). Il manque ${hr(needH - R.capacity.capMonth)}, soit ${Math.ceil((needH - R.capacity.capMonth) / (35 * 52 / 12 * O.load / 100))} personne(s) à temps plein, ou des prix plus hauts.`,
        'Décide maintenant : recruter, sous-traiter le répétitif, ou relever le taux horaire. Les trois se chiffrent ici.', '#capacite', 7);
    }
  } else add('wa', 'Chiffre d’affaires', 'Aucun chiffre d’affaires mesurable sur la période', 'Les montants des devis et des affaires ne sont pas encore saisis.', 'Indique le montant HT à l’envoi des devis et dans les fiches projet.', '/portails/envoyer', 8);

  // Ventes
  const S = R.sales;
  if (S.n >= 3 && S.signRate !== null) {
    if (S.signRate * 100 < O.sign) add('ko', 'Ventes', `Signature : ${pc(S.signRate)} des devis tranchés, objectif ${O.sign} %`,
      `${S.accepted} signé(s), ${S.refused} refusé(s), ${S.expired} expiré(s) sans réponse.${S.lostAmount ? ` ${eur(S.lostAmount)} perdus.` : ''}${S.reasons[0] ? ` Premier motif de refus : « ${S.reasons[0][0]} ».` : ''}`,
      S.expired > S.refused ? 'Tes devis meurent surtout sans réponse : relance à J+7 et J+21 (bouton « Relancer » dans Portails).' : 'Trie davantage avant de chiffrer (grille sur 15) : moins de devis, mais pour les bons clients.', '/portails', 8);
    else add('ok', 'Ventes', `Signature : ${pc(S.signRate)} des devis tranchés`, `Au-dessus de l’objectif de ${O.sign} %.`, S.signRate > 0.7 ? 'Plus de 70 % de signatures : tes prix sont probablement trop bas. Teste +10 % sur les prochains devis.' : 'Continue le tri avant chiffrage.', '/portails', S.signRate > 0.7 ? 6 : 2);
    const f = S.funnel; const opened = f[1][1], pdf = f[2][1];
    if (f[0][1] && opened / f[0][1] < 0.8) add('wa', 'Ventes', `${f[0][1] - opened} devis jamais ouverts par le client`, 'Le lien n’arrive pas ou n’intéresse pas : e-mail en indésirables, mauvaise adresse, ou client déjà parti ailleurs.', 'Envoie le lien aussi par SMS et appelle le client 48 h après l’envoi.', '/portails', 5);
    if (opened && pdf / opened < 0.7) add('idea', 'Ventes', 'Des clients ouvrent leur espace mais ne lisent pas le devis', `${opened - pdf} sur ${opened}.`, 'Mets un résumé clair (pièce, prix, délai) en haut du message et du portail : le PDF détaillé vient ensuite.', '/portails', 3);
    if (S.decisionDays > 14) add('idea', 'Ventes', `Un client met ${Math.round(S.decisionDays)} jours à signer (médiane)`, 'Plus la décision traîne, plus le risque d’abandon monte.', 'Limite la validité à 15 jours et propose un créneau de fabrication réservé jusqu’à la date.', '/portails', 3);
    if (S.reasons.find(([k]) => k === 'Le prix') && S.reasons.find(([k]) => k === 'Le prix')[1] >= 2) add('idea', 'Ventes', `${S.reasons.find(([k]) => k === 'Le prix')[1]} refus pour le prix`, 'Ce n’est pas forcément trop cher : souvent le mauvais client ou la valeur mal montrée.', 'Donne une fourchette dès le premier contact pour écarter les budgets trop courts avant de chiffrer.', '/portails', 4);
  } else if (S.n < 3) add('wa', 'Ventes', 'Trop peu de devis passés par le portail pour mesurer la signature', `${S.n} sur la période${R.quotesTestOnly ? ' (le portail est encore en mode test)' : ''}.`, 'Envoie tous tes devis par le portail : chaque ouverture, lecture et décision devient mesurable.', '/portails/envoyer', 5);
  if (S.unopened.length) add('wa', 'Ventes', `${S.unopened.length} devis envoyé(s) il y a plus de 3 jours, pas encore ouvert(s)`, S.unopened.slice(0, 3).map((d) => d.last.signer_name).join(', '), 'Appelle ces clients aujourd’hui.', '/portails', 6);

  // Chiffrage
  const E = R.estim;
  if (E.gap !== null && E.n >= 3) {
    if (Math.abs(E.gap) * 100 > O.gap) add(E.gap > 0 ? 'ko' : 'wa', 'Chiffrage', E.gap > 0 ? `Tes heures réelles dépassent le prévu de ${pc(E.gap)}` : `Tes heures réelles sont ${pc(-E.gap)} sous le prévu`,
      E.gap > 0 ? `${hr(E.over)} de plus que chiffré sur ${E.n} fiches, soit ${eur(E.over * O.rate)} non facturés au taux objectif.${E.byGeste[0] && E.byGeste[0].extra > 0 ? ` Le geste qui dérape le plus : « ${E.byGeste[0].g} » (+${pc(E.byGeste[0].gap)}).` : ''}` : 'Tu chiffres large : tes devis sont peut-être plus chers que nécessaire.',
      E.gap > 0 ? `Corrige ta base de chiffrage : ajoute ${pc(E.gap)} sur ${E.byGeste[0] ? `« ${E.byGeste[0].g} »` : 'les gestes concernés'}, ou revois la méthode de ce geste à l’atelier.` : 'Resserre ton chiffrage pour gagner des signatures.', '/pilotage', E.gap > 0 ? 8 : 4);
    else add('ok', 'Chiffrage', `Chiffrage juste : écart de ${pc(E.gap)}`, `Sous ton seuil de ${O.gap} % sur ${E.n} fiches.`, 'Tu peux t’appuyer sur tes moyennes pour chiffrer plus vite.', '/pilotage', 2);
  }
  if (E.added >= 2) add('idea', 'Chiffrage', `${E.added} tâches ajoutées par l’atelier en cours de route`, `${hr(E.addedH)} qui n’étaient pas dans les carnets, donc probablement pas dans les devis.`, 'Regarde lesquelles reviennent et ajoute-les à tes carnets types du catalogue.', '/catalogue', 4);
  if (E.doneN >= 5 && E.noDeclared / E.doneN > 0.25) add('wa', 'Données', `${pc(E.noDeclared / E.doneN)} des fiches finies sans heures déclarées`, 'Ton chiffrage apprend de ces heures : sans elles, il reste à l’aveugle.', 'Rappelle à l’équipe le « Ça t’a pris combien ? » de l’iPad ; c’est 10 secondes.', '/pilotage', 5);

  // Délais
  const D = R.delays;
  if (D.onTime !== null && D.delivered >= 2) {
    if (D.onTime < 0.85) add('ko', 'Délais', `${pc(D.onTime)} des affaires livrées à la date promise`, `${D.late.length} en retard, de ${Math.round(D.lateDays || 0)} jours en moyenne.`, 'Promets des dates depuis la page Charge (fin estimée), pas au feeling ; garde 15 % de marge.', '/charge', 7);
    else add('ok', 'Délais', `${pc(D.onTime)} des livraisons à l’heure`, `${D.delivered} affaire(s) livrée(s).`, 'Mets-le en avant auprès des architectes : c’est rare dans le métier.', '/poses', 3);
  }
  if (D.projectedLate.length) add('ko', 'Délais', `${D.projectedLate.length} OF finiront après la date promise`, D.projectedLate.slice(0, 3).map((p) => p.name).join(', '), 'Préviens les clients maintenant ou réaffecte des fiches (page Charge).', '/planning', 8);
  if (D.waiting.length) add(D.waiting[0].since > 7 ? 'ko' : 'wa', 'Trésorerie', `${D.waiting.length} acompte(s) attendu(s)${D.waitingEur ? `, ${eur(D.waitingEur)} d’affaires bloquées` : ''}`,
    `Le plus ancien : ${D.waiting[0].name}, depuis ${Math.round(D.waiting[0].since)} jours.${D.depositDays !== null ? ` D’habitude un acompte arrive en ${Math.round(D.depositDays)} jours.` : ''}`, 'Relance le jour même ; ne commande aucune matière sans acompte (la règle est déjà dans Achats).', '/projets?f=acompte', 7);

  // Capacité
  const C = R.capacity;
  if (C.load4 !== null) {
    if (C.load4 * 100 > O.load) add('ko', 'Capacité', `Atelier chargé à ${pc(C.load4)} sur 4 semaines (seuil ${O.load} %)`, `${hr(C.h4)} prévues pour ${hr(C.c4)} disponibles. Le moindre imprévu crée un retard.`, 'Décale une échéance, réaffecte des fiches, ou refuse de nouvelles dates courtes ce mois-ci.', '/charge', 8);
    else if (C.load4 < 0.5 && C.c4 > 0) add('wa', 'Capacité', `Atelier chargé à seulement ${pc(C.load4)} sur 4 semaines`, 'Des heures payées sans fabrication facturable.', 'Lance un lot boutique ou revendeur depuis le Catalogue pour occuper les creux, et relance les devis en attente.', '/catalogue', 6);
  }
  if (C.backlogMonths !== null && C.leftTotal > 0) {
    if (C.backlogMonths > O.backlog_max) add('idea', 'Prix', `${C.backlogMonths.toFixed(1).replace('.', ',')} mois de carnet : au-delà de ${O.backlog_max} mois`, 'La demande dépasse ta capacité : c’est le moment de monter les prix ou de recruter.', 'Augmente ton taux de 5 à 10 % sur les nouveaux devis (règle de ta stratégie).', '#capacite', 7);
    else if (C.backlogMonths < O.backlog_min) add('wa', 'Carnet', `${C.backlogMonths.toFixed(1).replace('.', ',')} mois de carnet, sous ton minimum de ${O.backlog_min} mois`, `${hr(C.leftTotal)} de fabrication restante.`, 'Priorité à l’acquisition : 2 rendez-vous prescripteurs par mois, relance des devis en attente.', '#marche', 7);
  }
  if (C.patronShare !== null && C.patronShare > 0.4 && C.teamSize > 1) add('ko', 'Organisation', `${pc(C.patronShare)} des heures restantes reposent sur toi`,
    'Tu ne peux pas être à la fois commercial, concepteur, chef d’atelier et poseur. C’est le goulot qui casse en premier selon ta simulation.', 'Délègue d’abord la fabrication répétitive (débit, ponçage, finition) ; garde la conception et la vente.', '/charge', 8);
  if (C.unassigned > 8) add('wa', 'Organisation', `${hr(C.unassigned)} de fiches sans personne attribuée`, 'Elles n’apparaissent dans la charge de personne : surcharge invisible.', 'Attribue-les dans les carnets.', '/carnets', 4);
  if (C.overWeeks.length) add('wa', 'Capacité', `${C.overWeeks.length} semaine(s)-personne au-delà de 100 % dans les 6 semaines`, [...new Set(C.overWeeks.map((x) => x.p.name))].join(', '), 'Rééquilibre dans la page Charge.', '/charge', 5);

  // Qualité
  const Q = R.quality;
  const topIssue = Q.issuesByGeste.find(([k]) => k !== 'Sans fiche');
  if (topIssue && topIssue[1] >= 3) add('idea', 'Qualité', `« ${topIssue[0]} » concentre ${topIssue[1]} problèmes signalés`, 'Un problème qui revient au même geste est un problème de méthode, d’outillage ou de gabarit, pas de personne.', 'Fais un point de 15 minutes avec l’équipe sur ce geste et écris le bon geste dans le carnet type.', '#qualite', 5);
  if (Q.savRate !== null && Q.unitsOut >= 5 && Q.savRate > 0.05) add('ko', 'Qualité', `SAV sur ${pc(Q.savRate)} des pièces livrées`, `${Q.sav} demande(s) sur la période, ${Math.round(Q.savHours)} h passées.`, 'Ajoute le point de contrôle qui aurait évité la panne la plus fréquente dans le contrôle qualité du modèle.', '/sav', 6);
  if (Q.pv >= 2 && Q.pvReserves / Q.pv > 0.25) add('wa', 'Qualité', `${pc(Q.pvReserves / Q.pv)} des PV signés avec réserve`, 'Chaque réserve retarde le solde et coûte un déplacement.', 'Fais une photo de contrôle en lumière rasante avant chaque départ.', '/poses', 5);
  if (Q.openIssues >= 3) add('wa', 'Qualité', `${Q.openIssues} problèmes signalés toujours ouverts`, 'L’atelier attend une réponse.', 'Réponds-y depuis Aujourd’hui.', '/', 5);

  // Achats et machines
  const A = R.supply;
  if (A.lateRate !== null && A.lateRate > 0.3) add('wa', 'Achats', `${pc(A.lateRate)} des commandes fournisseurs arrivent en retard`, A.bySup[0] ? `Le moins fiable : ${A.bySup[0].k}.` : '', 'Commande plus tôt chez lui, ou trouve un second fournisseur pour ce qui bloque l’atelier.', '/fournisseurs', 4);
  if (A.openLate.length) add('wa', 'Achats', `${A.openLate.length} commande(s) en retard en ce moment`, A.openLate.slice(0, 3).map((o) => `${o.sname || ''} : ${o.what}`).join(' · '), 'Relance depuis Commandes en cours.', '/commandes', 5);
  if (A.needsOld >= 3) add('wa', 'Achats', `${A.needsOld} besoins notés depuis plus d’une semaine, pas commandés`, 'Un besoin qui traîne devient un arrêt de l’atelier le jour du débit.', 'Fais une commande groupée chaque lundi (rituel de ta stratégie).', '/achats', 4);
  if (A.materialShare !== null && A.materialShare > 0.4) add('idea', 'Prix', `La matière pèse ${pc(A.materialShare)} de tes ventes`, 'Au-delà de 35 %, ton coefficient matière ne couvre plus les chutes, le stockage et l’avance de trésorerie.', 'Applique le coefficient 1,35 sur la matière, et 40 % d’acompte avant de commander.', '#rentabilite', 4);
  const MM = R.machines;
  if (MM.down.length) add('ko', 'Machines', `${MM.down.map((m) => m.name).join(', ')} en panne`, '', 'Voir la fiche machine et le contact SAV.', '/machines', 7);
  if (MM.daysDown >= 3) add('wa', 'Machines', `${MM.daysDown} jours d’arrêt machine sur la période`, MM.worst[0] ? `Surtout : ${MM.worst[0][0]}.` : '', 'Respecte les entretiens à l’usage : ils sont calculés depuis les fiches.', '/machines', 4);
  if (MM.late.length) add('wa', 'Machines', `${MM.late.length} entretien(s) dépassé(s)`, MM.late.slice(0, 3).map((x) => `${x.m.name} : ${x.t.title}`).join(' · '), 'Planifie-les un vendredi après-midi.', '/machines', 3);

  // Acquisition, image, relation
  const K = R.market;
  if (K.network !== null && K.sourceKnown >= 3) {
    if (K.network * 100 < O.network) add('wa', 'Acquisition', `${pc(K.network)} des affaires viennent du réseau (prescripteurs, clients livrés)`, `Objectif : ${O.network} %. Le réseau amène des clients déjà qualifiés, qui signent plus et discutent moins le prix.`, 'Fixe 2 rendez-vous prescripteurs par mois et un message à J+30 à chaque client livré.', '#marche', 6);
    else add('ok', 'Acquisition', `${pc(K.network)} des affaires viennent du réseau`, 'Ton meilleur canal fonctionne.', 'Formalise une commission prescripteur et une carte de parrainage.', '#marche', 2);
  }
  if (K.core !== null && K.core < 0.6) add('wa', 'Positionnement', `Seulement ${pc(K.core)} des affaires dans tes trois familles cœur`, 'Tu fabriques surtout ce que tu ne veux pas montrer : cela attire encore plus de demandes du même type.', 'Ne publie que les pièces que tu veux refaire ; refuse ou oriente le reste.', '#marche', 6);
  if (K.photos30 < O.posts_month) add('idea', 'Image', `${K.photos30} photo(s) « publiable » ce mois-ci, objectif ${O.posts_month}`, 'Ta stratégie prévoit 3 publications par semaine et une pièce publiée par mois sur le site.', 'Coche « Publiable » sur les photos de l’atelier : la matière est déjà là, il suffit de la trier.', '/projets', 3);
  if (K.openPortals >= 2 && K.portalOpen !== null && K.portalOpen < 0.6) add('idea', 'Relation client', `${pc(1 - K.portalOpen)} des clients en cours n’ont pas d’espace de suivi ouvert`, 'Sans espace, ils appellent pour avoir des nouvelles : 6 à 7 h par semaine à 80 clients.', 'Ouvre l’espace client dès l’acompte reçu.', '/portails?f=espaces', 4);
  if (K.clients >= 5 && K.repeat !== null && K.repeat < 0.1) add('idea', 'Acquisition', `${pc(K.repeat)} de clients reviennent pour une 2e affaire`, 'Un client livré satisfait est le prospect le moins cher.', 'Message automatique à J+365 avec une photo de sa pièce et une idée de pièce complémentaire.', '#marche', 3);

  // Données
  const missing = R.data.filter(([, n, tot]) => tot && n / tot > 0.3);
  if (missing.length) add('wa', 'Données', `${missing.length} trou(s) dans tes données faussent l’analyse`, missing.map(([l, n, tot]) => `${l} : ${n} / ${tot}`).join(' · '), 'Complète-les en 10 minutes chaque lundi pendant la revue des projets.', '#donnees', 6);
  if (R.hourlyRateMissing) add('wa', 'Données', 'Le taux horaire de l’atelier n’est pas renseigné', 'Le coût de main-d’œuvre par OF reste vide, et Cockpit ne reçoit pas les coûts réels.', 'Indique-le dans Équipe et réglages › Entreprise.', '/entreprise', 4);

  const order = { ko: 0, wa: 1, idea: 2, ok: 3 };
  return F.sort((a, b) => order[a.level] - order[b.level] || b.weight - a.weight);
}

module.exports = { compute, objectives, OBJECTIVES, PERIODS, FAMILIES, SOURCES };
