'use strict';
// Mode atelier (iPad) : qui travaille, ma prochaine tâche, mon carnet, l'étape en cours, il manque, photo, signaler.
const express = require('express');
const { q, tx, PHASES, STOCK_CATS, logActivity } = require('../db');
const { h, page, avatar, pill, options, longDate, today, rel, hoursLabel, flashBox, ddmm } = require('../html');
const { requireAtelier, verify, throttle, fail } = require('../auth');
const { upload, fileUrl } = require('../uploads');
const { setStockState } = require('./achats');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();

const ICON = {
  plus: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  box: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l9-4 9 4-9 4z"/><path d="M3 8v8l9 4 9-4V8"/><path d="M12 12v8"/></svg>',
  cam: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  warn: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z"/><path d="M12 8v5M12 16v.5" stroke-linecap="round"/></svg>',
};
const raw = require('../html').raw;

function shell(req, title, body, { back = '' } = {}) {
  const p = req.person;
  return page(title, h`<div class="ipad">
<header class="ip-head"><a href="/atelier" class="brand"><img src="/static/logo.png" alt="Carchon Les Ateliers"><span>ATELIER</span></a>
${back ? h`<a class="ip-back" href="${back}">‹ Retour</a>` : ''}
<nav class="ip-nav"><a href="/atelier">Accueil</a><a href="/atelier/carnet">Mon carnet</a></nav>
<div class="push line">${p ? h`<form method="post" action="/atelier/changer"><button class="pp on">${avatar(p)}${p.role === 'patron' ? 'Toi' : p.name} · changer</button></form>` : ''}
${req.session.role === 'patron' ? h`<a href="/" class="b ip-link">Vue patron</a>` : ''}</div></header>
<main class="ip-main">${flashBox(req.flash)}${body}</main></div>`, { bodyClass: 'atelier' });
}

