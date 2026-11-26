'use strict';
// Planning par personne, livraisons et poses, PV de réception signé sur l'iPad.
const express = require('express');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { q, tx, UPLOAD_DIR, logActivity } = require('../db');
const { h, layout, pill, avatar, postBtn, options, ddmm, ddmmyyyy, today, addDays, parseDate, iso, JOURS_C, MOIS_C, printPage } = require('../html');
const L = require('../logic');
const { loadProject } = require('./patron');

const r = express.Router();
const str = (v) => String(v ?? '').trim();

function monday(s) { const d = parseDate(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); }
function workdaysFrom(start, weeks) { const out = []; let d = start; while (out.length < weeks * 5) { const w = parseDate(d).getDay(); if (w !== 0 && w !== 6) out.push(d); d = addDays(d, 1); } return out; }

r.get('/planning', (req, res) => {
  const weeks = [1, 2, 4].includes(Number(req.query.semaines)) ? Number(req.query.semaines) : 2;
  const start = monday(/^\d{4}-\d{2}-\d{2}$/.test(req.query.du || '') ? req.query.du : today());
  const days = workdaysFrom(start, weeks);
  const end = days[days.length - 1];
  const col = (d) => { let i = days.findIndex((x) => x >= d); if (i < 0) i = days.length; return i + 2; };
  const span = (s, e) => { const a = Math.max(2, col(s)); let b = days.findIndex((x) => x > e); b = b < 0 ? days.length + 2 : b + 2; return [a, Math.max(a + 1, b)]; };
  const people = L.people();
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  const bars = q.all('SELECT bars.*, projects.name pname FROM bars LEFT JOIN projects ON projects.id = bars.project_id WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', end, start);
  const lanes = [
    ...people.map((p) => ({ key: `p${p.id}`, title: p.role === 'patron' ? 'Toi' : p.name, sub: p.sub, person: p,
      bars: bars.filter((b) => b.person_id === p.id).map((b) => (b.auto ? { ...b, kind: 'b1 autob', ro: `/carnets/${b.project_id}`, title: 'Planifié automatiquement depuis le carnet' } : b)) })),
    { key: 'sup', title: 'Livraisons fournisseur', sub: '', bars: q.all('SELECT orders.*, suppliers.name sname FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE expected_at BETWEEN ? AND ? AND arrived_at IS NULL', start, end).map((o) => ({ kind: 'ev', label: `Livraison ${o.sname || ''}`, detail: o.what, start_date: o.expected_at, end_date: o.expected_at, ro: '/commandes' })) },
    { key: 'pose', title: 'Poses et rendez-vous', sub: '', bars: [
      ...q.all('SELECT trips.*, projects.name pname FROM trips JOIN projects ON projects.id = trips.project_id WHERE date BETWEEN ? AND ?', start, end).map((t) => ({ kind: 'b3', label: t.pname, detail: [t.kind || t.what, t.team].filter(Boolean).join(' · '), start_date: t.date, end_date: t.date, ro: `/projets/${t.project_id}#livraisons` })),
      ...bars.filter((b) => b.lane === 'event'),
    ] },
  ];
  // Un rang par barre qui se chevauche, pour ne rien masquer.
  let row = 2;
  const grid = lanes.map((ln) => {
    const placed = []; const tracks = [];
    ln.bars.forEach((b) => {
      const [a, z] = span(b.start_date, b.end_date);
      let t = tracks.findIndex((endCol) => endCol <= a); if (t < 0) { t = tracks.length; tracks.push(0); }
      tracks[t] = z; placed.push({ ...b, a, z, t });
    });
    const n = Math.max(1, tracks.length);
    const out = { ...ln, row, n, placed };
    row += n; return out;
  });
  const prev = addDays(start, -7 * weeks), next = addDays(start, 7 * weeks);
  const t = today();
  const K = { work: 'b1', free: 'fr', blocked: 'bk', event: 'b3' };
  const barForm = (b = {}) => h`<label>Ligne <select name="lane">${options([...people.map((p) => [`p${p.id}`, p.role === 'patron' ? 'Toi' : p.name]), ['event', 'Poses et rendez-vous']], b.id ? (b.lane === 'event' ? 'event' : `p${b.person_id}`) : '')}</select></label>
<label>Projet <select name="project_id"><option value="">—</option>${options(projects.map((p) => [p.id, p.name]), b.project_id)}</select></label>
<label>Titre <input name="label" value="${b.label || ''}" placeholder="vide = nom du projet"></label>
<label>Détail <input name="detail" value="${b.detail || ''}" placeholder="ex. Bloqué : acompte attendu"></label>
<label>Type <select name="kind">${options([['work', 'Travail'], ['free', 'Temps libre à planifier'], ['blocked', 'Bloqué'], ['event', 'Rendez-vous / événement']], b.kind || 'work')}</select></label>
<div class="grid2"><label>Du <input type="date" name="start_date" value="${b.start_date || t}" required></label><label>Au <input type="date" name="end_date" value="${b.end_date || t}" required></label></div>`;
  const body = h`<div class="head"><div><div class="eb">Planning</div><h1>Atelier · ${Number(start.slice(8))} ${MOIS_C[Number(start.slice(5, 7)) - 1]} – ${Number(end.slice(8))} ${MOIS_C[Number(end.slice(5, 7)) - 1]}</h1></div>
<div class="push line"><a class="btn alt sm" href="/planning?du=${prev}&semaines=${weeks}" aria-label="Période précédente">‹</a><a class="btn alt sm" href="/planning?semaines=${weeks}">Aujourd'hui</a><a class="btn alt sm" href="/planning?du=${next}&semaines=${weeks}" aria-label="Période suivante">›</a>
<div class="seg">${[[1, 'Semaine'], [2, '2 semaines'], [4, 'Mois']].map(([w, l]) => h`<a href="/planning?du=${start}&semaines=${w}" class="${w === weeks ? 'on' : ''}">${l}</a>`)}</div></div></div>
<p class="mut mt8">Les barres bleues se posent toutes seules d'après les fiches envoyées à l'atelier et leurs heures : pour les changer, modifie le carnet. Ajoute à la main les rendez-vous, congés et blocages : le planning les contourne.</p>
<div class="tablebox mt12"><div class="plan" style="grid-template-columns: 190px repeat(${days.length}, minmax(${weeks === 4 ? 44 : 84}px, 1fr)); grid-template-rows: 44px repeat(${row - 2}, 58px)">
<div class="ph0">QUI</div>
${days.map((d, i) => h`<div class="phd${d === t ? ' td' : ''}" style="grid-column:${i + 2}">${JOURS_C[parseDate(d).getDay()].toUpperCase()} ${Number(d.slice(8))}${d === t ? h`<small>aujourd'hui</small>` : ''}</div>`)}
${grid.map((ln) => h`<div class="plane" style="grid-row:${ln.row} / span ${ln.n}">${ln.person ? avatar(ln.person, 30) : ''}<div><b>${ln.title}</b><span class="mut t12">${ln.sub}</span></div></div>
${days.map((d, i) => h`<div class="pcell${d === t ? ' td' : ''}" style="grid-column:${i + 2};grid-row:${ln.row} / span ${ln.n}"></div>`)}
${ln.placed.map((b) => b.ro ? h`<a class="pbar ${b.kind}" href="${b.ro}" title="${b.title || ''}" style="grid-column:${b.a} / ${b.z};grid-row:${ln.row + b.t}"><b>${b.label}</b><span>${b.detail}</span></a>`
    : h`<details class="pbar ${K[b.kind] || 'b1'}" style="grid-column:${b.a} / ${b.z};grid-row:${ln.row + b.t}"><summary><b>${b.label || b.pname}</b><span>${b.detail}</span></summary>
<form method="post" action="/planning/barres/${b.id}" class="pop form">${barForm(b)}<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Supprimer</button></div></form></details>`)}`)}
</div></div>
<div class="legend"><span><i class="c b1s"></i>Travail</span><span><i class="c bk"></i>Bloqué · la raison est écrite dessus</span><span><i class="c fr"></i>Temps libre à planifier</span><span><i class="c b3s"></i>Pose, rendez-vous</span></div>
<details class="card mt20" id="ajouter"><summary class="b">+ Ajouter une barre</summary><form method="post" action="/planning/barres" class="form grid2 mt12">${barForm()}<button class="btn sm">Ajouter</button></form></details>
<p class="mut t12 mt12">Une aide pour s'organiser, pas un engagement client.</p>`;
  res.send(layout({ title: 'Planning', tab: 'planning', sub: '/planning', body, flash: req.flash }));
});

