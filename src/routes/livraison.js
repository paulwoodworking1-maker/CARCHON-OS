'use strict';
// Livrer et garantir : contrôle qualité, registre des pièces, expéditions, SAV.
const express = require('express');
const { q, tx, logActivity, company } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, ddmmyyyy, today, hoursLabel, printPage } = require('../html');
const { fileUrl, isImage } = require('../uploads');
const P = require('../production');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const DEFAULT_CHECKS = ['Aspect du bois et teinte', 'Ponçage en lumière rasante', 'Assemblages et stabilité', 'Quincaillerie et réglages', 'Numéro marqué sur la pièce'];
const SAV_STEPS = [['recue', 'Reçue'], ['diagnostic', 'Diagnostic'], ['reparation', 'Réparation'], ['renvoyee', 'Renvoyée'], ['close', 'Close']];
const unitState = (u) => ({ a_faire: ['no', 'En fabrication'], en_stock: [u.reserved_for ? 'wa' : 'ok', u.reserved_for ? 'Réservée' : 'En stock'], expediee: ['wa', 'Expédiée'], livree: ['ok', 'Livrée'] })[u.status] || ['no', u.status];

function loadUnit(id) {
  return q.get(`SELECT units.*, models.name mname, models.code mcode, models.care, models.checks mchecks, projects.name pname, projects.ref pref, projects.for_whom, projects.id pid,
    wood_lots.code lcode, wood_lots.essence, wood_lots.thickness, wood_lots.origin FROM units LEFT JOIN models ON models.id = units.model_id
    LEFT JOIN projects ON projects.id = units.project_id LEFT JOIN wood_lots ON wood_lots.id = units.wood_lot_id WHERE units.id = ?`, id);
}

// ---------- Registre des pièces ----------
r.get('/unites', (req, res) => {
  const s = str(req.query.q);
  const rows = q.all(`SELECT units.*, models.name mname, projects.name pname FROM units LEFT JOIN models ON models.id = units.model_id LEFT JOIN projects ON projects.id = units.project_id
    WHERE (? = '' OR units.serial LIKE ? OR models.name LIKE ? OR projects.name LIKE ?) ORDER BY units.id DESC LIMIT 200`, s, `%${s}%`, `%${s}%`, `%${s}%`);
  const body = h`<section class="card" style="border-top:0;padding-top:0">
<form class="line" method="get"><label class="sr" for="us">Numéro</label><input id="us" class="qin" name="q" value="${s}" placeholder="Numéro de pièce, modèle ou dossier"><button class="btn">Chercher</button></form>
<p class="mut mt8">Chaque pièce a un numéro dès son lancement : il relie son bois, ses fiches, son contrôle, son expédition et son SAV.</p>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>Numéro</th><th>Pièce</th><th>État</th><th>Contrôlée</th></tr></thead><tbody>
${rows.map((u) => { const [c, l] = unitState(u); return h`<tr><td><a class="b" href="/unites/${u.id}">${u.serial}</a></td><td>${u.mname || u.pname || ''}</td><td>${pill(c, l)}</td><td class="mut">${u.controlled_at ? ddmm(u.controlled_at) : '—'}</td></tr>`; })}
${rows.length ? '' : h`<tr><td colspan="4" class="mut">Aucune pièce.</td></tr>`}</tbody></table></div></section>`;
  res.send(layout({ title: 'Registre des pièces', heading: 'Qualité et SAV', tab: 'sav', sub: '/unites', body, flash: req.flash }));
});

