'use strict';
// Matière › Panneaux et bois : références en stock (m², épaisseur en mm), réservations des projets,
// chutes réutilisables et bons de commande de bois.
const express = require('express');
const { q, tx, logActivity, company } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, ddmmyyyy, printPage, rel } = require('../html');
const C = require('../chaine');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const m2 = (x) => `${(Math.round(x * 10) / 10).toLocaleString('fr-FR')} m²`;
const eur = (x) => `${Number(x || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const panelArea = (rf) => ((rf.length || 0) * (rf.width || 0)) / 1e6;
const ST = { brouillon: ['wa', 'Brouillon'], envoyee: ['no', 'Envoyée'], recue: ['ok', 'Reçue'] };
const orderNo = (o) => `BCB-${String(o.created_at).slice(0, 4)}-${String(o.id).padStart(4, '0')}`;

function refForm(rf = {}, sups) {
  return h`<div class="grid2"><label>Désignation <input name="name" value="${rf.name || ''}" required placeholder="ex. MDF plaqué chêne"></label><label>Type <select name="kind">${options(['Panneau', 'Bois massif', 'Chant', 'Autre'], rf.kind || 'Panneau')}</select></label></div>
<div class="grid2"><label>Épaisseur (mm) <input name="thickness" inputmode="decimal" value="${rf.thickness ?? 19}" required></label><label>Format (mm) <span class="line"><input name="length" inputmode="numeric" value="${rf.length ?? 2500}" style="width:45%"> × <input name="width" inputmode="numeric" value="${rf.width ?? 1220}" style="width:45%"></span></label></div>
<div class="grid2"><label>En stock (m²) <input name="stock_m2" inputmode="decimal" value="${rf.stock_m2 ?? 0}"></label><label>Prix (€ HT / m²) <input name="price_m2" inputmode="decimal" value="${rf.price_m2 ?? 0}"></label></div>
<label>Prix bois massif (€ HT / m³, si massif) <input name="price_m3" inputmode="decimal" value="${rf.price_m3 ?? 0}"></label>
<div class="grid2"><label>Seuil d’alerte (m²) <input name="min_m2" inputmode="decimal" value="${rf.min_m2 ?? 0}"></label><label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]), rf.supplier_id)}</select></label></div>`;
}
const refVals = (b) => [str(b.name), str(b.kind) || 'Panneau', num(b.thickness), Math.round(num(b.length)), Math.round(num(b.width)), Math.max(0, num(b.stock_m2)), num(b.price_m2), num(b.min_m2), b.supplier_id ? Number(b.supplier_id) : null, num(b.price_m3)];

r.get('/bois', (req, res) => {
  const refs = q.all('SELECT panel_refs.*, suppliers.name sname FROM panel_refs LEFT JOIN suppliers ON suppliers.id = panel_refs.supplier_id WHERE active = 1 ORDER BY kind, ord, name, thickness');
  const res0 = C.reservations();
  const sups = q.all('SELECT id, name FROM suppliers ORDER BY name');
  const chutes = q.all(`SELECT offcuts.*, panel_refs.name rname, panel_refs.thickness, projects.ref pref FROM offcuts JOIN panel_refs ON panel_refs.id = offcuts.ref_id
    LEFT JOIN projects ON projects.id = offcuts.project_id WHERE used_at IS NULL ORDER BY panel_refs.name, offcuts.length * offcuts.width DESC`);
  const orders = q.all('SELECT wood_orders.*, suppliers.name sname, projects.ref pref FROM wood_orders LEFT JOIN suppliers ON suppliers.id = wood_orders.supplier_id LEFT JOIN projects ON projects.id = wood_orders.project_id ORDER BY wood_orders.status = \'recue\', wood_orders.id DESC LIMIT 30');
  const projects = q.all("SELECT id, ref, name FROM projects WHERE status = 'en_cours' ORDER BY ref DESC");
  const rows = refs.map((rf) => { const rr = res0[rf.id] || { m2: 0, frozen: 0, projects: [] }; const free = rf.stock_m2 - rr.frozen; return { ...rf, rr, free, low: free < rf.min_m2 || free < 0 }; });
  const totStock = rows.reduce((a, x) => a + x.stock_m2, 0), totRes = rows.reduce((a, x) => a + x.rr.frozen, 0);
  const short = rows.filter((x) => x.free < 0 || (x.min_m2 && x.free < x.min_m2));
  const body = h`