function barValues(b) {
  const lane = String(b.lane || '');
  const person = lane.startsWith('p') ? Number(lane.slice(1)) : null;
  const pid = b.project_id ? Number(b.project_id) : null;
  const label = str(b.label) || (pid ? q.get('SELECT name FROM projects WHERE id = ?', pid)?.name : '') || 'Sans titre';
  let s = str(b.start_date), e = str(b.end_date) || s; if (e < s) [s, e] = [e, s];
  return [person, person ? 'person' : 'event', pid, label, str(b.detail), ['work', 'free', 'blocked', 'event'].includes(b.kind) ? b.kind : 'work', s, e];
}
r.post('/planning/barres', (req, res) => {
  const v = barValues(req.body);
  q.run('INSERT INTO bars (person_id, lane, project_id, label, detail, kind, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...v);
  res.redirect(`/planning?du=${v[6]}`);
});
r.post('/planning/barres/:id', (req, res) => {
  if (req.body.del) { q.run('DELETE FROM bars WHERE id = ?', req.params.id); return res.redirect('/planning'); }
  const v = barValues(req.body);
  q.run('UPDATE bars SET person_id = ?, lane = ?, project_id = ?, label = ?, detail = ?, kind = ?, start_date = ?, end_date = ? WHERE id = ?', ...v, req.params.id);
  res.redirect(`/planning?du=${v[6]}`);
});

// ---------- Livraisons et poses ----------
r.get('/poses', (req, res) => {
  const trips = q.all('SELECT trips.*, projects.name pname, projects.descr pdescr, projects.kind pkind FROM trips JOIN projects ON projects.id = trips.project_id WHERE pv_signed_at IS NULL ORDER BY date');
  const signed = q.all('SELECT trips.*, projects.name pname FROM trips JOIN projects ON projects.id = trips.project_id WHERE pv_signed_at IS NOT NULL ORDER BY pv_signed_at DESC LIMIT 10');
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  const tripForm = (t = {}) => h`<div class="grid2"><label>Projet <select name="project_id" required>${options(projects.map((p) => [p.id, p.name]), t.project_id)}</select></label><label>Date <input type="date" name="date" value="${t.date || ''}" required></label></div>
<label>Quoi <input name="what" value="${t.what || ''}" placeholder="ex. Livraison, montage des allonges, PV"></label>
<label>Où <input name="place" value="${t.place || ''}"></label><label>Accès <input name="access" value="${t.access || ''}" placeholder="ex. 3e étage sans ascenseur"></label>
<div class="grid2"><label>Contact <input name="contact" value="${t.contact || ''}"></label><label>Équipe <input name="team" value="${t.team || ''}" placeholder="ex. Lucas + toi · 4 h"></label></div>
<label>Dans le camion, un par ligne (vide = depuis la fiche « Pose » du carnet) <textarea name="items" rows="4">${t.items ? JSON.parse(t.items).map((i) => i.t).join('\n') : ''}</textarea></label>`;
  const body = h`<div class="head"><div><div class="eb">Planning</div><h1>Livraisons et poses</h1><p class="mut mt8">Tout ce qu'il faut savoir avant de charger le camion.</p></div>
<p class="mut push mw480">Les dates de livraison et de pose se décident dans la fiche de chaque projet (plusieurs dates possibles). Elles arrivent ici et dans le planning toutes seules.</p></div>
<div class="stack18 mt20">${trips.map((t) => {
    const items = JSON.parse(t.items); const n = items.filter((i) => i.done).length;
    const d = parseDate(t.date);
    return h`<section class="card trip"><div class="date"><span>${JOURS_C[d.getDay()].toUpperCase()}</span><b>${d.getDate()}</b><span>${MOIS_C[d.getMonth()]}</span></div>
<div class="grow"><div class="line"><h2>${t.pname}</h2>${pill('no', t.kind || t.pkind)}${t.pdescr ? h`<span class="mut">${t.pdescr}</span>` : ''}${pill(items.length && n === items.length ? 'ok' : 'wa', items.length && n === items.length ? 'Prêt à partir' : `${n} / ${items.length} prêts`)}${t.done_at ? pill('ok', 'Livré') : ''}</div>
<dl class="facts"><dt>Quoi</dt><dd>${t.what}</dd><dt>Où</dt><dd>${t.place}</dd><dt>Accès</dt><dd>${t.access}</dd><dt>Contact</dt><dd>${t.contact}</dd><dt>Équipe</dt><dd>${t.team}</dd></dl>
<div class="h3 mt12">Dans le camion</div><div class="chips">${items.map((it, i) => h`<form method="post" action="/poses/${t.id}/item" class="inline"><input type="hidden" name="i" value="${i}"><button class="chip${it.done ? ' on' : ''}" aria-pressed="${!!it.done}">${it.done ? '✓ ' : ''}${it.t}</button></form>`)}</div>
<div class="line mt12"><a class="btn alt sm" href="/projets/${t.project_id}#livraisons">Ouvrir le projet</a>${t.place ? h`<a class="btn alt sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.place)}">Itinéraire</a>` : ''}
<a class="btn sm" href="/poses/${t.id}/pv">PV de réception sur l'iPad</a><a class="btn alt sm" href="/poses/${t.id}/pv/imprimer">PV papier</a>
<details class="menu"><summary class="btn alt sm">Modifier</summary><form method="post" action="/poses/${t.id}" class="menu-list form pad wide">${tripForm(t)}<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Supprimer</button></div></form></details></div></div></section>`;
  })}
${trips.length ? '' : h`<section class="card"><p class="mut">Aucune livraison prévue.</p></section>`}
<section class="card"><h2>PV signés récemment</h2>
${signed.map((t, i) => h`<div class="row${i ? '' : ' f'}"><div class="grow"><b>${t.pname}</b><span class="mut">${ddmm(t.pv_signed_at)} · ${t.pv_reserves ? `réserve : ${t.pv_reserves}${t.pv_reserves_lifted_at ? ` · levée le ${ddmm(t.pv_reserves_lifted_at)}` : ''}` : 'sans réserve'}</span></div>
<a class="btn alt sm" href="/poses/${t.id}/pv/imprimer">Voir le PV</a>
${t.pv_reserves && !t.pv_reserves_lifted_at ? postBtn(`/poses/${t.id}/lever`, 'Réserve levée', 'btn alt sm') : ''}
${t.balance_paid_at ? pill('ok', 'Soldé') : postBtn(`/poses/${t.id}/solde`, 'Solde reçu', 'btn sm')}</div>`)}
${signed.length ? '' : h`<p class="mut">Aucun PV signé pour l'instant.</p>`}
<p class="mut mt8">Le PV signé part dans le projet et sur le portail client.</p></section></div>`;
  res.send(layout({ title: 'Livraisons et poses', tab: 'planning', sub: '/poses', body, flash: req.flash }));
});

function tripValues(b) {
  let items = str(b.items).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!items.length) {
    const pose = q.get("SELECT checks FROM steps WHERE project_id = ? AND (phase = 'Livraison' OR geste = 'Pose' OR title LIKE '%pose%') ORDER BY ord DESC LIMIT 1", b.project_id);
    items = pose ? JSON.parse(pose.checks).map((c) => c.t) : [];
    items.push('iPad chargé pour le PV');
  }
  return { items, vals: [Number(b.project_id), str(b.date), str(b.what), str(b.place), str(b.access), str(b.contact), str(b.team)] };
}
r.post('/poses', (req, res) => {
  const { items, vals } = tripValues(req.body);
  q.run('INSERT INTO trips (project_id, date, what, place, access, contact, team, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...vals, JSON.stringify(items.map((t) => ({ t, done: false }))));
  if (vals[0] && vals[1]) require('../sms').notify('rdv', { projectId: vals[0], date: require('../html').ddmm(vals[1]), titre: 'livraison et pose chez vous' });
  res.flashTo('/poses', 'Livraison ajoutée. Elle apparaît dans le planning et sur la frise du projet.');
});
r.post('/poses/:id', (req, res) => {
  if (req.body.del) { q.run('DELETE FROM trips WHERE id = ?', req.params.id); return res.redirect('/poses'); }
  const old = q.get('SELECT items FROM trips WHERE id = ?', req.params.id);
  const done = Object.fromEntries(JSON.parse(old?.items || '[]').map((i) => [i.t, i.done]));
  const { items, vals } = tripValues(req.body);
  q.run('UPDATE trips SET project_id = ?, date = ?, what = ?, place = ?, access = ?, contact = ?, team = ?, items = ? WHERE id = ?', ...vals, JSON.stringify(items.map((t) => ({ t, done: !!done[t] }))), req.params.id);
  res.redirect('/poses');
});
r.post('/poses/:id/item', (req, res) => {
  const t = q.get('SELECT items FROM trips WHERE id = ?', req.params.id);
  if (t) { const it = JSON.parse(t.items); const i = Number(req.body.i); if (it[i]) it[i].done = !it[i].done; q.run('UPDATE trips SET items = ? WHERE id = ?', JSON.stringify(it), req.params.id); }
  res.redirect('/poses');
});
r.post('/poses/:id/lever', (req, res) => { q.run("UPDATE trips SET pv_reserves_lifted_at = datetime('now') WHERE id = ?", req.params.id); res.redirect('/poses'); });
r.post('/poses/:id/solde', (req, res) => { q.run("UPDATE trips SET balance_paid_at = datetime('now') WHERE id = ?", req.params.id); res.redirect('/poses'); });

// PV imprimable : signé (copie) ou vierge (à faire signer sur papier).
r.get('/poses/:id/pv/imprimer', (req, res) => {
  const t = q.get('SELECT trips.*, projects.name pname, projects.ref pref, clients.name cname, clients.address caddr FROM trips JOIN projects ON projects.id = trips.project_id LEFT JOIN clients ON clients.id = projects.client_id WHERE trips.id = ?', req.params.id);
  if (!t) return res.redirect('/poses');
  const quote = q.get("SELECT number, version FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", t.project_id);
  const signed = !!t.pv_signed_at;
  res.send(printPage('Procès-verbal de réception', h`
<table><tr><td><b>Maître d’ouvrage (client)</b><br>${t.cname || '—'}${t.caddr ? h`<br>${t.caddr}` : ''}</td><td><b>Ouvrage</b><br>${t.pname}${quote ? h`<br>Devis ${quote.number} v${quote.version}` : ''}</td><td><b>Lieu</b><br>${t.place || '—'}</td></tr></table>
<p style="margin-top:18px">Le maître d’ouvrage, après avoir visité l’ouvrage désigné ci-dessus en présence de l’entreprise, déclare :</p>
<p><span class="box${signed && !t.pv_reserves ? ' on' : ''}"></span> prononcer la réception <b>sans réserve</b></p>
<p><span class="box${signed && t.pv_reserves ? ' on' : ''}"></span> prononcer la réception <b>avec les réserves</b> suivantes :</p>
<div style="border:1px solid #D9D4CC;min-height:70px;padding:8px">${t.pv_reserves || ''}</div>
${t.pv_reserves_lifted_at ? h`<p>Réserves levées le ${ddmmyyyy(t.pv_reserves_lifted_at)}.</p>` : ''}
<p style="margin-top:14px">Fait le ${signed ? ddmmyyyy(t.pv_signed_at) : '____ / ____ / ________'}${signed ? '' : ', à ________________________'}.</p>
<div class="sign"><div>Le client${signed ? h` : <b>${t.pv_name}</b>` : ''}<br>${signed && t.pv_signature ? h`<img src="/fichiers/${t.pv_signature}" alt="Signature" style="max-height:90px">` : 'Signature'}</div><div>L’entreprise<br>Signature</div></div>`,
  { ref: t.pref, date: signed ? ddmmyyyy(t.pv_signed_at) : ddmmyyyy(t.date) }));
});

// PV de réception, à faire signer au client sur l'iPad.
r.get('/poses/:id/pv', (req, res) => {
  const t = q.get('SELECT trips.*, projects.name pname, projects.client_id, clients.name cname FROM trips JOIN projects ON projects.id = trips.project_id LEFT JOIN clients ON clients.id = projects.client_id WHERE trips.id = ?', req.params.id);
  if (!t) return res.redirect('/poses');
  const body = t.pv_signed_at ? h`<div class="eb"><a href="/poses">Livraisons et poses</a></div><h1>PV de réception · ${t.pname}</h1>
<section class="card mt20 mw680"><p>Réception prononcée le <b>${ddmm(t.pv_signed_at)}</b> par <b>${t.pv_name}</b>, ${t.pv_reserves ? h`avec la réserve suivante : « ${t.pv_reserves} »` : 'sans réserve'}.</p>
${t.pv_signature ? h`<img src="/fichiers/${t.pv_signature}" alt="Signature du client" class="sig-img">` : ''}</section>`
    : h`<div class="eb"><a href="/poses">Livraisons et poses</a></div><h1>PV de réception · ${t.pname}</h1>
<form method="post" action="/poses/${t.id}/pv" class="card form mt20 mw680" id="pvform">
<p>Je soussigné(e) déclare réceptionner l'ouvrage « ${t.pname} » livré par Carchon Les Ateliers le ${ddmm(today())}.</p>
<label>Nom du client <input name="name" value="${t.cname || ''}" required></label>
<fieldset><legend>Réception</legend><label class="ck"><input type="radio" name="res" value="0" checked> Sans réserve</label><label class="ck"><input type="radio" name="res" value="1"> Avec réserve(s)</label></fieldset>
<label>Réserves éventuelles <textarea name="reserves" rows="3"></textarea></label>
<div><span class="b">Signature du client</span><canvas id="sig" class="sig" width="600" height="220" aria-label="Zone de signature"></canvas><button type="button" class="btn alt sm" id="sigclear">Effacer</button></div>
<input type="hidden" name="signature" id="sigdata">
<button class="btn">Signer le PV</button></form>`;
  res.send(layout({ title: 'PV de réception', tab: 'planning', sub: '/poses', body, flash: req.flash }));
});
r.post('/poses/:id/pv', (req, res) => {
  const t = q.get('SELECT * FROM trips WHERE id = ?', req.params.id);
  if (!t || t.pv_signed_at) return res.redirect('/poses');
  let sig = null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.signature || ''));
  if (m) { sig = crypto.randomBytes(12).toString('hex') + '.png'; fs.writeFileSync(`${UPLOAD_DIR}/${sig}`, Buffer.from(m[1], 'base64')); }
  const reserves = req.body.res === '1' ? str(req.body.reserves) || 'réserve sans précision' : '';
  // Le PV apparaît ensuite dans le projet et dans l'espace du client (rubrique Documents).
  logActivity(t.project_id, null, `PV de réception signé par ${str(req.body.name)}${reserves ? ` avec réserve : ${reserves}` : ', sans réserve'}`, 'Patron');
  q.run("UPDATE trips SET pv_signed_at = datetime('now'), done_at = COALESCE(done_at, datetime('now')), pv_name = ?, pv_reserves = ?, pv_signature = ? WHERE id = ?", str(req.body.name), reserves, sig, t.id);
  res.flashTo('/poses', 'PV signé et rangé dans le projet. Pense à facturer le solde.');
});

module.exports = r;
void loadProject;
