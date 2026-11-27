'use strict';
// Matière : pièces finies (stock compté, réservations).
const express = require('express');
const { q, logActivity } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, today } = require('../html');
const P = require('../production');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Bois et panneaux : voir routes/panneaux.js (/bois).

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