r.get('/unites/:id', (req, res) => {
  const u = loadUnit(req.params.id);
  if (!u) return res.redirect('/unites');
  const pm = L.peopleMap();
  const steps = u.pid ? q.all("SELECT * FROM steps WHERE project_id = ? AND status = 'done' ORDER BY done_at", u.pid) : [];
  const ship = u.shipment_id ? q.get('SELECT * FROM shipments WHERE id = ?', u.shipment_id) : null;
  const savs = q.all('SELECT * FROM sav WHERE unit_id = ? ORDER BY created_at DESC', u.id);
  const photos = u.pid ? q.all('SELECT * FROM photos WHERE project_id = ? ORDER BY created_at DESC LIMIT 4', u.pid) : [];
  const until = P.warrantyUntil(u);
  const checks = JSON.parse(u.checks || '[]');
  const toCheck = JSON.parse(u.mchecks || '[]').length ? JSON.parse(u.mchecks) : DEFAULT_CHECKS;
  const [c, l] = unitState(u);
  const life = [
    { d: u.created_at, t: `Lancée${u.pref ? ` dans ${u.pref}` : ''}`, s: u.lcode ? `Bois : lot ${u.lcode} · ${u.essence} ${u.thickness}` : '' },
    ...steps.map((s) => ({ d: s.done_at, t: s.title, s: `${pm[s.who_id]?.name || ''}${s.declared_label ? ' · ' + s.declared_label : ''}` })),
    u.controlled_at && { d: u.controlled_at, t: 'Contrôlée', s: `${checks.length} point(s) vérifié(s) · ${pm[u.controlled_by]?.name || ''}` },
    ship?.shipped_at && { d: ship.shipped_at, t: 'Expédiée', s: [ship.recipient, ship.carrier, ship.tracking].filter(Boolean).join(' · ') },
    ship?.delivered_at && { d: ship.delivered_at, t: 'Livrée', s: '' },
    ...savs.map((x) => ({ d: x.created_at, t: 'Demande SAV', s: x.body })),
  ].filter(Boolean).sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const body = h`
<div class="line" style="margin-top:-6px"><div class="grow"><div class="eb" style="display:block">Registre des pièces</div><div style="font-size:28px;font-weight:700;margin-top:4px">${u.serial} · ${u.mname || u.pname || ''}</div></div>
${pill(c, l)}${until ? pill(until >= today() ? 'ok' : 'no', until >= today() ? `Sous garantie jusqu'au ${ddmmyyyy(until)}` : 'Hors garantie') : ''}
${u.pid ? h`<a class="btn alt sm" href="/projets/${u.pid}">Voir l'OF</a>` : ''}<a class="btn alt sm" href="/sav?nouveau=1&serial=${encodeURIComponent(u.serial)}">Demande SAV</a></div>
<div class="cols">
<section class="card side-col"><h2>Identité</h2>
${photos[0] && isImage(photos[0].file) ? h`<img src="${fileUrl(photos[0].file)}" alt="Photo de la pièce" style="width:100%;height:220px;object-fit:cover;margin-top:8px">` : ''}
<table class="tbl mt8"><tbody>
<tr><td class="mut">Numéro</td><td class="b">${u.serial}</td></tr>
<tr><td class="mut">Modèle</td><td>${u.mname || 'Sur-mesure'}</td></tr>
<tr><td class="mut">Bois</td><td>${u.lcode ? `${u.essence} ${u.thickness} · lot ${u.lcode}${u.origin ? ' · ' + u.origin : ''}` : '—'}</td></tr>
<tr><td class="mut">OF</td><td>${u.pref ? `${u.pref} · ${u.pname}` : '—'}</td></tr>
<tr><td class="mut">Pour</td><td>${u.reserved_for || u.for_whom || '—'}</td></tr>
</tbody></table></section>
<section class="card main-col"><h2>Vie de la pièce</h2>
<ol class="timeline mt8">${life.map((e) => h`<li><time>${ddmm(e.d)}</time><span><b>${e.t}</b>${e.s ? h`<span class="mut t13" style="display:block">${e.s}</span>` : ''}</span></li>`)}</ol>
</section></div>
${u.status === 'a_faire' ? h`<section class="card warm" id="controle"><h2>Contrôle avant « prête »</h2><form method="post" action="/unites/${u.id}/controle" class="form mt12">
${toCheck.map((t) => h`<label class="ck"><input type="checkbox" name="checks" value="${t}" required> ${t}</label>`)}
<button class="btn">Pièce contrôlée : en stock fini</button></form></section>`
    : h`<section class="card"><h2>Contrôle</h2>${checks.map((t) => h`<div class="row">✓ ${t}</div>`)}${checks.length ? '' : h`<p class="mut">—</p>`}</section>`}
${savs.length ? h`<section class="card"><h2>SAV</h2>${savs.map((x) => h`<div class="row"><span class="grow"><b>${x.body}</b><span class="mut t12" style="display:block">reçue le ${ddmm(x.created_at)}</span></span>${pill(x.status === 'close' ? 'ok' : 'ko', SAV_STEPS.find((s) => s[0] === x.status)[1])}<a class="btn alt sm" href="/sav#s${x.id}">Ouvrir</a></div>`)}</section>` : ''}`;
  res.send(layout({ title: `Pièce ${u.serial}`, heading: 'Qualité et SAV', tab: 'sav', sub: '/unites', body, flash: req.flash }));
});

r.post('/unites/:id/controle', (req, res) => {
  const u = loadUnit(req.params.id);
  if (!u) return res.redirect('/unites');
  const checks = [].concat(req.body.checks || []).map(str).filter(Boolean);
  const me = L.patron();
  q.run("UPDATE units SET status = 'en_stock', checks = ?, controlled_at = datetime('now'), controlled_by = ? WHERE id = ?", JSON.stringify(checks), me.id, u.id);
  if (u.pid) logActivity(u.pid, me.id, `Pièce ${u.serial} contrôlée (${checks.length} points) : en stock fini`, 'Patron');
  const next = u.pid && q.get("SELECT id FROM units WHERE project_id = ? AND status = 'a_faire' ORDER BY serial LIMIT 1", u.pid);
  res.flashTo(next ? `/unites/${next.id}#controle` : `/unites/${u.id}`, `Pièce ${u.serial} en stock fini.${next ? ' Pièce suivante du lot :' : ''}`);
});
r.post('/unites/:id/reserver', (req, res) => {
  q.run('UPDATE units SET reserved_for = ? WHERE id = ?', str(req.body.reserved_for), req.params.id);
  res.redirect(req.get('referer')?.includes('/pieces') ? '/pieces' : `/unites/${req.params.id}`);
});
// Contrôle final d'un OF sur-mesure : la pièce reçoit le numéro du dossier.
r.post('/projets/:id/controle', (req, res) => {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.redirect('/projets');
  const u = q.get("SELECT * FROM units WHERE project_id = ? AND status = 'a_faire' ORDER BY serial LIMIT 1", p.id) || P.ensureUnitForProject(p);
  res.redirect(`/unites/${u.id}#controle`);
});

