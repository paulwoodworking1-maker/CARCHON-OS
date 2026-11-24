'use strict';
// Patron : Aujourd'hui, recherche, liste des projets et fiche projet.
const express = require('express');
const { q, tx, PHASES } = require('../db');
const { h, raw, layout, pill, avatar, postBtn, options, hidden, ddmm, longDate, today, addDays, rel, hoursLabel, dayMonth, hhmm } = require('../html');
const L = require('../logic');
const { upload, fileUrl, isImage } = require('../uploads');

const r = express.Router();
const int = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
const str = (v) => String(v ?? '').trim();

const friseBar = (fr) => h`<div class="bar" aria-hidden="true">${fr.map((f) => h`<i class="${f.state}" title="${f.phase} · ${f.label}"></i>`)}</div>`;

function projectCard(p) {
  return h`<a class="proj" href="/projets/${p.id}">
<div class="line"><b class="t16">${p.name}</b>${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}</span>
<span class="mut push">${p.due_date ? `Livraison ${ddmm(p.due_date)} · ` : ''}<b style="color:${p.slack.color}">${p.slack.text}</b></span></div>
${friseBar(p.frise)}
<div class="line"><span class="mut"><b class="ink">${p.cur.phase}</b> · ${p.next}</span><span class="push">${avatar(p.lead, 28)}</span></div></a>`;
}