// ---------- Qui travaille ----------
r.get('/qui', (req, res) => {
  const ppl = L.people().filter((p) => p.pin_hash || (p.role === 'patron' && req.session.role === 'patron'));
  const sel = ppl.find((p) => String(p.id) === String(req.query.p));
  const body = sel ? h`<section class="ip-card center mw480"><div>${avatar(sel, 64)}</div><h1>${sel.role === 'patron' ? 'Toi' : sel.name}</h1>
${sel.role === 'patron' && req.session.role === 'patron' ? h`<form method="post" action="/atelier/qui"><input type="hidden" name="id" value="${sel.id}"><button class="big-btn">Ouvrir mon carnet</button></form>`
    : h`<form method="post" action="/atelier/qui" class="form"><input type="hidden" name="id" value="${sel.id}"><label>Ton code à 4 chiffres <input class="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autofocus required></label><button class="big-btn">Ouvrir</button></form>`}
<a href="/atelier/qui" class="b">Ce n'est pas moi</a></section>`
    : h`<h1 class="center">Qui travaille sur cette tablette ?</h1><div class="who-grid">${ppl.map((p) => h`<a class="who-tile" href="/atelier/qui?p=${p.id}">${avatar(p, 72)}<b>${p.role === 'patron' ? 'Toi' : p.name}</b><span class="mut">${p.sub}</span></a>`)}</div>
${ppl.length ? '' : h`<p class="center mut">Personne n'a encore de code iPad. Le patron les crée dans Pilotage › Réglages équipe.</p>`}
<p class="center mt20"><a href="/connexion" class="b">Accès patron</a></p>`;
  res.send(shell(req, 'Atelier', body));
});
r.post('/qui', (req, res) => {
  const p = q.get('SELECT * FROM people WHERE id = ? AND active = 1', req.body.id);
  if (!p) return res.redirect('/atelier/qui');
  if (!(p.role === 'patron' && req.session.role === 'patron')) {
    const key = `pin:${p.id}:${req.ip}`;
    if (throttle(key)) return res.flashTo(`/atelier/qui?p=${p.id}`, 'Trop d’essais. Attends 10 minutes.', 'ko');
    if (!verify(req.body.pin || '', p.pin_hash)) { fail(key); return res.flashTo(`/atelier/qui?p=${p.id}`, 'Code incorrect.', 'ko'); }
  }
  req.session.atelier = p.id; res.saveSession();
  res.redirect('/atelier');
});
r.post('/changer', (req, res) => { delete req.session.atelier; res.saveSession(); res.redirect('/atelier/qui'); });

r.use(requireAtelier);

// ---------- Accueil : ma prochaine tâche ----------
r.get('/', (req, res) => {
  const me = req.person;
  const mine = L.stepsFor(me.id);
  const task = mine[0];
  const fresh = mine.filter((s) => !s.seen).length;
  const free = q.all(`SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.sent = 1 AND steps.who_id IS NULL AND steps.status != 'done' AND projects.status = 'en_cours' ORDER BY projects.due_date, steps.ord LIMIT 3`);
  const replies = q.all("SELECT issues.*, projects.name pname FROM issues LEFT JOIN projects ON projects.id = issues.project_id WHERE issues.person_id = ? AND issues.reply != '' AND issues.created_at >= datetime('now', '-3 days') ORDER BY issues.created_at DESC LIMIT 3", me.id);
  const plan = task?.plan_id ? q.get('SELECT version FROM plans WHERE id = ?', task.plan_id) : null;
  const body = h`<div class="ip-grid">
<section class="stack18">
${task ? h`<div class="next"><div class="eb light">Ma prochaine tâche · ${me.role === 'patron' ? 'toi' : me.name}</div>
<div class="next-t">${task.pname} · ${task.title}</div>${task.piece ? h`<div class="next-w">${task.piece}</div>` : ''}
<div class="line">${task.est_hours ? h`<span class="tag">Prévu ${hoursLabel(task.est_hours)}</span>` : ''}${plan ? h`<span class="tag">Plan ${plan.version}</span>` : ''}${task.status === 'doing' ? h`<span class="tag">En cours</span>` : ''}</div>
${task.note ? h`<div class="note"><b>Mot du patron :</b> ${task.note}</div>` : ''}
<a class="go" href="/atelier/fiche/${task.id}">${task.status === 'doing' ? 'Continuer' : 'Commencer'}</a></div>`
    : h`<div class="next"><div class="next-t">Rien dans ton carnet pour l'instant</div><div class="next-w">${free.length ? 'Une fiche attend quelqu’un, juste en dessous.' : 'Demande au patron ce qui est prioritaire.'}</div></div>`}
${fresh ? h`<a class="ip-card warn-card" href="/atelier/carnet"><b>Le patron t'a envoyé ${fresh} fiche${fresh > 1 ? 's' : ''} nouvelle${fresh > 1 ? 's' : ''} ou modifiée${fresh > 1 ? 's' : ''}</b><span>Voir mon carnet</span></a>` : ''}
${replies.map((x) => h`<div class="ip-card"><b>Réponse du patron · ${x.pname || ''}</b><p>« ${x.reply} »</p><span class="mut">À propos de : ${x.body}</span></div>`)}
<div class="ip-card"><div class="eb">Ensuite</div>
${mine.slice(1, 4).map((s) => h`<a class="nx" href="/atelier/fiche/${s.id}"><b>${s.pname} · ${s.title}</b><span class="mut">${s.est_hours ? hoursLabel(s.est_hours) : ''}</span></a>`)}
${free.map((s) => h`<div class="nx"><b>${s.pname} · ${s.title}</b><form method="post" action="/atelier/fiche/${s.id}/prendre"><button class="btn alt sm">Je la prends</button></form></div>`)}
${mine.length > 1 || free.length ? '' : h`<p class="mut">Rien d'autre de prévu.</p>`}</div>
</section>
<section class="tiles">
<a class="tile" href="/atelier/manque">${raw(ICON.plus)}<span>Il manque<small>ajouter aux achats</small></span></a>
<a class="tile" href="/atelier/stock">${raw(ICON.box)}<span>Stock<small>OK, bientôt, vide</small></span></a>
<a class="tile" href="/atelier/photo">${raw(ICON.cam)}<span>Photo<small>rangée dans le projet</small></span></a>
<a class="tile danger" href="/atelier/signaler">${raw(ICON.warn)}<span>Signaler<small>un problème, avec photo</small></span></a>
</section></div>`;
  res.send(shell(req, 'Atelier', body));
});

// ---------- Mon carnet ----------
r.get('/carnet', (req, res) => {
  const me = req.person;
  const mine = L.stepsFor(me.id);
  const free = q.all(`SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.sent = 1 AND steps.who_id IS NULL AND steps.status != 'done' AND projects.status = 'en_cours' ORDER BY projects.due_date, steps.ord`);
  const done = q.all(`SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.who_id = ? AND steps.status = 'done' ORDER BY done_at DESC LIMIT 5`, me.id);
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  const card = (s) => h`<a class="fc" href="/atelier/fiche/${s.id}"><span class="dot" style="background:${L.projectColor(s.project_id)}"></span><span class="grow"><b>${s.title}</b><span class="mut">${s.pname}${s.piece ? ` · ${s.piece}` : ''}</span></span>
${!s.seen ? pill('wa', s.changed || s.started_at ? 'Modifiée' : 'Nouveau') : s.status === 'doing' ? pill('ok', 'En cours') : ''}</a>`;
  const body = h`<div class="eb">Mon carnet</div><h1>${me.role === 'patron' ? 'Toi' : me.name} · ${longDate(today())}</h1>
<div class="ip-grid mt20"><section class="stack12">
<div class="h3">À faire · dans l'ordre que tu veux</div>
${mine.map(card)}${mine.length ? '' : h`<p class="mut">Aucune fiche pour toi.</p>`}
${free.length ? h`<div class="h3 mt20">À prendre · personne dessus</div>${free.map((s) => h`<div class="fc"><span class="dot" style="background:${L.projectColor(s.project_id)}"></span><span class="grow"><b>${s.title}</b><span class="mut">${s.pname}</span></span><form method="post" action="/atelier/fiche/${s.id}/prendre"><button class="btn sm">Je la prends</button></form></div>`)}` : ''}
${done.length ? h`<div class="h3 mt20">Fini récemment</div>${done.map((s) => h`<div class="fc done"><span class="grow"><b>${s.title}</b><span class="mut">${s.pname} · ${s.declared_label || ''} · ${rel(s.done_at)}</span></span></div>`)}` : ''}
</section>
<section class="ip-card"><h2>+ Ajouter une étape</h2><p class="mut">Une étape oubliée dans le carnet ? Elle s'ajoute au projet, le patron la voit.</p>
<form method="post" action="/atelier/fiche" class="form"><label>Projet <select name="project_id" required>${options(projects.map((p) => [p.id, p.name]))}</select></label><label>Quoi <input name="title" required></label><button class="btn">Ajouter à mon carnet</button></form></section></div>`;
  res.send(shell(req, 'Mon carnet', body));
});

function loadStep(req, res, next) {
  const s = q.get('SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.id = ? AND steps.sent = 1', req.params.id);
  if (!s) return res.redirect('/atelier');
  req.step = s; next();
}
const mineOrFree = (req) => !req.step.who_id || req.step.who_id === req.person.id || req.person.role === 'patron';

r.post('/fiche', (req, res) => {
  const pid = Number(req.body.project_id);
  const ord = (q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', pid)?.m || 0) + 1;
  const id = q.run('INSERT INTO steps (project_id, ord, title, who_id, sent, seen, added_by_atelier) VALUES (?, ?, ?, ?, 1, 1, 1)', pid, ord, str(req.body.title), req.person.id).lastInsertRowid;
  res.redirect(`/atelier/fiche/${id}`);
});

// ---------- Étape en cours ----------
r.get('/fiche/:id', loadStep, (req, res) => {
  const s = req.step;
  if (s.who_id === req.person.id && !s.seen) q.run('UPDATE steps SET seen = 1 WHERE id = ?', s.id);
  const checks = JSON.parse(s.checks);
  const plan = s.plan_id ? q.get('SELECT * FROM plans WHERE id = ?', s.plan_id) : q.get("SELECT * FROM plans WHERE project_id = ? AND status = 'validee' ORDER BY id DESC LIMIT 1", s.project_id);
  const msgs = q.all('SELECT messages.*, people.name pname, people.role prole FROM messages LEFT JOIN people ON people.id = messages.person_id WHERE step_id = ? ORDER BY created_at', s.id);
  const who = s.who_id ? q.get('SELECT * FROM people WHERE id = ?', s.who_id) : null;
  const asking = req.query.fini === '1';
  const body = h`<div class="mut">${s.pname}${s.piece ? ` · ${s.piece}` : ''}${plan ? ` · plan ${plan.version}` : ''}${who ? ` · ${who.role === 'patron' ? 'toi' : who.name}` : ''}</div>
<h1>${s.title}</h1>
<div class="ip-grid mt12"><section class="stack12">
${plan?.file ? h`<a class="ip-card plan-link" href="${fileUrl(plan.file)}" target="_blank"><b>Plan ${plan.version}</b><span class="mut">${plan.descr || 'Ouvrir le plan'}</span></a>` : ''}
${s.note ? h`<div class="note big"><b>Mot du patron :</b> ${s.note}</div>` : ''}
${s.audio ? h`<div class="ip-card"><b>Vocal du patron</b><audio controls src="${fileUrl(s.audio)}"></audio></div>` : ''}
${s.geste === 'Usinage CNC' ? (() => { const progs = q.all('SELECT * FROM cnc_programs WHERE project_id = ? AND active = 1 ORDER BY job_id, sheet, name', s.project_id); return progs.length ? h`<div class="ip-card"><b>Programmes CNC</b>${progs.map((x) => h`<a class="row" href="${fileUrl(x.file)}" download="${x.name}"><span class="grow">${x.name}</span><span class="mut">V${x.version}${x.minutes ? ` · ${Math.round(x.minutes)} min` : ''}</span></a>`)}<p class="mut t12 mt8">Premier passage : lancer d’abord l’essai à vide depuis l’ordinateur.</p></div>` : ''; })() : ''}
<div class="ip-card"><div class="line"><b>Échanges sur cette fiche</b></div>
${msgs.map((m) => h`<div class="msg${m.person_id === req.person.id ? ' me' : ''}"><b>${m.prole === 'patron' ? 'Patron' : m.pname}</b> ${m.body} <span class="mut t12">· ${rel(m.created_at)}</span></div>`)}
<form method="post" action="/atelier/fiche/${s.id}/message" class="line mt8"><label class="sr" for="m">Écrire au patron</label><input id="m" class="qin" name="body" placeholder="Écrire au patron" required><button class="btn alt">Envoyer</button></form></div>
</section>
<section class="stack12">
${checks.length ? h`<div class="ip-card"><div class="line"><b>Repères facultatifs</b><span class="mut push">${checks.filter((c) => c.done).length} sur ${checks.length}</span></div>
${checks.map((c, i) => h`<form method="post" action="/atelier/fiche/${s.id}/repere" class="inline wfull"><input type="hidden" name="i" value="${i}"><button class="ckline${c.done ? ' on' : ''}" aria-pressed="${!!c.done}"><span class="box">${c.done ? '✓' : ''}</span>${c.t}</button></form>`)}</div>` : ''}
${s.status === 'done' ? h`<div class="ip-card ok-card"><b>Fini · ${s.declared_label || ''}</b><p class="mut">Le patron est prévenu.</p><a class="btn" href="/atelier">Ma prochaine tâche</a></div>`
    : asking ? h`<div class="ip-card"><h2>Ça t'a pris combien ?</h2><form method="post" action="/atelier/fiche/${s.id}/fini" class="durs">
${[['4', '½ journée'], ['8', '1 journée'], ['16', '2 jours'], ['2', '2 heures']].map(([v, l]) => h`<button name="hours" value="${v}" class="dur">${l}</button>`)}
<label class="wfull">Autre (heures) <input name="other" inputmode="decimal" class="qin"></label><button class="btn wfull">Valider</button></form></div>`
      : h`<div class="actions">
<a class="act" href="/atelier/photo?fiche=${s.id}">${raw(ICON.cam)}Photo</a><a class="act danger" href="/atelier/signaler?fiche=${s.id}">${raw(ICON.warn)}Signaler</a>
${s.status === 'doing' ? h`<a class="act main" href="/atelier/fiche/${s.id}?fini=1">Fait</a>` : mineOrFree(req) ? h`<form method="post" action="/atelier/fiche/${s.id}/commencer" class="inline"><button class="act main">Commencer</button></form>` : ''}</div>`}
</section></div>`;
  res.send(shell(req, s.title, body, { back: '/atelier/carnet' }));
});

r.post('/fiche/:id/prendre', loadStep, (req, res) => {
  q.run('UPDATE steps SET who_id = ?, seen = 1 WHERE id = ? AND who_id IS NULL', req.person.id, req.step.id);
  res.redirect(`/atelier/fiche/${req.step.id}`);
});
r.post('/fiche/:id/commencer', loadStep, (req, res) => {
  if (!mineOrFree(req)) return res.redirect(`/atelier/fiche/${req.step.id}`);
  if (req.step.status !== 'doing') logActivity(req.step.project_id, req.person.id, `Fiche commencée : ${req.step.title}`, req.person.name);
  // Premier coup de scie sur ce projet : le client est prévenu.
  if (!q.get('SELECT id FROM steps WHERE project_id = ? AND started_at IS NOT NULL', req.step.project_id)) require('../sms').notify('maj', { projectId: req.step.project_id, quoi: 'début de la fabrication' });
  q.run("UPDATE steps SET status = 'doing', started_at = COALESCE(started_at, datetime('now')), who_id = COALESCE(who_id, ?), seen = 1 WHERE id = ?", req.person.id, req.step.id);
  res.redirect(`/atelier/fiche/${req.step.id}`);
});
r.post('/fiche/:id/repere', loadStep, (req, res) => {
  const c = JSON.parse(req.step.checks); const i = Number(req.body.i);
  if (c[i]) { c[i].done = !c[i].done; q.run('UPDATE steps SET checks = ? WHERE id = ?', JSON.stringify(c), req.step.id); }
  res.redirect(`/atelier/fiche/${req.step.id}`);
});
r.post('/fiche/:id/fini', loadStep, (req, res) => {
  let hrs = parseFloat(String(req.body.other || '').replace(',', '.'));
  if (!Number.isFinite(hrs) || hrs <= 0) hrs = parseFloat(req.body.hours);
  if (!Number.isFinite(hrs) || hrs <= 0) return res.redirect(`/atelier/fiche/${req.step.id}?fini=1`);
  q.run("UPDATE steps SET status = 'done', done_at = datetime('now'), started_at = COALESCE(started_at, datetime('now')), declared_hours = ?, declared_label = ?, who_id = COALESCE(who_id, ?) WHERE id = ?", hrs, hoursLabel(hrs), req.person.id, req.step.id);
  logActivity(req.step.project_id, req.person.id, `Fiche terminée : ${req.step.title} (${hoursLabel(hrs)})`, req.person.name);
  res.flashTo(`/atelier/fiche/${req.step.id}`, `Noté : ${hoursLabel(hrs)}. Le patron est prévenu.`);
});
r.post('/fiche/:id/message', loadStep, (req, res) => {
  if (str(req.body.body)) q.run('INSERT INTO messages (step_id, person_id, body, read_by_patron) VALUES (?, ?, ?, ?)', req.step.id, req.person.id, str(req.body.body), req.person.role === 'patron' ? 1 : 0);
  res.redirect(`/atelier/fiche/${req.step.id}`);
});

// ---------- Il manque ----------
r.get('/manque', (req, res) => {
  const items = q.all('SELECT * FROM stock_items ORDER BY category, ord, name');
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  const body = h`<h1>Il manque quelque chose</h1><div class="ip-grid mt20">
<form method="post" action="/atelier/manque" class="ip-card form"><label>Quoi <input class="qin" name="text" required placeholder="ex. vis SPAX 4 × 40"></label>
<fieldset class="chips m0"><legend>Rayon (facultatif)</legend>${STOCK_CATS.map((c) => h`<label class="chip"><input type="radio" name="category" value="${c}">${c}</label>`)}</fieldset>
<label>Pour quel projet (facultatif) <select name="project_id"><option value="">—</option>${options(projects.map((p) => [p.id, p.name]))}</select></label>
<button class="big-btn">Ajouter aux achats</button></form>
<div class="ip-card"><b>Ou un article suivi, passé en « Vide »</b><div class="chips mt8">${items.filter((i) => i.state !== 2).map((i) => h`<form method="post" action="/atelier/stock/${i.id}" class="inline"><input type="hidden" name="state" value="2"><input type="hidden" name="back" value="/atelier/manque"><button class="chip">${i.name}</button></form>`)}</div></div></div>`;
  res.send(shell(req, 'Il manque', body, { back: '/atelier' }));
});
r.post('/manque', (req, res) => {
  if (str(req.body.text)) q.run("INSERT INTO needs (text, category, project_id, person_id, source) VALUES (?, ?, ?, ?, 'ipad')", str(req.body.text), str(req.body.category), req.body.project_id ? Number(req.body.project_id) : null, req.person.id);
  res.flashTo('/atelier', 'C’est noté dans les achats. Le patron valide la commande.');
});

// ---------- Stock ----------
r.get('/stock', (req, res) => {
  const items = q.all('SELECT * FROM stock_items ORDER BY category, ord, name');
  const cats = [...new Set(items.map((i) => i.category))];
  const body = h`<h1>Stock</h1><p class="mut">Un tap pour changer l'état. « Vide » l'ajoute aux achats.</p>
<div class="flexcards mt12">${cats.map((c) => h`<section class="ip-card"><div class="h3">${c}</div>${items.filter((i) => i.category === c).map((i) => h`<div class="it"><b class="grow">${i.name}</b>
<form method="post" action="/atelier/stock/${i.id}" class="seg3"><input type="hidden" name="back" value="/atelier/stock">${['OK', 'Bientôt', 'Vide'].map((s, v) => h`<button name="state" value="${v}" class="${i.state === v ? ['ok', 'lo', 'no'][v] : ''}" aria-pressed="${i.state === v}">${s}</button>`)}</form></div>`)}</section>`)}</div>`;
  res.send(shell(req, 'Stock', body, { back: '/atelier' }));
});
r.post('/stock/:id', (req, res) => {
  setStockState(Number(req.params.id), Math.max(0, Math.min(2, Number(req.body.state))), req.person.id);
  const back = String(req.body.back || '/atelier/stock');
  res.redirect(back.startsWith('/atelier') ? back : '/atelier/stock');
});

// ---------- Photo et signalement ----------
function projectPicker(req) {
  const s = req.query.fiche ? q.get('SELECT * FROM steps WHERE id = ?', req.query.fiche) : null;
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  return h`${s ? h`<input type="hidden" name="step_id" value="${s.id}">` : ''}<label>Projet <select name="project_id" required>${options(projects.map((p) => [p.id, p.name]), s?.project_id)}</select></label>`;
}
r.get('/photo', (req, res) => {
  const body = h`<h1>Photo</h1><form method="post" action="/atelier/photo" enctype="multipart/form-data" class="ip-card form mw680 mt20">${projectPicker(req)}
<label class="big-file">Prendre la photo <input type="file" name="photo" accept="image/*" capture="environment" required></label>
<label>Légende (facultatif) <input name="title" class="qin"></label><button class="big-btn">Ranger dans le projet</button></form>`;
  res.send(shell(req, 'Photo', body, { back: req.query.fiche ? `/atelier/fiche/${req.query.fiche}` : '/atelier' }));
});
r.post('/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.flashTo('/atelier/photo', 'Photo non reçue, réessaie.', 'ko');
  const stepId = req.body.step_id ? Number(req.body.step_id) : null;
  const title = str(req.body.title) || (stepId ? q.get('SELECT title FROM steps WHERE id = ?', stepId)?.title : '') || '';
  q.run('INSERT INTO photos (project_id, step_id, file, title, person_id) VALUES (?, ?, ?, ?, ?)', Number(req.body.project_id), stepId, req.file.filename, title, req.person.id);
  logActivity(Number(req.body.project_id), req.person.id, `Photo ajoutée${title ? ` : ${title}` : ''}`, req.person.name);
  res.flashTo(stepId ? `/atelier/fiche/${stepId}` : '/atelier', 'Photo rangée dans le projet.');
});
r.get('/signaler', (req, res) => {
  const machines = q.all('SELECT id, name FROM machines WHERE down_since IS NULL ORDER BY ord, name');
  const body = h`<h1 class="red">Signaler un problème</h1><form method="post" action="/atelier/signaler" enctype="multipart/form-data" class="ip-card form mw680 mt20">${projectPicker(req)}
<label>Ce qui se passe <textarea name="body" rows="3" required placeholder="ex. petite fente en bout de plateau"></textarea></label>
<label class="big-file">Photo (conseillé) <input type="file" name="photo" accept="image/*" capture="environment"></label>
<button class="big-btn danger">Prévenir le patron</button></form>
${machines.length ? h`<form method="post" action="/atelier/panne" class="ip-card form mw680 mt20"><h2>Une machine est en panne</h2>
<label>Machine <select name="machine_id" required>${options(machines.map((m) => [m.id, m.name]))}</select></label>
<label>Ce qui se passe <input class="qin" name="note" required placeholder="ex. la lame vibre, bruit anormal"></label>
<button class="big-btn danger">Mettre la machine en panne</button></form>` : ''}`;
  res.send(shell(req, 'Signaler', body, { back: req.query.fiche ? `/atelier/fiche/${req.query.fiche}` : '/atelier' }));
});
r.post('/signaler', upload.single('photo'), (req, res) => {
  const pid = Number(req.body.project_id);
  const stepId = req.body.step_id ? Number(req.body.step_id) : null;
  tx(() => {
    const ph = req.file ? q.run('INSERT INTO photos (project_id, step_id, file, title, person_id) VALUES (?, ?, ?, ?, ?)', pid, stepId, req.file.filename, str(req.body.body).slice(0, 80), req.person.id).lastInsertRowid : null;
    q.run('INSERT INTO issues (project_id, step_id, person_id, body, photo_id) VALUES (?, ?, ?, ?, ?)', pid, stepId, req.person.id, str(req.body.body), ph);
    logActivity(pid, req.person.id, `Problème signalé : ${str(req.body.body)}`, req.person.name);
  });
  res.flashTo(stepId ? `/atelier/fiche/${stepId}` : '/atelier', 'Le patron est prévenu. Sa réponse s’affichera ici.');
});

r.post('/panne', (req, res) => {
  q.run("UPDATE machines SET down_since = datetime('now'), down_note = ? WHERE id = ? AND down_since IS NULL", `${str(req.body.note)} (${req.person.name})`, Number(req.body.machine_id));
  res.flashTo('/atelier', 'Machine mise en panne : le patron est prévenu.');
});

module.exports = r;
void PHASES; void ddmm;