<section class="kpis" style="margin-top:-30px">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">En stock</span>${pill('no', `${rows.length} réf.`)}</div><div class="big">${m2(totStock)}</div><div class="sub2">panneaux et bois</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Réservé</span>${pill('wa', 'projets')}</div><div class="big">${m2(totRes)}</div><div class="sub2">par les chaînes figées</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">À commander</span>${pill(short.length ? 'ko' : 'ok', short.length ? 'manque' : 'OK')}</div><div class="big">${short.length}</div><div class="sub2">référence${short.length > 1 ? 's' : ''} sous le besoin ou le seuil</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Chutes</span>${pill('no', 'réutilisables')}</div><div class="big">${chutes.length}</div><div class="sub2">${m2(chutes.reduce((a, c) => a + (c.length * c.width) / 1e6, 0))}</div></div>
</section>

<section class="card" style="border-top:0">
<div class="line"><h2>Références panneaux</h2><p class="mut grow">Quantité en m², épaisseur en mm. Les projets réservent leurs panneaux quand leur chaîne de production est figée, et les sortent du stock au débit.</p>
<details class="menu"><summary class="btn">+ Référence</summary><form method="post" action="/bois/refs" class="menu-list right-al form pad wide">${refForm({}, sups)}<button class="btn sm">Ajouter</button></form></details></div>
<div class="tablebox mt12"><table class="tbl" style="min-width:980px"><thead><tr><th>Référence</th><th class="num">Ép. (mm)</th><th>Format</th><th class="num">En stock</th><th class="num">Réservé</th><th class="num">Disponible</th><th>Utilisée par</th><th class="num">Prix / m²</th><th></th></tr></thead><tbody>
${rows.map((x) => h`<tr><td><b>${x.name}</b><div class="mut t12">${x.kind}${x.sname ? ` · ${x.sname}` : ''}</div></td><td class="num">${String(x.thickness).replace('.', ',')}</td><td class="mut">${x.length && x.width ? `${x.length} × ${x.width}` : '—'}${x.length && x.width ? h`<div class="t12">${m2(panelArea(x))} / panneau</div>` : ''}</td>
<td class="num b">${m2(x.stock_m2)}${panelArea(x) ? h`<div class="mut t12">≈ ${Math.floor(x.stock_m2 / panelArea(x) * 10) / 10} panneaux</div>` : ''}</td>
<td class="num">${x.rr.frozen ? m2(x.rr.frozen) : '—'}${x.rr.m2 > x.rr.frozen ? h`<div class="mut t12">+ ${m2(x.rr.m2 - x.rr.frozen)} en chiffrage</div>` : ''}</td>
<td class="num b" style="${x.low ? 'color:var(--red)' : ''}">${m2(x.free)}${x.min_m2 ? h`<div class="mut t12">seuil ${m2(x.min_m2)}</div>` : ''}</td>
<td class="t13">${x.rr.projects.map((pp) => h`<div><a href="/projets/${pp.id}/chaine#03"><span class="ref">${pp.ref}</span></a> ${m2(pp.m2)}${pp.frozen ? '' : h` <span class="mut">(chiffrage)</span>`}</div>`)}${x.rr.projects.length ? '' : h`<span class="mut">—</span>`}</td>
<td class="num">${x.kind === 'Bois massif' ? (x.price_m3 ? `${eur(x.price_m3)} / m³` : h`<span class="red">à renseigner</span>`) : x.price_m2 ? eur(x.price_m2) : h`<span class="red">à renseigner</span>`}</td>
<td class="num"><details class="menu"><summary class="btn alt sm">Modifier</summary><form method="post" action="/bois/refs/${x.id}" class="menu-list right-al form pad wide">${refForm(x, sups)}
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Retirer cette référence ?">Retirer</button></div></form></details></td></tr>`)}
${rows.length ? '' : h`<tr><td colspan="9" class="mut">Aucune référence. Ajoute les panneaux que tu as en stock.</td></tr>`}</tbody></table></div>
${short.length ? h`<div class="line mt12"><span class="mut">${short.map((x) => x.name + ' ' + x.thickness + ' mm').join(', ')} : il manque de quoi couvrir les projets ou le seuil.</span>${postBtn('/bois/commandes/manquants', 'Préparer les bons de commande', 'btn sm push')}</div>` : ''}
</section>

