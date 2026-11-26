'use strict';
// Catalogue : modèles de la boutique et des séries, nomenclature, carnet type, lancement d'un lot.
const express = require('express');
const { q, tx, PHASES, GESTES } = require('../db');
const { h, layout, pill, postBtn, options, hoursLabel, today, addDays } = require('../html');
const { upload, fileUrl, isImage } = require('../uploads');
const P = require('../production');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Temps réel moyen par fiche type, d'après les OF déjà faits sur ce modèle (par pièce).
function realAverages(model) {
  const rows = q.all(`SELECT steps.title, steps.declared_hours h, projects.qty FROM steps JOIN projects ON projects.id = steps.project_id
    WHERE projects.model_id = ? AND steps.status = 'done' AND steps.declared_hours > 0`, model.id);
  const out = {};
  for (const s of q.all('SELECT * FROM model_steps WHERE model_id = ?', model.id)) {
    const hits = rows.filter((x) => x.title === s.title || x.title.startsWith(s.title + ' (×'));
    if (hits.length) out[s.id] = hits.reduce((a, x) => a + x.h / (s.per_unit ? (x.qty || 1) : 1), 0) / hits.length;
  }
  return out;
}

r.get('/catalogue', (req, res) => {
  const models = q.all(`SELECT models.*, (SELECT COUNT(*) FROM units WHERE units.model_id = models.id AND status = 'en_stock') ready,
    (SELECT COUNT(*) FROM units WHERE units.model_id = models.id AND status = 'en_stock' AND reserved_for != '') reserved FROM models WHERE active = 1 ORDER BY family, name`);
  const m = models.find((x) => String(x.id) === String(req.query.m)) || models[0];
  const qty = Math.max(1, Math.min(200, Number(req.query.qty) || 6));
  let detail = h`<section class="card"><p class="mut">Le catalogue est vide. Ajoute ton premier modèle : sa nomenclature et son carnet type serviront à chaque lot.</p></section>`;
  if (m) {
    const bom = q.all('SELECT model_bom.*, stock_items.name sname, suppliers.name supname FROM model_bom LEFT JOIN stock_items ON stock_items.id = model_bom.stock_item_id LEFT JOIN suppliers ON suppliers.id = model_bom.supplier_id WHERE model_id = ? ORDER BY ord, id', m.id);
    const steps = q.all('SELECT * FROM model_steps WHERE model_id = ? ORDER BY ord, id', m.id);
    const real = realAverages(m);
    const refH = steps.reduce((a, s) => a + (s.per_unit ? s.est_hours : 0), 0);
    const realH = steps.reduce((a, s) => a + (s.per_unit ? (real[s.id] ?? s.est_hours) : 0), 0);
    const fixedH = steps.reduce((a, s) => a + (!s.per_unit ? (real[s.id] ?? s.est_hours) : 0), 0);
    const needs = P.needsFor(m.id, qty);
    const made = q.get('SELECT COUNT(*) n FROM units WHERE model_id = ? AND status != \'a_faire\'', m.id).n;
    const items = q.all('SELECT id, name, category FROM stock_items ORDER BY category, name');
    const sups = q.all('SELECT id, name FROM suppliers ORDER BY name');
    detail = h`
<section class="card" style="border-top:0;padding-top:0">
<div class="line" style="align-items:flex-start;gap:28px">
${m.photo && isImage(m.photo) ? h`<img src="${fileUrl(m.photo)}" alt="${m.name}" style="width:240px;height:240px;object-fit:cover;background:var(--panel)">` : h`<div style="width:240px;height:240px;background:var(--panel);display:flex;align-items:center;justify-content:center;color:var(--soft);font-size:13px">Photo du modèle</div>`}
<div class="grow" style="min-width:280px">
<div class="eb" style="display:block">${m.family} · ${m.code}</div>
<div style="font-size:30px;font-weight:700;margin-top:6px">${m.name}</div>
<table class="tbl mt12"><tbody>
<tr><td class="mut">Dimensions</td><td>${m.dims || '—'}</td></tr>
<tr><td class="mut">Essences possibles</td><td>${m.woods || '—'}</td></tr>
<tr><td class="mut">Temps par pièce</td><td><b>${hoursLabel(realH)}</b> <span class="mut">réel moyen · référence ${hoursLabel(refH)}${fixedH ? ` · + ${hoursLabel(fixedH)} par lot` : ''}</span></td></tr>
<tr><td class="mut">Stock fini</td><td>${m.ready} prête(s) · ${m.reserved} réservée(s) · seuil boutique ${m.threshold || '—'}</td></tr>
<tr><td class="mut">Pièces faites</td><td>${made}</td></tr>
</tbody></table>
<details class="mt12"><summary class="btn alt sm">Modifier le modèle</summary>
<form method="post" action="/catalogue/${m.id}" enctype="multipart/form-data" class="form mt12 mw680">
<div class="grid2"><label>Code (numéros des pièces) <input name="code" value="${m.code}" required maxlength="8"></label><label>Nom <input name="name" value="${m.name}" required></label></div>
<div class="grid2"><label>Famille <input name="family" value="${m.family}" list="fams"></label><label>Seuil boutique (pièces libres) <input name="threshold" type="number" min="0" value="${m.threshold}"></label></div>
<datalist id="fams"><option value="Luminaire"><option value="Mobilier"><option value="Objet"></datalist>
<label>Dimensions <input name="dims" value="${m.dims}"></label><label>Essences possibles <input name="woods" value="${m.woods}"></label>
<label>Notice d'entretien remise avec la pièce <textarea name="care" rows="3">${m.care}</textarea></label>
<label>Points de contrôle, un par ligne <textarea name="checks" rows="4">${JSON.parse(m.checks).join('\n')}</textarea></label>
<label>Photo <input type="file" name="photo" accept="image/*"></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="archive" value="1" data-confirm-btn="Retirer ce modèle du catalogue ?">Retirer du catalogue</button></div>
</form></details>
</div></div></section>

<div class="cols" style="margin-top:8px">
<section class="card main-col"><h2>Nomenclature · pour une pièce</h2>
<div class="tablebox"><table class="tbl"><thead><tr><th>Article</th><th class="num">Quantité</th><th>Suivi</th><th></th></tr></thead><tbody>
${bom.map((b) => h`<tr><td><b>${b.article}</b>${b.supname ? h`<div class="mut t12">${b.supname}</div>` : ''}</td><td class="num">${P.num(b.qty)} ${b.unit}</td>
<td>${b.essence ? pill('wa', `Bois · ${b.essence}${b.thickness ? ' ' + b.thickness : ''}`) : b.sname ? pill('no', `Stock · ${b.sname}`) : pill('no', 'Acheté à chaque lot')}</td>
<td class="num">${postBtn(`/catalogue/${m.id}/bom/${b.id}/supprimer`, 'Retirer', 'linkbtn')}</td></tr>`)}
</tbody></table></div>
<details class="mt12"><summary class="btn alt sm">+ Ligne de nomenclature</summary>
<form method="post" action="/catalogue/${m.id}/bom" class="form mt12">
<div class="grid2"><label>Article <input name="article" required placeholder="ex. Douille E27 laiton"></label><label>Quantité par pièce <input name="qty" inputmode="decimal" required></label></div>
<div class="grid2"><label>Unité <input name="unit" placeholder="m³, m, L… (vide = pièces)"></label><label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]))}</select></label></div>
<div class="grid2"><label>Bois : essence (vide si ce n'est pas du bois) <input name="essence" placeholder="ex. Frêne"></label><label>Épaisseur <input name="thickness" placeholder="ex. 50 mm"></label></div>
<label>Ou article suivi au stock <select name="stock_item_id"><option value="">—</option>${options(items.map((i) => [i.id, `${i.category} · ${i.name}`]))}</select></label>
<button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card side-col"><h2>Carnet type · gamme</h2>
${steps.map((s, i) => h`<div class="who${i ? '' : ' f'}"><div class="grow"><b class="t14">${s.title}</b><span class="mut t12">${[s.geste, s.per_unit ? 'par pièce' : 'une fois par lot'].filter(Boolean).join(' · ')}</span></div>
<span class="t14">${hoursLabel(s.est_hours)}</span><b class="t14" style="min-width:70px;text-align:right;color:${real[s.id] && real[s.id] > s.est_hours * 1.1 ? 'var(--red)' : 'var(--ink)'}">${real[s.id] ? hoursLabel(Math.round(real[s.id] * 4) / 4) : '—'}</b>
${postBtn(`/catalogue/${m.id}/gamme/${s.id}/supprimer`, '×', 'iconbtn', {}, 'Retirer cette fiche du carnet type ?')}</div>`)}
<p class="mut t12">Colonnes : référence, puis réel moyen appris de l'atelier (en rouge : plus long de 10 %).</p>
<details class="mt8"><summary class="btn alt sm">+ Fiche</summary>
<form method="post" action="/catalogue/${m.id}/gamme" class="form mt12">
<label>Titre <input name="title" required></label>
<div class="grid2"><label>Geste <select name="geste"><option value="">—</option>${options(GESTES)}</select></label><label>Étape de la frise <select name="phase"><option value="">—</option>${options(PHASES)}</select></label></div>
<div class="grid2"><label>Heures (référence) <input name="est_hours" inputmode="decimal"></label><label class="ck"><input type="checkbox" name="per_unit" value="1" checked> Par pièce</label></div>
<label>Mot du patron <input name="note"></label><button class="btn sm">Ajouter</button></form></details>
</section></div>

<section class="card warm mt20" id="lancer"><h2>Lancer un lot · ${m.name}</h2>
<form method="get" action="/catalogue#lancer" class="line mt12"><input type="hidden" name="m" value="${m.id}"><label class="b t13">Quantité <input type="number" name="qty" min="1" max="200" value="${qty}" style="width:110px" data-auto></label><span class="mut">La matière ci-dessous se recalcule.</span></form>
<div class="line" style="align-items:flex-start;gap:40px;margin-top:12px">
<div style="flex:2 1 340px;min-width:0"><div class="h3">Matière à prévoir</div>
${needs.map((n) => h`<div class="row"><span class="grow">${n.kind === 'bois' ? `${n.essence} ${n.thickness}` : n.article}</span><b>${P.num(n.need)} ${n.unit}</b>${pill(n.ok ? 'ok' : 'ko', n.status)}</div>`)}
${needs.length ? '' : h`<p class="mut">Pas de nomenclature : ajoute-la pour réserver le bois et préparer les achats.</p>`}</div>
<div style="flex:1 1 220px;min-width:0"><div class="h3">Heures prévues</div><div class="big">${hoursLabel(realH * qty + fixedH)}</div><p class="mut">d'après le réel moyen de l'atelier</p></div></div>
<form method="post" action="/catalogue/${m.id}/lancer" class="form mt12"><input type="hidden" name="qty" value="${qty}">
<div class="grid2"><label>Pour <select name="canal">${options(P.CANALS.filter((c) => c !== 'SAV' && c !== 'Sur-mesure'), 'Boutique')}</select></label><label>Précision (revendeur, salon, commande…) <input name="for_whom"></label></div>
<label>Prêt le <input type="date" name="due_date" value="${addDays(today(), 21)}"></label>
<p class="mut t12">À la création : les pièces sont numérotées, le bois est réservé, ce qui manque part en achats suggérés, le carnet est prêt à envoyer.</p>
<button class="btn">Créer l'OF de ${qty} pièce${qty > 1 ? 's' : ''}</button></form>
</section>`;
  }
  const body = h`<div class="cols" style="margin-top:0;align-items:stretch">
<aside style="flex:0 0 300px;min-width:0;border-right:1px solid var(--line);margin:-30px 0 -64px -36px">
<div style="padding:16px 18px;border-bottom:1px solid var(--line)" class="line"><span class="h-light">Modèles</span><details class="menu push"><summary class="btn sm">+ Modèle</summary><form method="post" action="/catalogue" class="menu-list right-al form pad wide">
<div class="grid2"><label>Code <input name="code" required maxlength="8" placeholder="ex. S1"></label><label>Nom <input name="name" required></label></div><label>Famille <input name="family" value="Luminaire" list="fams2"></label><datalist id="fams2"><option value="Luminaire"><option value="Mobilier"><option value="Objet"></datalist><button class="btn sm">Créer</button></form></details></div>
${models.map((x) => h`<a class="pickrow${m && x.id === m.id ? ' on' : ''}" href="/catalogue?m=${x.id}">${x.photo && isImage(x.photo) ? h`<img src="${fileUrl(x.photo)}" alt="" style="width:48px;height:48px;object-fit:cover">` : h`<span class="ini" style="width:48px;height:48px">${x.code}</span>`}<span class="grow"><b class="t15" style="display:block">${x.name}</b><span class="mut t13">${x.family} · ${x.ready} prête(s)</span></span>${x.threshold && x.ready - x.reserved < x.threshold ? pill('ko', 'Seuil') : ''}</a>`)}
</aside>
<div class="main-col" style="flex:999 1 560px">${detail}</div></div>`;
  res.send(layout({ title: 'Catalogue', heading: 'Catalogue', tab: 'catalogue', sub: '/catalogue', body, flash: req.flash }));
});

