'use strict';
// « Messages aux clients » : tous les textes que voit ou reçoit un client, à relire et modifier.
const express = require('express');
const { h, layout, pill } = require('../html');
const M = require('../messages');

const r = express.Router();
const groups = () => [...new Set(M.all().map((e) => e[1]))];
const slug = (g) => 'g' + groups().indexOf(g);

r.get('/messages', (req, res) => {
  const list = M.all();
  const body = h`
<p class="mut mw680" style="margin-top:-8px">Tout ce que voit ou reçoit un client, au même endroit. <b>{mot}</b> est remplacé par l’information du dossier ; un passage <b>[entre crochets]</b> disparaît si l’information manque. Pour les encadrés du portail, un texte vidé masque l’encadré.</p>
<nav class="line mt12 an-per">${groups().map((g) => h`<a class="btn alt sm" href="#${slug(g)}">${g}</a>`)}</nav>
${groups().map((g) => h`<section class="card mt20" id="${slug(g)}"><h2>${g}</h2>
<form method="post" action="/messages#${slug(g)}" class="form mt12">
${list.filter((e) => e[1] === g).map(([key, , when, def, o]) => {
    const cur = M.raw(key); const changed = !M.isDefault(key);
    const rows = Math.min(14, Math.max(2, String(cur || def).split('\n').length + Math.ceil(String(cur || def).length / 90)));
    const preview = M.fill(cur, M.SAMPLE);
    return h`<div class="msg-item"><div class="line"><b class="t14">${when}</b>${changed ? pill('wa', 'Modifié') : ''}${!cur && o.hideable ? pill('no', 'Masqué') : ''}
${changed ? h`<button class="linkish t12 push" name="reset" value="${key}">Remettre le texte d’origine</button>` : ''}</div>
${o.title ? h`<input name="m_${key}" value="${cur}" aria-label="${when}">` : h`<textarea name="m_${key}" rows="${rows}" aria-label="${when}">${cur}</textarea>`}
${o.vars?.length ? h`<span class="mut t12">Mots disponibles : ${o.vars.map((v) => `{${v}}`).join(' ')}</span>` : ''}
${preview ? h`<details class="msg-prev"><summary class="mut t12">Aperçu avec un exemple</summary><div class="pre t13">${preview}</div></details>` : ''}
${o.sms ? h`<span class="mut t12">${preview.length} caractères${preview.length > 160 ? ' : plus d’un SMS' : ''}</span>` : ''}</div>`;
  })}
<div class="line"><button class="btn sm">Enregistrer</button></div></form></section>`)}`;
  res.send(layout({ title: 'Messages aux clients', heading: 'Réglages', tab: 'reglages', sub: '/messages', body, flash: req.flash }));
});

r.post('/messages', (req, res) => {
  if (req.body.reset) { M.reset(String(req.body.reset)); return res.flashTo('/messages', 'Texte d’origine remis.'); }
  let n = 0;
  for (const [key] of M.all()) {
    const v = req.body[`m_${key}`];
    if (v === undefined) continue;
    if (String(v).replace(/\r\n/g, '\n') !== M.raw(key)) { M.save(key, v); n++; }
  }
  res.flashTo('/messages', n ? `${n} texte(s) enregistré(s).` : 'Rien n’a changé.');
});

module.exports = r;
