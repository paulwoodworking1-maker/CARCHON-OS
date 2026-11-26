'use strict';
// Matière : bois noble suivi par lot, pièces finies (stock compté, réservations).
const express = require('express');
const { q, logActivity } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, today } = require('../html');
const P = require('../production');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// ---------- Bois noble ----------
r.get('/bois', (req, res) => {
  const lots = q.all(`SELECT wood_lots.*, projects.ref pref, projects.name pname, suppliers.name sname FROM wood_lots
    LEFT JOIN projects ON projects.id = wood_lots.project_id LEFT JOIN suppliers ON suppliers.id = wood_lots.supplier_id ORDER BY volume <= 0, essence, thickness, code`);
  const projects = q.all("SELECT id, ref, name FROM projects WHERE status = 'en_cours' ORDER BY ref DESC");
  const sups = q.all('SELECT id, name FROM suppliers ORDER BY name');
  const byEss = {};
  lots.filter((l) => l.volume > 0).forEach((l) => { const k = l.essence; byEss[k] = byEss[k] || { free: 0, res: 0 }; byEss[k][l.project_id ? 'res' : 'free'] += l.volume; });
  const suggestCode = () => { const d = today(); return `X-${d.slice(2, 4)}${d.slice(5, 7)}`; };
  const body = h`
<section class="kpis" style="margin-top:-30px">${Object.entries(byEss).slice(0, 4).map(([k, v]) => h`<div class="kpi"><div class="kpi-h"><span class="kpi-l">${k}</span>${pill(v.free ? 'ok' : 'ko', v.free ? 'libre' : 'rien de libre')}</div><div class="big">${P.num(Math.round(v.free * 100) / 100)} m³</div><div class="sub2">libres · ${P.num(Math.round(v.res * 100) / 100)} m³ réservés</div></div>`)}
${Object.keys(byEss).length ? '' : h`<div class="kpi"><div class="kpi-h"><span class="kpi-l">Bois noble</span></div><div class="big">0 m³</div><div class="sub2">aucun lot réceptionné</div></div>`}</section>
<section class="card" style="border-top:0">
<div class="line"><p class="mut grow">Un lot = une livraison d'une essence et d'une épaisseur. Il est réservé à l'OF qui le consomme (automatiquement au lancement d'un lot du catalogue) ; au débit, on note le volume restant.</p>
<details class="menu"><summary class="btn">+ Réceptionner un lot</summary><form method="post" action="/bois" class="menu-list right-al form pad wide">
<div class="grid2"><label>Code du lot <input name="code" value="${suggestCode()}" required></label><label>Essence <input name="essence" required list="ess"></label></div>
<datalist id="ess"><option value="Chêne"><option value="Noyer"><option value="Frêne"><option value="Merisier"><option value="Hêtre"></datalist>
<div class="grid2"><label>Épaisseur <input name="thickness" placeholder="ex. 27 mm"></label><label>Volume (m³) <input name="volume" inputmode="decimal" required></label></div>
<div class="grid2"><label>Provenance <input name="origin" placeholder="ex. Bourgogne"></label><label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]))}</select></label></div>
<button class="btn sm">Réceptionner</button></form></details></div>
<div class="tablebox mt12"><table class="tbl" style="min-width:900px"><thead><tr><th>Lot</th><th>Essence</th><th>Épaisseur</th><th class="num">Restant</th><th>Provenance</th><th>Réservé pour</th><th></th></tr></thead><tbody>
${lots.map((l) => h`<tr style="${l.volume <= 0 ? 'opacity:.5' : ''}"><td class="b">${l.code}</td><td>${l.essence}</td><td>${l.thickness}</td><td class="num b">${P.num(l.volume)} m³</td><td class="mut">${[l.origin, l.sname].filter(Boolean).join(' · ')}<div class="t12">reçu le ${ddmm(l.received_at)}</div></td>
<td>${l.project_id ? h`<a href="/projets/${l.project_id}"><span class="ref">${l.pref}</span> ${l.pname}</a>` : pill(l.volume > 0 ? 'no' : 'no', l.volume > 0 ? 'Libre' : 'Épuisé')}</td>
<td class="num"><details class="menu"><summary class="btn alt sm">Mettre à jour</summary><form method="post" action="/bois/${l.id}" class="menu-list right-al form pad wide">
<label>Volume restant (m³) <input name="volume" inputmode="decimal" value="${l.volume}"></label>
<label>Réservé pour <select name="project_id"><option value="">Libre</option>${options(projects.map((p) => [p.id, `${p.ref} · ${p.name}`]), l.project_id)}</select></label>
<label>Note <input name="note" value="${l.note}"></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Supprimer ce lot ?">Supprimer</button></div></form></details></td></tr>`)}
${lots.length ? '' : h`<tr><td colspan="7" class="mut">Aucun lot. Réceptionne ta prochaine livraison de bois.</td></tr>`}</tbody></table></div></section>`;
  res.send(layout({ title: 'Bois noble', heading: 'Matière et stock', tab: 'stock', sub: '/bois', body, flash: req.flash }));
});
r.post('/bois', (req, res) => {
  const b = req.body;
  q.run('INSERT INTO wood_lots (code, essence, thickness, volume, origin, supplier_id) VALUES (?, ?, ?, ?, ?, ?)', str(b.code), str(b.essence), str(b.thickness), num(b.volume), str(b.origin), b.supplier_id ? Number(b.supplier_id) : null);
  res.flashTo('/bois', 'Lot réceptionné.');
});
r.post('/bois/:id', (req, res) => {
  const b = req.body;
  if (b.del) { q.run('DELETE FROM wood_lots WHERE id = ?', req.params.id); return res.redirect('/bois'); }
  const pid = b.project_id ? Number(b.project_id) : null;
  q.run('UPDATE wood_lots SET volume = ?, project_id = ?, note = ? WHERE id = ?', Math.max(0, num(b.volume)), pid, str(b.note), req.params.id);
  if (pid) { const l = q.get('SELECT code FROM wood_lots WHERE id = ?', req.params.id); logActivity(pid, null, `Lot de bois ${l.code} réservé`, 'Patron'); }
  res.redirect('/bois');
});

// ---------- Pièces finies ----------
r.get('/pieces', (req, res) => {
  const models = q.all(`SELECT models.*, (SELECT COUNT(*) FROM units WHERE model_id = models.id AND status = 'en_stock') ready,
    (SELECT COUNT(*) FROM units WHERE model_id = models.id AND status = 'en_stock' AND reserved_for != '') reserved,
    (SELECT COUNT(*) FROM units u JOIN projects p ON p.id = u.project_id WHERE u.model_id = models.id AND u.status = 'a_faire' AND p.status = 'en_cours') coming
    FROM models WHERE active = 1 ORDER BY family, name`);
  const units = q.all(`SELECT units.*, models.name mname, projects.name pname FROM units LEFT JOIN models ON models.id = units.model_id LEFT JOIN projects ON projects.id = units.project_id
    WHERE units.status = 'en_stock' ORDER BY units.reserved_for != '', units.serial`);
  const body = h`
<section class="card" style="border-top:0;padding-top:0">
<p class="mut">Seules les pièces passées au contrôle entrent ici, chacune avec son numéro. Sous le seuil boutique, un lot est proposé dans « À décider ».</p>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>Modèle</th><th class="num">Prêtes</th><th class="num">Réservées</th><th class="num">Libres</th><th class="num">En fabrication</th><th>Seuil</th><th></th></tr></thead><tbody>
${models.map((m) => { const free = m.ready - m.reserved; const low = m.threshold && free + m.coming < m.threshold; return h`<tr><td><a class="b" href="/catalogue?m=${m.id}">${m.name}</a><div class="mut t12">${m.family} · ${m.code}</div></td><td class="num">${m.ready}</td><td class="num">${m.reserved}</td><td class="num b">${free}</td><td class="num">${m.coming}</td>
<td>${m.threshold ? pill(low ? 'ko' : 'ok', low ? `Sous le seuil (${m.threshold})` : `OK (${m.threshold})`) : h`<span class="mut">—</span>`}</td><td class="num">${low ? h`<a class="btn sm" href="/catalogue?m=${m.id}&qty=${Math.max(1, m.threshold * 2 - free - m.coming)}#lancer">Lancer un lot</a>` : ''}</td></tr>`; })}
${models.length ? '' : h`<tr><td colspan="7" class="mut">Pas encore de modèle au catalogue.</td></tr>`}</tbody></table></div></section>
<section class="card"><h2>Pièces en stock · ${units.length}</h2>
${units.map((u, i) => h`<div class="row${i ? '' : ' f'}"><a class="ref" href="/unites/${u.id}" style="width:120px">${u.serial}</a><span class="grow"><b>${u.mname || u.pname || ''}</b><span class="mut t12" style="display:block">contrôlée le ${ddmm(u.controlled_at)}</span></span>
${u.reserved_for ? pill('wa', `Réservée · ${u.reserved_for}`) : pill('ok', 'Libre')}
<form method="post" action="/unites/${u.id}/reserver" class="line"><label class="sr" for="rf${u.id}">Réserver pour</label><input id="rf${u.id}" name="reserved_for" value="${u.reserved_for}" placeholder="Commande, salon, revendeur…" style="width:220px"><button class="btn alt sm">OK</button></form></div>`)}
${units.length ? '' : h`<p class="mut">Aucune pièce en stock.</p>`}</section>`;
  res.send(layout({ title: 'Pièces finies', heading: 'Matière et stock', tab: 'stock', sub: '/pieces', body, flash: req.flash }));
});

module.exports = r;
void postBtn;
