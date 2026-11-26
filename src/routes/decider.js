'use strict';
// À décider : toutes les décisions en attente, filtrables, avec « Plus tard » pour les écarter quelques jours.
const express = require('express');
const { q } = require('../db');
const { h, layout, pill, postBtn, today, addDays, ddmm } = require('../html');
const L = require('../logic');

const r = express.Router();

// Une ligne de décision (utilisée aussi sur le tableau de bord).
function row(d, i, { snooze = true, back = '/decider' } = {}) {
  return h`<div class="row${i ? '' : ' f'}"><span class="kind">${pill(d.kind, d.tag)}</span><div class="grow"><b>${d.title}</b><span class="mut">${d.text}</span></div>
${d.href2 ? h`<a class="btn sm" href="${d.href2}">${d.cta2}</a>` : ''}${d.act ? postBtn(d.act, d.actLabel, 'btn sm', { back }) : ''}${d.ack ? postBtn(`/achats/besoin/${d.ack}/valider`, 'Valider', 'btn alt sm') : h`<a class="btn ${d.primary || d.group ? '' : 'alt '}sm" href="${d.href}">${d.cta}</a>`}
${snooze && !d.group ? postBtn('/decider/plus-tard', 'Plus tard', 'btn ghost sm', { key: d.key, back }, null) : ''}</div>`;
}

r.get('/decider', (req, res) => {
  const all = L.toDecide();
  const tag = String(req.query.tag || '');
  const tags = [...new Set(all.map((d) => d.tag))];
  const list = tag ? all.filter((d) => d.tag === tag) : all;
  const later = q.all('SELECT * FROM snoozes WHERE until > ? ORDER BY until', today());
  const back = tag ? `/decider?tag=${encodeURIComponent(tag)}` : '/decider';
  const body = h`
<p class="mut mw680">Tout ce qui attend ta réponse, le plus urgent en haut. « Plus tard » écarte une ligne 3 jours : elle revient toute seule si rien n'a changé.</p>
<div class="chips mt12" role="group" aria-label="Filtrer"><a class="chip${tag ? '' : ' on'}" href="/decider">Tout · ${all.length}</a>
${tags.map((t) => h`<a class="chip${t === tag ? ' on' : ''}" href="/decider?tag=${encodeURIComponent(t)}">${t} · ${all.filter((d) => d.tag === t).length}</a>`)}</div>
<section class="card mt12">${list.length ? list.map((d, i) => row(d, i, { back })) : h`<p class="mut">Rien n'attend ta réponse. Bonne journée.</p>`}</section>
${later.length ? h`<p class="mut mt12">${later.length} ligne${later.length > 1 ? 's' : ''} mise${later.length > 1 ? 's' : ''} de côté (retour au plus tard le ${ddmm(later[later.length - 1].until)}). ${postBtn('/decider/tout-reafficher', 'Tout réafficher', 'btn ghost sm')}</p>` : ''}`;
  res.send(layout({ title: 'À décider', heading: 'À décider', tab: 'decider', sub: '/decider', body, flash: req.flash }));
});

r.post('/decider/plus-tard', (req, res) => {
  const key = String(req.body.key || '');
  if (key) q.run('INSERT OR REPLACE INTO snoozes (key, until) VALUES (?, ?)', key, addDays(today(), Number(req.body.days) || 3));
  const back = String(req.body.back || '/decider');
  res.flashTo(back.startsWith('/') ? back : '/decider', 'Mis de côté 3 jours.');
});
r.post('/decider/tout-reafficher', (req, res) => { q.run('DELETE FROM snoozes'); res.redirect('/decider'); });

r.row = row;
module.exports = r;
