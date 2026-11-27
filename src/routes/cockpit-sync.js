'use strict';
// Synchronisation de la base clientèle Cockpit quand Cockpit tourne sur l'ordinateur du patron :
// le navigateur lit Cockpit (localhost) puis transmet la liste à Carchon OS. Secours : import d'un fichier.
const express = require('express');
const { setting } = require('../db');
const { h, postBtn } = require('../html');
const { upload } = require('../uploads');
const C = require('../cockpit');

const r = express.Router();
const safeBack = (b) => (String(b || '').startsWith('/') && !String(b).startsWith('//') ? String(b) : '/');

function syncTools(back) {
  const url = String(setting('cockpit_url') || '').replace(/\/+$/, '');
  return h`<div class="line mt8">${C.local()
    ? h`<button type="button" class="btn alt sm" data-cockpit-sync="${url}/api/v1/clients" data-back="${back}">Synchroniser depuis cet ordinateur</button>`
    : postBtn('/clients/synchroniser', 'Mettre à jour depuis Cockpit', 'btn alt sm', { back })}
<form method="post" action="/clients/import" enctype="multipart/form-data" class="inline"><input type="hidden" name="back" value="${back}">
<label class="linkbtn" style="cursor:pointer">ou importer un export de Cockpit (JSON ou CSV)<input type="file" name="file" accept=".json,.csv,application/json,text/csv" hidden data-auto></label></form></div>
<p class="mut t12" data-cockpit-msg></p>`;
}

// Liste envoyée par le navigateur (JSON) ou fichier exporté de Cockpit.
r.post('/clients/import', express.json({ limit: '5mb' }), (req, res, next) => {
  if (req.is('application/json')) {
    const d = req.body;
    const list = Array.isArray(d) ? d : d.clients || d.data || [];
    const n = C.upsertMany(list);
    require('../db').setSetting('cockpit_synced_at', new Date().toISOString());
    return res.json({ ok: true, n });
  }
  next();
}, multerAny, (req, res) => {
  const back = safeBack(req.body.back);
  if (!req.file) return res.flashTo(back, 'Choisis un fichier JSON ou CSV exporté de Cockpit.', 'ko');
  const txt = req.file.buffer.toString('utf8').replace(/^﻿/, '');
  let list = [];
  try {
    if (/^\s*[[{]/.test(txt)) { const d = JSON.parse(txt); list = Array.isArray(d) ? d : d.clients || d.data || []; }
    else {
      const rows = txt.split(/\r?\n/).filter((l) => l.trim());
      const sep = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';' : ',';
      const cells = (l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
      const head = cells(rows[0]).map((x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, '').replace(/\s+/g, '_'));
      list = rows.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])));
    }
  } catch (e) { return res.flashTo(back, `Fichier illisible : ${e.message}`, 'ko'); }
  const n = C.upsertMany(list);
  require('../db').setSetting('cockpit_synced_at', new Date().toISOString());
  res.flashTo(back, `${n} client(s) importé(s) dans la base.`);
});
function multerAny(req, res, next) { return require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file')(req, res, next); }
void upload;

module.exports = r;
module.exports.syncTools = syncTools;