// ---------- Aujourd'hui ----------
r.get('/', (req, res) => {
  const projects = q.all("SELECT * FROM projects WHERE status = 'en_cours' ORDER BY due_date IS NULL, due_date").map(L.projectSummary);
  const decide = L.toDecide();
  const issues = q.all("SELECT issues.*, projects.name pname, people.name who FROM issues LEFT JOIN projects ON projects.id = issues.project_id LEFT JOIN people ON people.id = issues.person_id WHERE issues.status = 'open' ORDER BY issues.created_at DESC");
  const t = today(), end = addDays(t, 6);
  const crew = L.people().map((p) => {
    const doing = q.get(`SELECT steps.title, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE who_id = ? AND steps.status = 'doing' ORDER BY started_at DESC LIMIT 1`, p.id);
    const bar = q.get('SELECT bars.*, projects.name pname FROM bars LEFT JOIN projects ON projects.id = bars.project_id WHERE person_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1', p.id, t, t);
    const next = doing ? null : L.stepsFor(p.id)[0];
    let line = 'Rien de prévu', sub = '';
    if (doing) { line = doing.pname; sub = doing.title; }
    else if (bar) { line = bar.pname || bar.label; sub = bar.detail || bar.label; }
    else if (next) { line = next.pname; sub = `Prochaine fiche : ${next.title}`; }
    return { p, line, sub };
  });
  const week = [
    ...q.all('SELECT expected_at d, suppliers.name s, what FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE arrived_at IS NULL AND expected_at BETWEEN ? AND ?', t, end).map((o) => ({ d: o.d, t: 'Livraison fournisseur', s: `${o.s || ''} · ${o.what}` })),
    ...q.all('SELECT trips.date d, projects.name pname, what FROM trips JOIN projects ON projects.id = trips.project_id WHERE date BETWEEN ? AND ? AND done_at IS NULL', t, end).map((x) => ({ d: x.d, t: 'Livraison / pose', s: `${x.pname} · ${x.what}` })),
    ...q.all('SELECT events.*, projects.name pname FROM events LEFT JOIN projects ON projects.id = events.project_id WHERE date BETWEEN ? AND ?', t, end).map((e) => ({ d: e.date, t: e.title, s: [e.pname, e.detail].filter(Boolean).join(' · ') })),
    ...q.all("SELECT bars.*, projects.name pname FROM bars LEFT JOIN projects ON projects.id = bars.project_id WHERE lane = 'event' AND start_date BETWEEN ? AND ?", t, end).map((b) => ({ d: b.start_date, t: b.label, s: [b.pname, b.detail].filter(Boolean).join(' · ') })),
  ].sort((a, b) => a.d.localeCompare(b.d));
  const deposits = q.all("SELECT name FROM projects WHERE status = 'en_cours' AND client_id IS NOT NULL AND deposit_needed = 1 AND deposit_at IS NULL");
  const monthEnd = t.slice(0, 7) + '-31';
  const toDeliver = q.all("SELECT name, due_date FROM projects WHERE status = 'en_cours' AND due_date BETWEEN ? AND ?", t, monthEnd);
  const balance = q.all('SELECT projects.name, pv_signed_at FROM trips JOIN projects ON projects.id = trips.project_id WHERE pv_signed_at IS NOT NULL AND balance_paid_at IS NULL');
  const nextDelivery = q.get('SELECT expected_at FROM orders WHERE arrived_at IS NULL AND expected_at >= ? ORDER BY expected_at LIMIT 1', t);
  const counters = [
    `${projects.length} projet${projects.length > 1 ? 's' : ''} en cours`,
    decide.length ? raw(`<b class="red">${decide.length} chose${decide.length > 1 ? 's' : ''} à décider</b>`) : 'rien à décider',
    issues.length ? `${issues.length} problème${issues.length > 1 ? 's' : ''} signalé${issues.length > 1 ? 's' : ''}` : null,
    nextDelivery ? `livraison fournisseur ${longDate(nextDelivery.expected_at).split(' ')[0]}` : null,
  ].filter(Boolean);

  const body = h`
<div class="eb">${longDate(t)}</div><h1>Bonjour</h1>
<p class="mut t15">${counters.map((c, i) => h`${i ? ' · ' : ''}${c}`)}</p>
<div class="cols">
<div class="main-col">
<section class="card" aria-labelledby="dec">
  <div class="line"><h2 id="dec">À décider</h2>${pill(decide.length ? 'ko' : 'ok', decide.length)}<span class="mut push">Tout ce qui attend ta réponse, au même endroit</span></div>
  ${decide.length ? decide.map((d, i) => h`<div class="row${i ? '' : ' f'}"><span class="kind">${pill(d.kind, d.tag)}</span><div class="grow"><b>${d.title}</b><span class="mut">${d.text}</span></div>
    ${d.ack ? postBtn(`/achats/besoin/${d.ack}/valider`, 'Valider', 'btn alt sm') : h`<a class="btn ${d.primary ? '' : 'alt '}sm" href="${d.href}">${d.cta}</a>`}</div>`)
    : h`<p class="mut">Rien n’attend ta réponse. Bonne journée à l’atelier.</p>`}
</section>
<section aria-labelledby="pr">
  <div class="line mb12"><h2 id="pr">Projets en cours</h2><a class="push b" href="/projets">Tous les projets</a></div>
  <div class="stack12">${projects.length ? projects.map(projectCard) : h`<div class="card"><p class="mut">Aucun projet en cours. Les projets clients se créent quand un devis est accepté sur le portail (<a href="/portails?nouveau=1">envoyer un devis</a>) ; les projets d’atelier se créent dans <a href="/projets/nouveau">Projets</a>.</p></div>`}</div>
</section>
</div>
<aside class="side-col">
<section class="card" aria-labelledby="at"><h2 id="at">L'atelier aujourd'hui</h2>
  ${crew.map((c, i) => h`<div class="who${i ? '' : ' f'}">${avatar(c.p)}<div class="grow"><b class="t14">${c.p.role === 'patron' ? 'Toi' : c.p.name} · ${c.line}</b><span class="mut">${c.sub}</span></div></div>`)}
</section>
${issues.length ? h`<section class="card danger" aria-labelledby="sig"><div class="line"><h2 id="sig">Signalé par l'atelier</h2>${pill('ko', issues.length)}</div>
  ${issues.map((s) => {
    const ph = s.photo_id ? q.get('SELECT file FROM photos WHERE id = ?', s.photo_id) : null;
    return h`<div class="line mt12">${ph ? h`<img class="thumb" src="${fileUrl(ph.file)}" alt="Photo du problème">` : ''}<div class="grow"><b class="t14">${s.body}</b><span class="mut">${s.pname || ''} · ${s.who || ''} · ${rel(s.created_at)}</span></div></div>
    <div class="line mt8"><a class="btn sm" href="/projets/${s.project_id}#probleme">Traiter</a></div>`;
  })}</section>` : ''}
<section class="card" aria-labelledby="sem"><h2 id="sem">Cette semaine</h2>
  ${week.length ? week.map((w, i) => h`<div class="who${i ? '' : ' f'}"><span class="day">${['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][new Date(w.d + 'T12:00').getDay()]} ${Number(w.d.slice(8))}</span><div class="grow"><b class="t14">${w.t}</b><span class="mut">${w.s}</span></div></div>`) : h`<p class="mut">Rien de daté cette semaine.</p>`}
  <a class="b mt8 inl" href="/planning">Ouvrir le planning</a>
</section>
<section class="card" aria-labelledby="chf"><h2 id="chf">En chiffres</h2>
  <div class="who f"><b class="bignum${deposits.length ? ' red' : ''}">${deposits.length}</b><div class="grow"><b class="t14">Acompte${deposits.length > 1 ? 's' : ''} attendu${deposits.length > 1 ? 's' : ''}</b><span class="mut">${deposits.map((d) => d.name).join(', ') || '—'}</span></div></div>
  <div class="who"><b class="bignum">${toDeliver.length}</b><div class="grow"><b class="t14">À livrer ce mois</b><span class="mut">${toDeliver.map((d) => `${d.name} · ${ddmm(d.due_date)}`).join(', ') || '—'}</span></div></div>
  <div class="who"><b class="bignum">${balance.length}</b><div class="grow"><b class="t14">Solde à facturer</b><span class="mut">${balance.map((b) => `${b.name} · PV du ${ddmm(b.pv_signed_at)}`).join(', ') || '—'}</span></div></div>
</section>
</aside></div>`;
  res.send(layout({ title: "Aujourd'hui", tab: 'aujourdhui', body, flash: req.flash }));
});

// ---------- Recherche ----------
r.get('/recherche', (req, res) => {
  const s = str(req.query.q);
  const like = `%${s}%`;
  const projects = s ? q.all('SELECT projects.*, clients.name cname FROM projects LEFT JOIN clients ON clients.id = projects.client_id WHERE projects.name LIKE ? OR clients.name LIKE ? OR projects.notes LIKE ? LIMIT 30', like, like, like) : [];
  const steps = s ? q.all('SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.title LIKE ? OR steps.note LIKE ? LIMIT 30', like, like) : [];
  const stock = s ? q.all('SELECT * FROM stock_items WHERE name LIKE ? LIMIT 20', like) : [];
  const sup = s ? q.all('SELECT * FROM suppliers WHERE name LIKE ? OR note LIKE ? LIMIT 20', like, like) : [];
  const body = h`<h1>Rechercher</h1>
<form class="line mt12" method="get"><label class="sr" for="q2">Recherche</label><input id="q2" class="qin" name="q" value="${s}" autofocus><button class="btn">Chercher</button></form>
${s ? h`<div class="stack12 mt20">
<section class="card"><h2>Projets</h2>${projects.map((p) => h`<div class="row"><a class="grow b" href="/projets/${p.id}">${p.name}</a><span class="mut">${p.cname || ''}</span></div>`)}${projects.length ? '' : h`<p class="mut">Aucun.</p>`}</section>
<section class="card"><h2>Fiches de fabrication</h2>${steps.map((x) => h`<div class="row"><a class="grow b" href="/carnets/${x.project_id}?fiche=${x.id}">${x.title}</a><span class="mut">${x.pname}</span></div>`)}${steps.length ? '' : h`<p class="mut">Aucune.</p>`}</section>
<section class="card"><h2>Stock et fournisseurs</h2>${stock.map((x) => h`<div class="row"><a class="grow" href="/stock">${x.name}</a><span class="mut">${x.category}</span></div>`)}${sup.map((x) => h`<div class="row"><a class="grow" href="/fournisseurs">${x.name}</a><span class="mut">${x.note}</span></div>`)}${stock.length + sup.length ? '' : h`<p class="mut">Rien.</p>`}</section>
</div>` : ''}`;
  res.send(layout({ title: 'Rechercher', tab: '', body }));
});

// ---------- Projets ----------
const CELL = { d: 'd', c: 'cc', p: 'p', w: 'w', n: 'n' };
r.get('/projets', (req, res) => {
  const done = req.query.vue === 'termines';
  const all = q.all(`SELECT * FROM projects WHERE status = ? ORDER BY ${done ? 'finished_at DESC' : 'due_date IS NULL, due_date'}`, done ? 'termine' : 'en_cours').map(L.projectSummary);
  const tag = (p) => {
    const t = [];
    if (p.frise.some((f) => f.state === 'p')) t.push('bloque');
    if (p.frise.find((f) => f.phase === 'Finition' && f.state === 'c')) t.push('finition');
    if (p.due_date && p.due_date.slice(0, 7) === today().slice(0, 7)) t.push('livrer');
    return t;
  };
  all.forEach((p) => { p.tags = tag(p); });
  const f = done ? 'all' : (req.query.f || 'all');
  const rows = f === 'all' ? all : all.filter((p) => p.tags.includes(f));
  const n = (k) => all.filter((p) => p.tags.includes(k)).length;
  const chips = [['all', `Tous · ${all.length}`], ['bloque', `À débloquer · ${n('bloque')}`], ['finition', `En finition · ${n('finition')}`], ['livrer', `À livrer ce mois · ${n('livrer')}`]];
  const body = h`
<div class="head"><div><div class="eb">Fabriquer</div><h1>${done ? 'Projets terminés' : 'Projets'}</h1></div>
<a class="btn push" href="/projets/nouveau">+ Projet d'atelier</a></div>
<p class="mut mt8">Les projets clients se créent depuis un devis accepté (bloc « À décider »). Ici, tu peux aussi créer un projet d'atelier, de série ou une reprise. La frise avance toute seule quand l'atelier coche ses fiches.</p>
${done ? '' : h`<div class="chips" role="group" aria-label="Filtrer">${chips.map(([k, l]) => h`<a class="chip${f === k ? ' on' : ''}" href="/projets?f=${k}">${l}</a>`)}</div>`}
<div class="tablebox mt12"><table class="frise">
<thead><tr><th class="pcol">Projet · prochaine action</th>${PHASES.map((p) => h`<th>${p}</th>`)}<th>Échéance</th></tr></thead>
<tbody>${rows.map((p) => h`<tr><td class="pcol"><a href="/projets/${p.id}" class="b">${p.name}</a> ${pill('no', p.kind)}<div class="mut">${p.client ? p.client.name : 'hors commande'} → ${p.next}</div></td>
${p.frise.map((c) => h`<td><span class="c ${CELL[c.state]}">${c.label}</span></td>`)}
<td class="due"><b>${p.due_date ? ddmm(p.due_date) : 'à fixer'}</b><div style="color:${p.slack.color}" class="t12 b">${done ? (p.finished_at ? `terminé ${ddmm(p.finished_at)}` : '') : p.slack.text}</div>${avatar(p.lead, 26)}</td></tr>`)}
${rows.length ? '' : h`<tr><td colspan="11" class="mut">Aucun projet dans ce filtre.</td></tr>`}</tbody></table></div>
<div class="legend"><span><i class="c d"></i>Fait</span><span><i class="c cc"></i>En cours</span><span><i class="c p"></i>Bloque · à traiter</span><span><i class="c w"></i>À venir</span><span><i class="c n"></i>Sans objet</span></div>`;
  res.send(layout({ title: 'Projets', tab: 'projets', sub: done ? '/projets?vue=termines' : '/projets', body, flash: req.flash }));
});

r.get('/projets/nouveau', (req, res) => {
  const body = h`<div class="eb"><a href="/projets">Projets</a></div><h1>Nouveau projet</h1>
<form method="post" action="/projets/nouveau" class="card form mt20" style="max-width:640px">
<label>Nom du projet <input name="name" required placeholder="ex. Maggio, Série de tabourets…"></label>
<label>Type <select name="kind">${options(['Atelier', 'Série', 'Reprise', 'Particulier', 'Architecte', 'Professionnel'], 'Atelier')}</select></label>
<label>Client (facultatif) <select name="client_id"><option value="">Hors commande client</option>${options(q.all('SELECT id, name FROM clients ORDER BY name').map((c) => [c.id, c.name]))}</select></label>
<label>Échéance <input type="date" name="due_date"></label>
<label>Responsable <select name="lead_id">${options(L.people().map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select></label>
<button class="btn">Créer le projet</button></form>`;
  res.send(layout({ title: 'Nouveau projet', tab: 'projets', sub: '/projets', body }));
});
r.post('/projets/nouveau', (req, res) => {
  const b = req.body;
  const id = q.run('INSERT INTO projects (name, kind, client_id, due_date, lead_id, deposit_needed) VALUES (?, ?, ?, ?, ?, ?)',
    str(b.name), str(b.kind), int(b.client_id), str(b.due_date) || null, int(b.lead_id), b.client_id ? 1 : 0).lastInsertRowid;
  res.flashTo(`/projets/${id}`, 'Projet créé. Prépare son carnet de fabrication quand tu es prêt.');
});

// ---------- Fiche projet ----------
function loadProject(req, res, next) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.status(404).send(layout({ title: 'Introuvable', tab: 'projets', body: h`<h1>Projet introuvable</h1>` }));
  req.project = p; next();
}

r.get('/projets/:id', loadProject, (req, res) => {
  const p = L.projectSummary(req.project);
  const pm = L.peopleMap();
  const pieces = q.all('SELECT * FROM pieces WHERE project_id = ? ORDER BY id', p.id);
  const plans = q.all('SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC', p.id);
  const photos = q.all('SELECT * FROM photos WHERE project_id = ? ORDER BY created_at DESC', p.id);
  const issues = q.all("SELECT * FROM issues WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC", p.id);
  const docs = q.all('SELECT * FROM documents WHERE project_id = ? ORDER BY id DESC', p.id);
  const time = q.all("SELECT COALESCE(NULLIF(geste,''), title) g, SUM(declared_hours) h, COUNT(*) n, SUM(status = 'doing') doing FROM steps WHERE project_id = ? AND (declared_hours IS NOT NULL OR status = 'doing') GROUP BY g", p.id);
  const total = time.reduce((a, t) => a + (t.h || 0), 0);
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
  const shared = photos.filter((x) => x.shared_client).length;
  const people = L.people();
  const body = h`
<div class="mut"><a href="/projets">Projets</a> › ${p.name}</div>
<div class="head mt4"><div><h1 class="m0">${p.name}</h1>
<div class="line mt8">${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}${p.due_date ? ` · Livraison ${ddmm(p.due_date)}` : ''}</span><b style="color:${p.slack.color}" class="t13">${p.slack.text}</b>${p.portal_state === 'open' ? pill('ok', 'Visible sur le portail client') : ''}${p.status === 'termine' ? pill('no', 'Terminé') : ''}</div></div>
<div class="push line"><a class="btn alt" href="#photos">Ajouter une photo</a><a class="btn alt" href="/atelier">Ouvrir sur tablette</a><a class="btn" href="/carnets/${p.id}">Ouvrir le carnet</a></div></div>

<section class="card mt20" aria-label="Avancement">
<div class="frise-big">${p.frise.map((f) => h`<details class="fz ${f.state}"><summary><span class="fz-dot"></span><b>${f.phase}</b><span class="mut t12">${f.label}</span></summary>
<form method="post" action="/projets/${p.id}/phase" class="pop"><input type="hidden" name="phase" value="${f.phase}">
<label>État <select name="state">${options([['auto', 'Automatique'], ['d', 'Fait'], ['c', 'En cours'], ['p', 'Bloque'], ['w', 'À venir'], ['n', 'Sans objet']], 'auto')}</select></label>
<label>Texte <input name="label" placeholder="${f.label}"></label><button class="btn sm">OK</button></form></details>`)}</div>
<p class="mut t12 mt8">La frise se calcule toute seule depuis les fiches du carnet, les plans, l’acompte et les poses. Clique une étape pour la forcer à la main.</p>
</section>

${issues.map((s) => {
    const ph = s.photo_id ? q.get('SELECT file FROM photos WHERE id = ?', s.photo_id) : null;
    return h`<section class="card danger mt20" id="probleme"><div class="line">${ph ? h`<a href="${fileUrl(ph.file)}"><img class="thumb" src="${fileUrl(ph.file)}" alt="Photo jointe"></a>` : ''}<div class="grow"><b>Problème signalé · ${s.body}</b><div class="mut">${pm[s.person_id]?.name || ''} · ${rel(s.created_at)}${ph ? ' · photo jointe' : ''}</div></div></div>
<form method="post" action="/projets/${p.id}/probleme/${s.id}" class="line mt12"><label class="sr" for="rep${s.id}">Réponse</label><input id="rep${s.id}" class="qin" name="reply" placeholder="Ta réponse, elle s’affiche sur l’iPad" value="${s.reply}"><button class="btn alt" name="act" value="reply">Répondre</button><button class="btn" name="act" value="close">Marquer traité</button></form></section>`;
  })}

<div class="cols mt20">
<div class="main-col">
<section class="card"><div class="line"><h2>Pièces du projet</h2></div>
${pieces.map((x, i) => h`<details class="row${i ? '' : ' f'}"><summary class="line grow"><div class="grow"><b>${x.name}</b><span class="mut">${x.descr}</span></div>${x.status ? pill('no', x.status) : ''}${avatar(pm[x.who_id], 28)}</summary>
<form method="post" action="/projets/${p.id}/pieces/${x.id}" class="form grid2 mt8"><label>Nom <input name="name" value="${x.name}"></label><label>Description <input name="descr" value="${x.descr}"></label>
<label>État <input name="status" value="${x.status}" placeholder="ex. Finition 2/3"></label><label>Qui <select name="who_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.name]), x.who_id)}</select></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Retirer</button></div></form></details>`)}
<details class="mt12"><summary class="btn alt sm">+ Pièce</summary><form method="post" action="/projets/${p.id}/pieces" class="form grid2 mt8"><label>Nom <input name="name" required></label><label>Description <input name="descr"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card"><div class="line"><h2>Plans</h2></div>
${plans.map((x, i) => h`<div class="row${i ? '' : ' f'}"><div class="grow"><b>${x.version}${x.descr ? ` · ${x.descr}` : ''}</b><span class="mut">${x.status === 'validee' ? `Validée${x.validated_at ? ` le ${ddmm(x.validated_at)}` : ''} · fait foi pour l'atelier` : x.status === 'archivee' ? `${ddmm(x.created_at)} · remplacée` : `${ddmm(x.created_at)} · à valider`}</span></div>
${pill(x.status === 'validee' ? 'ok' : 'no', x.status === 'validee' ? 'Validée' : x.status === 'archivee' ? 'Archivée' : 'Brouillon')}
${x.file ? h`<a class="btn alt sm" href="${fileUrl(x.file)}" target="_blank">Ouvrir</a>` : ''}
${x.status === 'brouillon' ? postBtn(`/projets/${p.id}/plans/${x.id}/valider`, 'Valider', 'btn sm') : ''}</div>`)}
<details class="mt12"><summary class="btn alt sm">+ Nouvelle version</summary>
<form method="post" action="/projets/${p.id}/plans" enctype="multipart/form-data" class="form grid2 mt8"><label>Version <input name="version" value="V${plans.length + 1}" required></label><label>Ce qui change <input name="descr"></label><label>Fichier (PDF ou image) <input type="file" name="file" accept="application/pdf,image/*"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card" id="photos"><h2>Journal de fabrication</h2><p class="mut">Tu choisis ce que le client voit sur son portail, et ce que tu peux publier.</p>
<form method="post" action="/projets/${p.id}/photos" enctype="multipart/form-data" class="line mt12"><label class="sr" for="ph">Photo</label><input id="ph" type="file" name="photo" accept="image/*" required><input class="qin" name="title" placeholder="Légende"><button class="btn sm">Ajouter</button></form>
<div class="photos mt12">${photos.map((x) => h`<figure class="ph">${isImage(x.file) ? h`<a href="${fileUrl(x.file)}" target="_blank"><img src="${fileUrl(x.file)}" alt="${x.title}" loading="lazy"></a>` : h`<a href="${fileUrl(x.file)}">Fichier</a>`}
<figcaption><b>${x.title || 'Photo'}</b><span class="mut t12">${ddmm(x.created_at)} · ${pm[x.person_id]?.name || ''}</span>
<form method="post" action="/projets/${p.id}/photos/${x.id}" class="ckrow"><label><input type="checkbox" name="shared_client" value="1" ${x.shared_client ? 'checked' : ''} data-auto> Partagée au client</label><label><input type="checkbox" name="publishable" value="1" ${x.publishable ? 'checked' : ''} data-auto> Publiable</label></form></figcaption></figure>`)}
${photos.length ? '' : h`<p class="mut">Pas encore de photo. L’atelier en ajoute depuis l’iPad.</p>`}</div>
</section>
</div>

<aside class="side-col">
<section class="card"><h2>Temps passé</h2><p class="mut">Déclaré en un tap quand une fiche est finie.</p>
${time.map((t, i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${t.g}</span><b>${t.h ? hoursLabel(t.h) : 'en cours'}</b></div>`)}
<div class="who"><b class="grow">Total à ce jour</b><b>${hoursLabel(total)}</b></div></section>

<section class="card" id="acompte"><h2>Projet</h2>
<form method="post" action="/projets/${p.id}/infos" class="form">
<label>Nom <input name="name" value="${p.name}"></label>
<label>Échéance (livraison) <input type="date" name="due_date" value="${p.due_date || ''}"></label>
<label>Responsable <select name="lead_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.role === 'patron' ? 'Toi' : pp.name]), p.lead_id)}</select></label>
<label>Prochaine action (vide = automatique) <input name="next_action" value="${p.next_action}"></label>
${p.client_id ? h`<label class="ck"><input type="checkbox" name="deposit_needed" value="1" ${p.deposit_needed ? 'checked' : ''}> Acompte demandé</label>
<label>Acompte reçu le <input type="date" name="deposit_at" value="${p.deposit_at ? p.deposit_at.slice(0, 10) : ''}"></label>` : ''}
<label>Bois <textarea name="wood" rows="2">${p.wood}</textarea></label>
<label>Notes <textarea name="notes" rows="4">${p.notes}</textarea></label>
<button class="btn sm">Enregistrer</button></form>
<div class="line mt12">${p.status === 'en_cours' ? postBtn(`/projets/${p.id}/statut`, 'Marquer terminé', 'btn alt sm', { status: 'termine' }, 'Marquer ce projet comme terminé ?') : postBtn(`/projets/${p.id}/statut`, 'Reprendre', 'btn alt sm', { status: 'en_cours' })}</div>
</section>

${p.client_id ? h`<section class="card"><div class="line"><h2>Portail client</h2>${pill(p.portal_state === 'open' ? 'ok' : 'no', p.portal_state === 'open' ? 'Ouvert' : p.portal_state === 'cut' ? 'Accès coupé' : 'Pas ouvert')}</div>
<p class="mut">Ce que ${p.client.name} voit dans son espace. Tout part tout seul, sauf la date de pose.</p>
<div class="who f"><span class="grow">Devis</span><b>${quote ? `Accepté le ${ddmm(quote.accepted_at)}` : '—'}</b></div>
<div class="who"><span class="grow">Acompte</span><b>${p.deposit_at ? `Reçu le ${ddmm(p.deposit_at)}` : 'Attendu'}</b></div>
<form method="post" action="/projets/${p.id}/infos" class="who"><label class="grow" for="rd">Prête à poser vers le</label><input id="rd" type="date" name="ready_date" value="${p.ready_date || ''}" data-auto><input type="hidden" name="only" value="ready_date"></form>
<div class="who"><span class="grow">Photos partagées</span><b>${shared} sur ${photos.length}</b></div>
<div class="line mt12"><a class="btn alt sm" href="/portails#p${p.id}">Gérer le portail</a></div></section>` : ''}

<section class="card"><h2>Documents</h2><p class="mut">Devis accepté, PV, facture… Cochés « client », ils s’affichent dans son espace.</p>
${docs.map((d) => h`<div class="row"><a class="grow" href="${fileUrl(d.file)}" target="_blank">${d.title}</a>
<form method="post" action="/projets/${p.id}/documents/${d.id}" class="ckrow"><label><input type="checkbox" name="visible_client" value="1" ${d.visible_client ? 'checked' : ''} data-auto> Client</label></form></div>`)}
<form method="post" action="/projets/${p.id}/documents" enctype="multipart/form-data" class="form mt12"><label>Titre <input name="title" required placeholder="ex. Facture de solde"></label><input type="file" name="file" required accept="application/pdf,image/*"><label class="ck"><input type="checkbox" name="visible_client" value="1"> Visible par le client</label><button class="btn alt sm">Ajouter</button></form>
</section>
</aside></div>`;
  res.send(layout({ title: p.name, tab: 'projets', sub: '/projets', body, flash: req.flash }));
});

r.post('/projets/:id/phase', loadProject, (req, res) => {
  const { phase, state, label } = req.body;
  if (!PHASES.includes(phase)) return res.redirect(`/projets/${req.project.id}`);
  if (state === 'auto') q.run('DELETE FROM phase_overrides WHERE project_id = ? AND phase = ?', req.project.id, phase);
  else q.run('INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, ?, ?, ?)', req.project.id, phase, state, str(label));
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/projets/:id/infos', loadProject, (req, res) => {
  const b = req.body, p = req.project;
  if (b.only === 'ready_date') {
    q.run('UPDATE projects SET ready_date = ? WHERE id = ?', str(b.ready_date) || null, p.id);
    return res.flashTo(`/projets/${p.id}`, 'Date « prête à poser » mise à jour sur le portail.');
  }
  const depositAt = str(b.deposit_at) || null;
  tx(() => {
    q.run('UPDATE projects SET name = ?, due_date = ?, lead_id = ?, next_action = ?, wood = ?, notes = ?, deposit_needed = ?, deposit_at = ? WHERE id = ?',
      str(b.name) || p.name, str(b.due_date) || null, int(b.lead_id), str(b.next_action), str(b.wood), str(b.notes), p.client_id ? (b.deposit_needed ? 1 : 0) : 0, depositAt, p.id);
    // Acompte reçu : les achats qui l'attendaient se débloquent.
    if (depositAt && !p.deposit_at) q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
  });
  res.flashTo(`/projets/${p.id}`, depositAt && !p.deposit_at ? 'Acompte noté. Les achats bloqués sont débloqués.' : 'Enregistré.');
});

r.post('/projets/:id/statut', loadProject, (req, res) => {
  const st = req.body.status === 'termine' ? 'termine' : 'en_cours';
  q.run("UPDATE projects SET status = ?, finished_at = CASE WHEN ? = 'termine' THEN datetime('now') ELSE NULL END WHERE id = ?", st, st, req.project.id);
  res.flashTo(`/projets/${req.project.id}`, st === 'termine' ? 'Projet terminé.' : 'Projet repris.');
});

r.post('/projets/:id/probleme/:iid', loadProject, (req, res) => {
  if (req.body.act === 'close') q.run("UPDATE issues SET status = 'closed', reply = ? WHERE id = ? AND project_id = ?", str(req.body.reply), req.params.iid, req.project.id);
  else q.run('UPDATE issues SET reply = ? WHERE id = ? AND project_id = ?', str(req.body.reply), req.params.iid, req.project.id);
  res.flashTo(`/projets/${req.project.id}`, req.body.act === 'close' ? 'Problème traité.' : 'Réponse envoyée sur l’iPad.');
});

r.post('/projets/:id/pieces', loadProject, (req, res) => {
  q.run('INSERT INTO pieces (project_id, name, descr) VALUES (?, ?, ?)', req.project.id, str(req.body.name), str(req.body.descr));
  res.redirect(`/projets/${req.project.id}`);
});
r.post('/projets/:id/pieces/:pid', loadProject, (req, res) => {
  const b = req.body;
  if (b.del) q.run('DELETE FROM pieces WHERE id = ? AND project_id = ?', req.params.pid, req.project.id);
  else q.run('UPDATE pieces SET name = ?, descr = ?, status = ?, who_id = ? WHERE id = ? AND project_id = ?', str(b.name), str(b.descr), str(b.status), int(b.who_id), req.params.pid, req.project.id);
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/projets/:id/plans', loadProject, upload.single('file'), (req, res) => {
  q.run('INSERT INTO plans (project_id, version, descr, file) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.version), str(req.body.descr), req.file ? req.file.filename : null);
  res.flashTo(`/projets/${req.project.id}`, 'Plan ajouté. Valide-le quand il fait foi pour l’atelier.');
});
r.post('/projets/:id/plans/:pid/valider', loadProject, (req, res) => {
  tx(() => {
    q.run("UPDATE plans SET status = 'archivee' WHERE project_id = ? AND status = 'validee'", req.project.id);
    q.run("UPDATE plans SET status = 'validee', validated_at = datetime('now') WHERE id = ? AND project_id = ?", req.params.pid, req.project.id);
    q.run("DELETE FROM phase_overrides WHERE project_id = ? AND phase = 'Conception'", req.project.id);
  });
  res.flashTo(`/projets/${req.project.id}`, 'Plan validé : c’est lui qui fait foi pour l’atelier.');
});

r.post('/projets/:id/photos', loadProject, upload.single('photo'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}#photos`, 'Format de fichier non reconnu.', 'ko');
  const me = L.patron();
  q.run('INSERT INTO photos (project_id, file, title, person_id) VALUES (?, ?, ?, ?)', req.project.id, req.file.filename, str(req.body.title), me.id);
  res.flashTo(`/projets/${req.project.id}#photos`, 'Photo ajoutée au journal.');
});
r.post('/projets/:id/photos/:pid', loadProject, (req, res) => {
  q.run('UPDATE photos SET shared_client = ?, publishable = ? WHERE id = ? AND project_id = ?', req.body.shared_client ? 1 : 0, req.body.publishable ? 1 : 0, req.params.pid, req.project.id);
  res.redirect(`/projets/${req.project.id}#photos`);
});

r.post('/projets/:id/documents', loadProject, upload.single('file'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}`, 'Fichier refusé (PDF ou image).', 'ko');
  q.run('INSERT INTO documents (project_id, title, file, visible_client) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.title), req.file.filename, req.body.visible_client ? 1 : 0);
  res.flashTo(`/projets/${req.project.id}`, 'Document ajouté.');
});
r.post('/projets/:id/documents/:did', loadProject, (req, res) => {
  q.run('UPDATE documents SET visible_client = ? WHERE id = ? AND project_id = ?', req.body.visible_client ? 1 : 0, req.params.did, req.project.id);
  res.redirect(`/projets/${req.project.id}`);
});

module.exports = r;
module.exports.loadProject = loadProject;
module.exports.friseBar = friseBar;
