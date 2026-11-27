'use strict';
// Messagerie intégrée : chaque e-mail se relit dans Carchon OS puis part directement depuis la boîte Gmail
// de l'atelier, sans ouvrir de messagerie externe.
const express = require('express');
const { q, db, logActivity } = require('../db');
const { h, layout, pill, rel } = require('../html');
const mail = require('../mail');

db.exec(`CREATE TABLE IF NOT EXISTS mails_sent (
  id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, project_id INTEGER, status TEXT NOT NULL DEFAULT 'sent',
  error TEXT, created_at TEXT DEFAULT (datetime('now')))`);

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const safeBack = (b) => (String(b || '').startsWith('/') && !String(b).startsWith('//') ? String(b) : '/');

// Bloc réutilisable : destinataire, objet, message modifiables, et « Envoyer ».
function composeForm({ to = '', subject = '', body = '', back = '/', projectId = '', id = 'mailmsg', rows = 12 }) {
  const ready = mail.configured();
  return h`<form method="post" action="/mail/envoyer" class="form" data-busy="Envoi…">
<input type="hidden" name="back" value="${back}"><input type="hidden" name="project_id" value="${projectId}">
<label>À <input type="email" name="to" value="${to}" required multiple placeholder="adresse@client.fr"></label>
<label>Objet <input name="subject" value="${subject}" required></label>
<label>Message <textarea id="${id}" name="body" rows="${rows}" required>${body}</textarea></label>
<div class="line"><button class="btn">Envoyer</button><button type="button" class="btn alt" data-copy="#${id}">Copier</button>
<span class="mut t12">${ready ? h`Part de <b>${mail.fromAddress()}</b>, avec le logo Carchon.` : h`L'envoi n'est pas encore branché : <a href="/portails/reglages#emails">colle le mot de passe d'application Gmail</a> (2 minutes).`}</span></div></form>`;
}

r.get('/mail/nouveau', (req, res) => {
  const back = safeBack(req.query.back || req.get('referer')?.replace(/^https?:\/\/[^/]+/, ''));
  const body = h`<div class="mut"><a href="${back}">‹ Retour</a></div><h1>Nouveau message</h1>
<section class="card mt20 mw680">${composeForm({ to: str(req.query.to), subject: str(req.query.subject), body: String(req.query.body || ''), back, projectId: str(req.query.project_id) })}</section>`;
  res.send(layout({ title: 'Nouveau message', heading: 'Messagerie', body }));
});

r.post('/mail/envoyer', async (req, res) => {
  const b = req.body, back = safeBack(b.back);
  const to = str(b.to), subject = str(b.subject), text = String(b.body || '').replace(/\r\n/g, '\n');
  if (!to || !subject || !text.trim()) return res.flashTo(back, 'Il manque le destinataire, l’objet ou le message.', 'ko');
  const pid = Number(b.project_id) || null;
  try {
    const out = await mail.send({ to, subject, text });
    q.run('INSERT INTO mails_sent (to_addr, subject, body, project_id, status) VALUES (?, ?, ?, ?, ?)', to, subject, text, pid, out.sent ? 'sent' : 'logged');
    if (pid) logActivity(pid, null, `E-mail envoyé à ${to} : « ${subject} »`, 'Patron');
    if (!out.sent) return res.flashTo(back, '', 'ko', { html: 'Message gardé mais <b>pas envoyé</b> : Gmail n’est pas encore branché. <a href="/portails/reglages#emails">Brancher Gmail</a>' });
    res.flashTo(back, `E-mail envoyé à ${to}.`);
  } catch (e) {
    q.run("INSERT INTO mails_sent (to_addr, subject, body, project_id, status, error) VALUES (?, ?, ?, ?, 'error', ?)", to, subject, text, pid, e.message);
    res.flashTo(back, `L’e-mail n’est pas parti : ${e.message}`, 'ko');
  }
});

// Derniers e-mails envoyés (contrôle).
function sentList(limit = 10) {
  const rows = q.all('SELECT * FROM mails_sent ORDER BY id DESC LIMIT ?', limit);
  return rows.length ? rows.map((m, i) => h`<div class="who${i ? '' : ' f'}"><div class="grow"><b class="t14">${m.subject}</b><span class="mut t12">${m.to_addr} · ${rel(m.created_at)}</span></div>${pill(m.status === 'sent' ? 'ok' : 'ko', m.status === 'sent' ? 'Envoyé' : m.status === 'error' ? 'Échec' : 'Non envoyé')}</div>`) : h`<p class="mut">Aucun e-mail envoyé pour l'instant.</p>`;
}

module.exports = r;
module.exports.composeForm = composeForm;
module.exports.sentList = sentList;