<section class="card" id="commandes"><div class="line"><h2>Bons de commande de bois</h2>
<details class="menu push"><summary class="btn alt">+ Bon de commande</summary><form method="post" action="/bois/commandes" class="menu-list right-al form pad wide">
<div class="grid2"><label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]))}</select></label><label>Pour le projet <select name="project_id"><option value="">Stock</option>${options(projects.map((p) => [p.id, `${p.ref} · ${p.name}`]))}</select></label></div>
${[0, 1, 2, 3].map((i) => h`<div class="grid2"><label>Référence <select name="ref_${i}"><option value="">—</option>${options(refs.map((rf) => [rf.id, `${rf.name} ${rf.thickness} mm`]))}</select></label><label>Nombre de panneaux <input name="qty_${i}" inputmode="numeric"></label></div>`)}
<button class="btn sm">Créer le bon</button></form></details></div>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>N°</th><th>Fournisseur</th><th>Contenu</th><th>Projet</th><th class="num">Total HT</th><th>État</th><th></th></tr></thead><tbody>
${orders.map((o) => { const lines = JSON.parse(o.lines || '[]'); return h`<tr><td class="b"><a href="/bois/commandes/${o.id}">${orderNo(o)}</a></td><td>${o.sname || h`<span class="mut">à choisir</span>`}</td>
<td class="t13">${lines.map((l) => `${l.panels} × ${l.name}`).join(' · ')}</td><td>${o.pref ? h`<span class="ref">${o.pref}</span>` : h`<span class="mut">stock</span>`}</td>
<td class="num">${eur(lines.reduce((a, l) => a + l.m2 * (l.price_m2 || 0), 0))}</td><td>${pill(...ST[o.status])}<div class="mut t12">${o.received_at ? `reçue ${rel(o.received_at)}` : o.sent_at ? `envoyée ${rel(o.sent_at)}` : `créée ${rel(o.created_at)}`}</div></td>
<td class="num"><a class="btn alt sm" href="/bois/commandes/${o.id}">Ouvrir</a></td></tr>`; })}
${orders.length ? '' : h`<tr><td colspan="7" class="mut">Aucun bon. Ils se préparent depuis la chaîne de production d’un projet, ou ici.</td></tr>`}</tbody></table></div></section>