r.post('/catalogue', (req, res) => {
  const code = str(req.body.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!code) return res.flashTo('/catalogue', 'Il faut un code (lettres et chiffres).', 'ko');
  if (q.get('SELECT id FROM models WHERE code = ? AND active = 1', code)) return res.flashTo('/catalogue', `Le code ${code} existe déjà.`, 'ko');
  const id = q.run('INSERT INTO models (code, name, family, checks) VALUES (?, ?, ?, ?)', code, str(req.body.name), str(req.body.family) || 'Mobilier',
    JSON.stringify(['Aspect du bois et teinte', 'Ponçage en lumière rasante', 'Assemblages et stabilité', 'Numéro marqué sur la pièce'])).lastInsertRowid;
  res.flashTo(`/catalogue?m=${id}`, 'Modèle créé. Ajoute sa nomenclature et son carnet type.');
});
r.post('/catalogue/:id', upload.single('photo'), (req, res) => {
  const b = req.body;
  if (b.archive) { q.run('UPDATE models SET active = 0 WHERE id = ?', req.params.id); return res.flashTo('/catalogue', 'Modèle retiré du catalogue.'); }
  q.run('UPDATE models SET code = ?, name = ?, family = ?, threshold = ?, dims = ?, woods = ?, care = ?, checks = ?, photo = COALESCE(?, photo) WHERE id = ?',
    str(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), str(b.name), str(b.family), Math.max(0, Number(b.threshold) || 0), str(b.dims), str(b.woods), str(b.care),
    JSON.stringify(str(b.checks).split('\n').map((x) => x.trim()).filter(Boolean)), req.file ? req.file.filename : null, req.params.id);
  res.flashTo(`/catalogue?m=${req.params.id}`, 'Modèle enregistré.');
});
r.post('/catalogue/:id/bom', (req, res) => {
  const b = req.body;
  q.run('INSERT INTO model_bom (model_id, article, qty, unit, essence, thickness, stock_item_id, supplier_id, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 99)',
    req.params.id, str(b.article), num(b.qty), str(b.unit) || (str(b.essence) ? 'm³' : ''), str(b.essence), str(b.thickness), b.stock_item_id ? Number(b.stock_item_id) : null, b.supplier_id ? Number(b.supplier_id) : null);
  res.redirect(`/catalogue?m=${req.params.id}`);
});
r.post('/catalogue/:id/bom/:bid/supprimer', (req, res) => { q.run('DELETE FROM model_bom WHERE id = ? AND model_id = ?', req.params.bid, req.params.id); res.redirect(`/catalogue?m=${req.params.id}`); });
r.post('/catalogue/:id/gamme', (req, res) => {
  const b = req.body;
  const ord = (q.get('SELECT MAX(ord) m FROM model_steps WHERE model_id = ?', req.params.id).m || 0) + 1;
  q.run('INSERT INTO model_steps (model_id, ord, title, geste, phase, est_hours, per_unit, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    req.params.id, ord, str(b.title), str(b.geste), str(b.phase), num(b.est_hours), b.per_unit ? 1 : 0, str(b.note));
  res.redirect(`/catalogue?m=${req.params.id}`);
});
r.post('/catalogue/:id/gamme/:sid/supprimer', (req, res) => { q.run('DELETE FROM model_steps WHERE id = ? AND model_id = ?', req.params.sid, req.params.id); res.redirect(`/catalogue?m=${req.params.id}`); });
r.post('/catalogue/:id/lancer', (req, res) => {
  const b = req.body;
  const pid = P.launchFromModel(Number(req.params.id), { qty: b.qty, canal: str(b.canal) || 'Boutique', forWhom: str(b.for_whom), dueDate: str(b.due_date) || null, personId: L.patron().id });
  res.flashTo(`/projets/${pid}`, 'OF créé : pièces numérotées, bois réservé, achats manquants proposés. Vérifie le carnet puis envoie-le à l’atelier.');
});

module.exports = r;
void tx;