// ---------- Expéditions ----------
r.get('/expeditions', (req, res) => {
  const ready = q.all(`SELECT units.*, models.name mname, projects.name pname FROM units LEFT JOIN models ON models.id = units.model_id LEFT JOIN projects ON projects.id = units.project_id
    WHERE units.status = 'en_stock' ORDER BY units.reserved_for = '', units.reserved_for, units.serial`);
  const ships = q.all(`SELECT shipments.*, (SELECT GROUP_CONCAT(serial, ', ') FROM units WHERE shipment_id = shipments.id) serials, (SELECT COUNT(*) FROM units WHERE shipment_id = shipments.id) n
    FROM shipments ORDER BY delivered_at IS NOT NULL, shipped_at DESC LIMIT 40`);
  const enRoute = ships.filter((s) => s.shipped_at && !s.delivered_at);
  const body = h`
<section class="kpis" style="margin-top:-30px">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">À expédier</span>${pill('wa', 'réservées')}</div><div class="big">${ready.filter((u) => u.reserved_for).length}</div><div class="sub2">pièces prêtes avec un destinataire</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">En route</span>${pill('no', 'colis')}</div><div class="big">${enRoute.length}</div><div class="sub2">expéditions pas encore livrées</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Livrées</span>${pill('ok', '30 jours')}</div><div class="big">${q.get("SELECT COUNT(*) n FROM shipments WHERE delivered_at >= datetime('now', '-30 days')").n}</div><div class="sub2">expéditions</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Poses</span>${pill('no', 'à venir')}</div><div class="big">${q.get('SELECT COUNT(*) n FROM trips WHERE done_at IS NULL').n}</div><div class="sub2"><a href="/poses">livraisons et poses</a></div></div>
</section>
<div class="cols">
<section class="card main-col"><h2>Préparer une expédition</h2>
${ready.length ? h`<form method="post" action="/expeditions" class="form mt12">
${ready.map((u) => h`<label class="ck"><input type="checkbox" name="units" value="${u.id}"> <b>${u.serial}</b> ${u.mname || u.pname || ''} ${u.reserved_for ? pill('wa', u.reserved_for) : ''}</label>`)}
<div class="grid2"><label>Destinataire <input name="recipient" required></label><label>Adresse <input name="address"></label></div>
<div class="grid2"><label>Transporteur <input name="carrier" placeholder="ex. Colissimo, transporteur meubles…"></label><label>N° de suivi <input name="tracking"></label></div>
<label>Emballage <input name="packing" placeholder="ex. carton double cannelure, calage"></label>
<button class="btn">Expédier</button><p class="mut t12">Le bon de livraison, avec la fiche d'entretien de chaque pièce, s'imprime ensuite.</p></form>` : h`<p class="mut">Aucune pièce en stock fini. Les pièces y entrent au contrôle.</p>`}
</section>
<section class="card side-col"><h2>Expéditions</h2>
${ships.map((s, i) => h`<div class="who${i ? '' : ' f'}"><div class="grow"><b class="t14">${s.recipient || '—'}</b><span class="mut t12">${s.serials || ''} · ${[s.carrier, s.tracking].filter(Boolean).join(' · ')}</span><span class="mut t12">${s.delivered_at ? `livrée le ${ddmm(s.delivered_at)}` : `expédiée le ${ddmm(s.shipped_at)}`}</span></div>
<a class="btn alt sm" href="/expeditions/${s.id}/bon">Bon</a>${s.delivered_at ? pill('ok', 'Livrée') : postBtn(`/expeditions/${s.id}/livree`, 'Livrée', 'btn sm')}</div>`)}
${ships.length ? '' : h`<p class="mut">Aucune expédition.</p>`}</section></div>`;
  res.send(layout({ title: 'Expéditions', heading: 'Expéditions', tab: 'exp', sub: '/expeditions', body, flash: req.flash }));
});
r.post('/expeditions', (req, res) => {
  const ids = [].concat(req.body.units || []).map(Number).filter(Boolean);
  if (!ids.length) return res.flashTo('/expeditions', 'Coche au moins une pièce.', 'ko');
  const b = req.body;
  let sid;
  tx(() => {
    const first = q.get('SELECT project_id FROM units WHERE id = ?', ids[0]);
    sid = q.run("INSERT INTO shipments (project_id, recipient, address, carrier, tracking, packing, shipped_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      first?.project_id || null, str(b.recipient), str(b.address), str(b.carrier), str(b.tracking), str(b.packing)).lastInsertRowid;
    for (const id of ids) {
      q.run("UPDATE units SET status = 'expediee', shipment_id = ? WHERE id = ? AND status = 'en_stock'", sid, id);
      const u = q.get('SELECT serial, project_id FROM units WHERE id = ?', id);
      if (u?.project_id) logActivity(u.project_id, null, `Pièce ${u.serial} expédiée à ${str(b.recipient)}${str(b.tracking) ? ` (suivi ${str(b.tracking)})` : ''}`, 'Patron');
    }
  });
  res.flashTo('/expeditions', '', 'ok', { html: `Expédition enregistrée. <a href="/expeditions/${sid}/bon">Imprimer le bon de livraison</a>` });
});
r.post('/expeditions/:id/livree', (req, res) => {
  tx(() => {
    q.run("UPDATE shipments SET delivered_at = datetime('now') WHERE id = ?", req.params.id);
    q.run("UPDATE units SET status = 'livree' WHERE shipment_id = ?", req.params.id);
  });
  res.redirect('/expeditions');
});
r.get('/expeditions/:id/bon', (req, res) => {
  const s = q.get('SELECT * FROM shipments WHERE id = ?', req.params.id);
  if (!s) return res.redirect('/expeditions');
  const units = q.all('SELECT units.*, models.name mname, models.care FROM units LEFT JOIN models ON models.id = units.model_id WHERE shipment_id = ? ORDER BY serial', s.id);
  const ref = `BL-${String(s.shipped_at || s.created_at).slice(0, 4)}-${String(s.id).padStart(4, '0')}`;
  res.send(printPage('Bon de livraison', h`
<table><tr><td><b>Destinataire</b><br>${s.recipient}${s.address ? h`<br>${s.address}` : ''}</td><td><b>Expédiée le</b><br>${ddmmyyyy(s.shipped_at)}</td><td><b>Transport</b><br>${[s.carrier, s.tracking].filter(Boolean).join(' · ') || '—'}</td></tr></table>
<h2>Pièces</h2>
<table><thead><tr><th>Numéro</th><th>Pièce</th><th>Garantie</th></tr></thead><tbody>${units.map((u) => h`<tr><td><b>${u.serial}</b></td><td>${u.mname || ''}</td><td>${P.warrantyMonths()} mois à la livraison</td></tr>`)}</tbody></table>
${units.filter((u) => u.care).map((u) => h`<h2>Entretien · ${u.mname}</h2><p>${u.care}</p>`)}
<div class="sign"><div>Reçu en bon état · date et signature</div><div>Réserves éventuelles</div></div>`, { ref, date: ddmmyyyy(s.shipped_at) }));
});

// ---------- SAV ----------
r.get('/sav', (req, res) => {
  const rows = q.all(`SELECT sav.*, units.serial, models.name mname FROM sav LEFT JOIN units ON units.id = sav.unit_id LEFT JOIN models ON models.id = units.model_id
    ORDER BY sav.status = 'close', sav.created_at DESC LIMIT 100`);
  const open = rows.filter((x) => x.status !== 'close');
  const serials = q.all("SELECT serial FROM units WHERE status IN ('expediee', 'livree', 'en_stock') ORDER BY serial").map((u) => u.serial);
  const body = h`
<section class="kpis" style="margin-top:-30px">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Ouvertes</span>${pill(open.length ? 'ko' : 'ok', open.length ? 'à traiter' : 'rien')}</div><div class="big">${open.length}</div><div class="sub2">demandes SAV</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Sous garantie</span>${pill('no', 'ouvertes')}</div><div class="big">${open.filter((x) => x.warranty).length}</div><div class="sub2">sans frais pour le client</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Closes</span>${pill('ok', 'année')}</div><div class="big">${q.get("SELECT COUNT(*) n FROM sav WHERE status = 'close' AND closed_at >= ?", today().slice(0, 4) + '-01-01').n}</div><div class="sub2">demandes traitées</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Pièces suivies</span>${pill('no', 'registre')}</div><div class="big">${q.get('SELECT COUNT(*) n FROM units').n}</div><div class="sub2"><a href="/unites">registre des pièces</a></div></div>
</section>
<details class="card warm"${req.query.nouveau ? ' open' : ''} id="nouveau"><summary class="b">+ Nouvelle demande SAV</summary>
<form method="post" action="/sav" class="form mt12 mw680"><div class="grid2"><label>Numéro de pièce (si connu) <input name="serial" list="serials" value="${req.query.serial || ''}"></label><label>Client <input name="client"></label></div>
<datalist id="serials">${serials.map((s) => h`<option value="${s}">`)}</datalist>
<label>Ce qui se passe <textarea name="body" rows="3" required></textarea></label><button class="btn">Ouvrir la demande</button>
<p class="mut t12">La garantie est vérifiée d'après la date de livraison de la pièce.</p></form></details>
${rows.map((x) => { const idx = SAV_STEPS.findIndex((s) => s[0] === x.status); return h`<section class="card" id="s${x.id}"><div class="line"><b class="t16 grow">${x.serial ? h`<a href="/unites/${x.unit_id}">${x.serial}</a> · ` : ''}${x.mname || x.client || 'Demande SAV'}</b>${pill(x.warranty ? 'ok' : 'no', x.warranty ? 'Sous garantie' : 'Hors garantie')}${pill(x.status === 'close' ? 'ok' : 'ko', SAV_STEPS[idx][1])}</div>
<p class="mt8">« ${x.body} »</p><p class="mut t12">reçue le ${ddmm(x.created_at)}${x.client ? ` · ${x.client}` : ''}</p>
<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;margin-top:12px">${SAV_STEPS.map(([k, l], i) => h`<div class="c ${i < idx ? 'd' : i === idx ? 'cc' : 'w'}" style="text-align:center;padding:10px">${l}</div>`)}</div>
${x.status !== 'close' ? h`<form method="post" action="/sav/${x.id}" class="line mt12"><label class="sr" for="n${x.id}">Note</label><input id="n${x.id}" class="qin" name="notes" value="${x.notes}" placeholder="Diagnostic, pièce à changer…"><button class="btn alt sm" name="act" value="note">Enregistrer</button><button class="btn sm" name="act" value="next">Étape suivante</button></form>
<div class="line mt8">${postBtn(`/sav/${x.id}/fiche`, 'Créer une fiche atelier', 'btn alt sm')}</div>` : h`<p class="mut t12">${x.notes}</p>`}</section>`; })}
${rows.length ? '' : h`<section class="card"><p class="mut">Aucune demande SAV.</p></section>`}`;
  res.send(layout({ title: 'SAV', heading: 'Qualité et SAV', tab: 'sav', sub: '/sav', body, flash: req.flash }));
});
r.post('/sav', (req, res) => {
  const u = str(req.body.serial) ? q.get('SELECT * FROM units WHERE serial = ?', str(req.body.serial)) : null;
  const until = u ? P.warrantyUntil(u) : null;
  const warranty = u ? (until ? until >= today() : 1) : 0;
  q.run('INSERT INTO sav (unit_id, project_id, client, body, warranty) VALUES (?, ?, ?, ?, ?)', u?.id || null, u?.project_id || null, str(req.body.client), str(req.body.body), warranty ? 1 : 0);
  if (u?.project_id) logActivity(u.project_id, null, `Demande SAV sur ${u.serial} : ${str(req.body.body)}`, 'Patron');
  res.flashTo('/sav', 'Demande SAV ouverte.');
});
r.post('/sav/:id', (req, res) => {
  const x = q.get('SELECT * FROM sav WHERE id = ?', req.params.id);
  if (!x) return res.redirect('/sav');
  q.run('UPDATE sav SET notes = ? WHERE id = ?', str(req.body.notes), x.id);
  if (req.body.act === 'next') {
    const i = SAV_STEPS.findIndex((s) => s[0] === x.status);
    const nxt = SAV_STEPS[Math.min(i + 1, SAV_STEPS.length - 1)][0];
    q.run("UPDATE sav SET status = ?, closed_at = CASE WHEN ? = 'close' THEN datetime('now') ELSE closed_at END WHERE id = ?", nxt, nxt, x.id);
  }
  res.redirect(`/sav#s${x.id}`);
});
// Une fiche dans un OF « SAV » : elle apparaît sur l'iPad, son temps est compté au SAV.
r.post('/sav/:id/fiche', (req, res) => {
  const x = q.get('SELECT sav.*, units.serial FROM sav LEFT JOIN units ON units.id = sav.unit_id WHERE sav.id = ?', req.params.id);
  if (!x) return res.redirect('/sav');
  let pid;
  tx(() => {
    pid = Number(q.run("INSERT INTO projects (name, kind, canal, deposit_needed, next_action) VALUES (?, 'SAV', 'SAV', 0, 'Réparation SAV')", `SAV · ${x.serial || x.client || 'pièce'}`).lastInsertRowid);
    q.run("INSERT INTO steps (project_id, ord, title, note, sent, geste) VALUES (?, 1, ?, ?, 1, 'Autre')", pid, `Réparation SAV${x.serial ? ' · ' + x.serial : ''}`, x.body);
    q.run("UPDATE sav SET status = CASE WHEN status IN ('recue','diagnostic') THEN 'reparation' ELSE status END, project_id = COALESCE(project_id, ?) WHERE id = ?", pid, x.id);
  });
  res.flashTo(`/carnets/${pid}`, 'Fiche SAV créée : choisis qui la prend, elle est déjà sur l’iPad.');
});

module.exports = r;
void company; void hoursLabel; void options;