<section class="card" id="chutes"><div class="line"><h2>Chutes</h2><p class="mut grow">Les chutes utiles du débit entrent ici toutes seules. Avant de commander, regarde si une chute suffit.</p>
<details class="menu"><summary class="btn alt">+ Chute</summary><form method="post" action="/bois/chutes" class="menu-list right-al form pad wide">
<label>Référence <select name="ref_id" required>${options(refs.map((rf) => [rf.id, `${rf.name} ${rf.thickness} mm`]))}</select></label>
<div class="grid2"><label>Longueur (mm) <input name="length" inputmode="numeric" required></label><label>Largeur (mm) <input name="width" inputmode="numeric" required></label></div>
<label>Note <input name="note" placeholder="ex. rack du fond"></label><button class="btn sm">Ajouter</button></form></details></div>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>Référence</th><th class="num">Ép.</th><th class="num">Dimensions (mm)</th><th class="num">Surface</th><th>Origine</th><th></th></tr></thead><tbody>
${chutes.map((c) => h`<tr><td>${c.rname}</td><td class="num">${String(c.thickness).replace('.', ',')}</td><td class="num b">${c.length} × ${c.width}</td><td class="num">${m2((c.length * c.width) / 1e6)}</td><td class="mut">${c.pref || c.note || '—'} · ${ddmm(c.created_at)}</td>
<td class="num line" style="justify-content:flex-end"><form method="post" action="/bois/chutes/${c.id}" class="line"><select name="project_id" aria-label="Utilisée pour"><option value="">Utilisée…</option>${options(projects.map((p) => [p.id, p.ref]))}</select><button class="btn alt sm" name="act" value="use">OK</button><button class="btn ghost sm" name="act" value="del" data-confirm-btn="Jeter cette chute ?">Jeter</button></form></td></tr>`)}
${chutes.length ? '' : h`<tr><td colspan="6" class="mut">Pas de chute en stock.</td></tr>`}</tbody></table></div></section>`;
  res.send(layout({ title: 'Panneaux et bois', heading: 'Matière et stock', tab: 'stock', sub: '/bois', body, flash: req.flash }));
});

r.post('/bois/refs', (req, res) => {
  q.run('INSERT INTO panel_refs (name, kind, thickness, length, width, stock_m2, price_m2, min_m2, supplier_id, price_m3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...refVals(req.body));
  res.flashTo('/bois', 'Référence ajoutée.');
});
r.post('/bois/refs/:id', (req, res) => {
  const old = q.get('SELECT * FROM panel_refs WHERE id = ?', req.params.id);
  if (!old) return res.redirect('/bois');
  if (req.body.del) { q.run('UPDATE panel_refs SET active = 0 WHERE id = ?', old.id); return res.flashTo('/bois', 'Référence retirée.'); }
  const v = refVals(req.body);
  tx(() => {
    q.run('UPDATE panel_refs SET name = ?, kind = ?, thickness = ?, length = ?, width = ?, stock_m2 = ?, price_m2 = ?, min_m2 = ?, supplier_id = ?, price_m3 = ? WHERE id = ?', ...v, old.id);
    if (Math.abs(v[5] - old.stock_m2) > 0.001) q.run("INSERT INTO panel_moves (ref_id, m2, kind, note) VALUES (?, ?, 'correction', 'inventaire')", old.id, v[5] - old.stock_m2);
  });
  res.flashTo('/bois', 'Enregistré.');
});

r.post('/bois/chutes', (req, res) => {
  q.run('INSERT INTO offcuts (ref_id, length, width, note) VALUES (?, ?, ?, ?)', Number(req.body.ref_id), Math.round(num(req.body.length)), Math.round(num(req.body.width)), str(req.body.note));
  res.flashTo('/bois#chutes', 'Chute ajoutée.');
});
r.post('/bois/chutes/:id', (req, res) => {
  if (req.body.act === 'del') q.run('DELETE FROM offcuts WHERE id = ?', req.params.id);
  else {
    const pid = req.body.project_id ? Number(req.body.project_id) : null;
    q.run("UPDATE offcuts SET used_at = datetime('now'), used_project_id = ? WHERE id = ?", pid, req.params.id);
    if (pid) { const c = q.get('SELECT * FROM offcuts WHERE id = ?', req.params.id); logActivity(pid, null, `Chute ${c.length} × ${c.width} utilisée`, 'Patron'); }
  }
  res.redirect('/bois#chutes');
});

// --- Bons de commande de bois ---
function linesFrom(b) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const rf = b[`ref_${i}`] ? q.get('SELECT * FROM panel_refs WHERE id = ?', Number(b[`ref_${i}`])) : null;
    const n = Math.round(num(b[`qty_${i}`]));
    if (rf && n > 0) out.push({ ref_id: rf.id, name: `${rf.name} ${rf.thickness} mm${rf.length ? `, ${rf.length} × ${rf.width}` : ''}`, panels: n, m2: Math.round(n * panelArea(rf) * 100) / 100, price_m2: rf.price_m2 });
  }
  return out;
}
r.post('/bois/commandes', (req, res) => {
  const lines = linesFrom(req.body);
  if (!lines.length) return res.flashTo('/bois#commandes', 'Choisis au moins une référence et un nombre de panneaux.', 'ko');
  const id = q.run('INSERT INTO wood_orders (supplier_id, project_id, lines) VALUES (?, ?, ?)', req.body.supplier_id ? Number(req.body.supplier_id) : null, req.body.project_id ? Number(req.body.project_id) : null, JSON.stringify(lines)).lastInsertRowid;
  res.flashTo(`/bois/commandes/${id}`, 'Bon de commande créé.');
});
// Ce qui manque (besoins des projets + seuil), regroupé par fournisseur.
r.post('/bois/commandes/manquants', (req, res) => {
  const res0 = C.reservations();
  const bySup = {};
  for (const rf of q.all('SELECT * FROM panel_refs WHERE active = 1')) {
    const need = (res0[rf.id]?.frozen || 0) + rf.min_m2 - rf.stock_m2;
    if (need <= 0) continue;
    const pa = panelArea(rf) || 1, n = Math.ceil(need / pa);
    (bySup[rf.supplier_id || 0] = bySup[rf.supplier_id || 0] || []).push({ ref_id: rf.id, name: `${rf.name} ${rf.thickness} mm${rf.length ? `, ${rf.length} × ${rf.width}` : ''}`, panels: n, m2: Math.round(n * pa * 100) / 100, price_m2: rf.price_m2 });
  }
  let n = 0;
  tx(() => { for (const [sid, lines] of Object.entries(bySup)) { q.run('INSERT INTO wood_orders (supplier_id, lines) VALUES (?, ?)', Number(sid) || null, JSON.stringify(lines)); n++; } });
  res.flashTo('/bois#commandes', n ? `${n} bon(s) de commande préparé(s).` : 'Rien à commander.');
});

function loadOrder(id) { return q.get('SELECT wood_orders.*, suppliers.name sname, suppliers.email semail, suppliers.phone sphone, suppliers.contact scontact, projects.ref pref, projects.name pname FROM wood_orders LEFT JOIN suppliers ON suppliers.id = wood_orders.supplier_id LEFT JOIN projects ON projects.id = wood_orders.project_id WHERE wood_orders.id = ?', id); }
function orderMail(o, lines) {
  const co = company();
  return { subject: `Bon de commande ${orderNo(o)} · ${co.name}${o.pref ? ` · projet ${o.pref}` : ''}`,
    body: `Bonjour,\n\nPouvez-vous nous confirmer la disponibilité et le délai pour la commande suivante :\n\n${lines.map((l) => `- ${l.panels} panneau${l.panels > 1 ? 'x' : ''} ${l.name} (${String(l.m2).replace('.', ',')} m²)`).join('\n')}\n\nLivraison à l'atelier${co.address ? ` : ${co.address}` : ''}, du lundi au vendredi, 8 h - 17 h.\nRéférence à rappeler sur le bon de livraison : ${orderNo(o)}${o.pref ? ` / ${o.pref}` : ''}.\n\nMerci par avance,\n${co.name}${co.phone ? `\n${co.phone}` : ''}` };
}
r.get('/bois/commandes/:id', (req, res) => {
  let o = loadOrder(req.params.id);
  if (!o) return res.redirect('/bois#commandes');
  // Après un envoi par e-mail, le bon passe « envoyé ».
  if (req.query.envoye && o.status === 'brouillon' && q.get("SELECT id FROM mails_sent WHERE subject LIKE ? AND status = 'sent'", `%${orderNo(o)}%`)) {
    q.run("UPDATE wood_orders SET status = 'envoyee', sent_at = datetime('now') WHERE id = ?", o.id);
    o = loadOrder(o.id);
  }
  const lines = JSON.parse(o.lines || '[]');
  const refs = q.all("SELECT * FROM panel_refs WHERE active = 1 ORDER BY kind, ord, name");
  const sups = q.all('SELECT id, name FROM suppliers ORDER BY name');
  const m = orderMail(o, lines);
  const tot = lines.reduce((a, l) => a + l.m2 * (l.price_m2 || 0), 0);
  const body = h`<div class="mut"><a href="/bois#commandes">‹ Panneaux et bois</a></div>
<div class="head mt4"><div><h1 class="m0">${orderNo(o)}</h1><div class="line mt8">${pill(...ST[o.status])}<span class="mut">${o.sname || 'fournisseur à choisir'}${o.pref ? ` · projet ${o.pref}` : ''}</span></div></div>
<div class="push line"><a class="btn alt" href="/bois/commandes/${o.id}/bon">Imprimer / PDF</a>${o.status !== 'recue' ? postBtn(`/bois/commandes/${o.id}`, 'Livraison reçue : entrer en stock', 'btn', { act: 'recue' }, 'Les m² de ce bon entrent dans le stock. Continuer ?') : ''}</div></div>
<div class="cols mt20"><section class="card main-col"><h2>Contenu</h2>
<form method="post" action="/bois/commandes/${o.id}" class="form mt12"><input type="hidden" name="act" value="save">
<label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]), o.supplier_id)}</select></label>
${[...lines, ...Array(Math.max(1, 6 - lines.length)).fill({})].slice(0, 12).map((l, i) => h`<div class="grid2"><label>Référence <select name="ref_${i}"${o.status === 'recue' ? ' disabled' : ''}><option value="">—</option>${options(refs.map((rf) => [rf.id, `${rf.name} ${rf.thickness} mm`]), l.ref_id)}</select></label><label>Panneaux <input name="qty_${i}" inputmode="numeric" value="${l.panels || ''}"${o.status === 'recue' ? ' disabled' : ''}></label></div>`)}
<p class="b">Total : ${lines.reduce((a, l) => a + l.m2, 0).toLocaleString('fr-FR')} m² · ${eur(tot)} HT</p>
${o.status === 'recue' ? '' : h`<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="act" value="del" data-confirm-btn="Supprimer ce bon ?">Supprimer</button></div>`}</form></section>
<section class="card side-col"><h2>Envoyer au fournisseur</h2>${o.status === 'recue' ? h`<p class="mut">Reçue le ${ddmm(o.received_at)}.</p>` : require('./mail').composeForm({ to: o.semail || '', subject: m.subject, body: m.body, back: `/bois/commandes/${o.id}?envoye=1`, projectId: o.project_id || '', id: 'bcbmsg', rows: 14 })}
${o.status === 'brouillon' ? h`<div class="mt12">${postBtn(`/bois/commandes/${o.id}`, 'Marquer comme envoyée (téléphone, comptoir…)', 'linkbtn', { act: 'envoyee' })}</div>` : ''}</section></div>`;
  res.send(layout({ title: orderNo(o), heading: 'Matière et stock', tab: 'stock', sub: '/bois', body, flash: req.flash }));
});
r.post('/bois/commandes/:id', (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.redirect('/bois#commandes');
  const act = req.body.act;
  if (act === 'del') { q.run('DELETE FROM wood_orders WHERE id = ?', o.id); return res.flashTo('/bois#commandes', 'Bon supprimé.'); }
  if (act === 'envoyee') { q.run("UPDATE wood_orders SET status = 'envoyee', sent_at = datetime('now') WHERE id = ?", o.id); return res.redirect(`/bois/commandes/${o.id}`); }
  if (act === 'recue') {
    if (o.status === 'recue') return res.redirect(`/bois/commandes/${o.id}`);
    tx(() => {
      for (const l of JSON.parse(o.lines || '[]')) {
        q.run('UPDATE panel_refs SET stock_m2 = stock_m2 + ? WHERE id = ?', l.m2, l.ref_id);
        q.run("INSERT INTO panel_moves (ref_id, project_id, m2, kind, note) VALUES (?, ?, ?, 'reception', ?)", l.ref_id, o.project_id, l.m2, orderNo(o));
      }
      q.run("UPDATE wood_orders SET status = 'recue', received_at = datetime('now') WHERE id = ?", o.id);
      if (o.project_id) logActivity(o.project_id, null, `Bois reçu (${orderNo(o)})`, 'Patron');
    });
    return res.flashTo('/bois', `${orderNo(o)} reçu : le stock est à jour.`);
  }
  const lines = linesFrom(req.body);
  q.run('UPDATE wood_orders SET supplier_id = ?, lines = ? WHERE id = ?', req.body.supplier_id ? Number(req.body.supplier_id) : null, JSON.stringify(lines.length ? lines : JSON.parse(o.lines)), o.id);
  res.flashTo(`/bois/commandes/${o.id}`, 'Bon enregistré.');
});
r.get('/bois/commandes/:id/bon', (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.redirect('/bois#commandes');
  const lines = JSON.parse(o.lines || '[]');
  const co = company();
  res.send(printPage('Bon de commande · bois', h`
<table><tr><td><b>Fournisseur</b><br>${o.sname || '—'}${o.scontact ? h`<br>${o.scontact}` : ''}${o.semail ? h`<br>${o.semail}` : ''}${o.sphone ? h`<br>${o.sphone}` : ''}</td><td><b>Livraison</b><br>${co.name}${co.address ? h`<br>${co.address}` : ''}<br>du lundi au vendredi, 8 h - 17 h</td><td><b>Projet</b><br>${o.pref ? `${o.pref} · ${o.pname}` : 'Stock atelier'}</td></tr></table>
<table><thead><tr><th>Référence</th><th style="text-align:right">Panneaux</th><th style="text-align:right">m²</th><th style="text-align:right">Prix / m² HT</th><th style="text-align:right">Total HT</th></tr></thead><tbody>
${lines.map((l) => h`<tr><td>${l.name}</td><td style="text-align:right">${l.panels}</td><td style="text-align:right">${String(l.m2).replace('.', ',')}</td><td style="text-align:right">${eur(l.price_m2)}</td><td style="text-align:right">${eur(l.m2 * (l.price_m2 || 0))}</td></tr>`)}
<tr><td colspan="4"><b>Total HT</b></td><td style="text-align:right"><b>${eur(lines.reduce((a, l) => a + l.m2 * (l.price_m2 || 0), 0))}</b></td></tr></tbody></table>
<p>Merci de rappeler la référence ${orderNo(o)} sur le bon de livraison.</p>`, { ref: orderNo(o), date: ddmmyyyy(o.created_at) }));
});

module.exports = r;
