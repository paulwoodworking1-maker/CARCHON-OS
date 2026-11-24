'use strict';
// Portail client (liens privés, sans compte) : accepter un devis, suivre son projet.
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { q, tx, setting } = require('../db');
const { h, page, ddmm, ddmmyyyy, dayMonth, today, hhmm } = require('../html');
const { sha256, verify, hash } = require('../auth');
const { filePath, isImage } = require('../uploads');
const mail = require('../mail');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
r.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); next(); });

const shell = (title, inner, test) => page(title, h`<div class="phone">
<header class="cl-head"><img src="/static/logo.png" alt="Carchon Les Ateliers"></header>
${test ? h`<div class="testband">Page de test — sans valeur contractuelle.</div>` : ''}
${inner}
<p class="cl-foot">Ce lien est personnel : ne le transférez pas. Vos données servent uniquement au suivi de votre projet.</p></div>`, { bodyClass: 'client' });

// ---------- Devis à accepter ----------
function findQuote(req) {
  const qt = q.get('SELECT * FROM quotes WHERE token_hash = ?', sha256(String(req.params.t || '')));
  if (qt && qt.status === 'sent' && qt.valid_until < today()) { q.run("UPDATE quotes SET status = 'expired' WHERE id = ?", qt.id); qt.status = 'expired'; }
  return qt;
}
const acceptText = (x) => `J'ai pris connaissance du devis n° ${x.number}, version ${x.version} (empreinte du document : ${x.pdf_sha256.slice(0, 8)}…), ainsi que des conditions générales de vente jointes, et je l'accepte. Je comprends que cette acceptation en ligne, après vérification de mon adresse e-mail par un code à usage unique, vaut signature électronique simple et engage la commande décrite dans ce devis.`;
const maskEmail = (e) => { const [u, d] = e.split('@'); const [dn, ...tld] = (d || '').split('.'); return `${u[0]}•••••@•••.${tld.join('.') || dn}`; };

r.get('/devis/:t', (req, res) => {
  const x = findQuote(req);
  if (!x) return res.status(404).send(shell('Lien invalide', h`<main class="cl"><h1>Ce lien n’est pas valable</h1><p class="mut">Vérifiez l’adresse, ou demandez un nouveau lien à l’atelier.</p></main>`));
  const t = req.params.t;
  const verified = (req.session.vq || []).includes(x.id) && x.email_verified_at;
  const flash = req.flash ? h`<div class="flash ${req.flash.kind}">${req.flash.text}</div>` : '';
  if (x.status === 'accepted') {
    return res.send(shell('Devis accepté', h`<main class="cl"><div class="done-box"><h1>Devis accepté — merci</h1>
<p>Devis n° <b>${x.number}</b>, version ${x.version}, accepté le ${ddmmyyyy(x.accepted_at)} à ${hhmm(x.accepted_at)} par ${x.accept_name} (${x.accept_quality}).</p>
<p class="mut">Texte accepté : « ${x.accept_text} »</p><p class="mut">Empreinte du devis : ${x.pdf_sha256.slice(0, 8)}… · Référence : ${x.accept_ref}</p><p class="mut">Niveau : signature électronique simple.</p>
<a class="btn alt wfull" href="/p/devis/${t}/pdf" target="_blank">Revoir le devis accepté (PDF)</a></div></main>`, x.test));
  }
  if (x.status !== 'sent') {
    const why = { revoked: 'Ce lien a été fermé par l’atelier, souvent parce qu’une nouvelle version du devis vous a été envoyée.', expired: 'Ce lien a expiré.', modif: 'Votre demande de modification a bien été transmise. L’atelier vous enverra une nouvelle version.', refused: 'Vous avez refusé ce devis. Merci de votre réponse.' }[x.status];
    return res.send(shell('Devis', h`<main class="cl"><h1>Devis n° ${x.number}</h1><p>${why}</p></main>`, x.test));
  }
  const showCode = x.test && !mail.configured() && req.session.testCode?.[x.id];
  res.send(shell(`Devis ${x.number}`, h`<main class="cl">${flash}
<h1>Devis n° ${x.number}</h1><p class="mut">Pour ${x.signer_name} · version ${x.version} du ${ddmmyyyy(x.created_at)} · lien valable jusqu’au ${ddmmyyyy(x.valid_until)}</p>
<section class="cl-step"><h2>1. Consultez les documents</h2>
<a class="btn alt wfull" href="/p/devis/${t}/pdf" target="_blank">Ouvrir le devis (PDF)</a>
${x.cgv ? h`<a class="btn alt wfull mt8" href="/p/devis/${t}/cgv" target="_blank">Conditions générales de vente (PDF)</a>` : ''}
<p class="mut t12">Empreinte du devis : ${x.pdf_sha256.slice(0, 8)}…</p></section>
<section class="cl-step${verified ? ' ok' : ''}"><h2>2. Vérifiez votre adresse e-mail</h2>
${verified ? h`<p>Adresse vérifiée ✓</p>` : h`<p class="mut">Un code à 6 chiffres sera envoyé à ${maskEmail(x.signer_email)}.</p>
<form method="post" action="/p/devis/${t}/code"><button class="btn alt wfull">${x.otp_hash ? 'Code envoyé · renvoyer' : 'Recevoir un code'}</button></form>
${showCode ? h`<p class="testband">Mode test : votre code est <b>${showCode}</b></p>` : ''}
<form method="post" action="/p/devis/${t}/verifier" class="form mt8"><label>Code reçu <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="btn wfull">Valider le code</button></form>`}</section>
<section class="cl-step${verified ? '' : ' dim'}"><h2>3. Acceptez le devis</h2>
<form method="post" action="/p/devis/${t}/accepter" class="form">
<label>Nom et prénom <input name="name" value="${x.signer_name}" required ${verified ? '' : 'disabled'}></label>
<label>Qualité <select name="quality" ${verified ? '' : 'disabled'}><option>Particulier</option><option>Représentant d’une entreprise</option><option>Architecte mandaté</option></select></label>
<label class="ck top"><input type="checkbox" name="consent" value="1" required ${verified ? '' : 'disabled'}> <span>${acceptText(x)}</span></label>
<button class="btn wfull" ${verified ? '' : 'disabled'}>J'accepte le devis n° ${x.number}</button></form></section>
<details class="cl-step"><summary class="b">Refuser ou demander une modification</summary>
<form method="post" action="/p/devis/${t}/repondre" class="form mt8"><label class="ck"><input type="radio" name="kind" value="modif" checked> Je souhaite une modification</label><label class="ck"><input type="radio" name="kind" value="refused"> Je refuse ce devis</label>
<label>Votre message <textarea name="text" rows="3" required></textarea></label><button class="btn alt wfull">Envoyer ma réponse</button></form></details>
</main>`, x.test));
});

function sendQuoteFile(kind) {
  return (req, res) => {
    const x = findQuote(req);
    const f = x && (kind === 'pdf' ? x.pdf : x.cgv);
    if (!f || !fs.existsSync(filePath(f))) return res.status(404).send('Introuvable');
    res.type('application/pdf').sendFile(filePath(f));
  };
}
r.get('/devis/:t/pdf', sendQuoteFile('pdf'));
r.get('/devis/:t/cgv', sendQuoteFile('cgv'));

r.post('/devis/:t/code', async (req, res, next) => {
  try {
    const x = findQuote(req);
    if (!x || x.status !== 'sent') return res.redirect(`/p/devis/${req.params.t}`);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    q.run("UPDATE quotes SET otp_hash = ?, otp_expires = datetime('now', '+15 minutes'), otp_tries = 0 WHERE id = ?", hash(code), x.id);
    await mail.send({ to: x.signer_email, subject: `Votre code pour le devis ${x.number}`, text: `Bonjour,\n\nVotre code de vérification est : ${code}\nIl est valable 15 minutes.\n\nCarchon Les Ateliers` });
    if (x.test && !mail.configured()) { req.session.testCode = { ...(req.session.testCode || {}), [x.id]: code }; }
    res.flashTo(`/p/devis/${req.params.t}`, 'Code envoyé. Pensez à regarder dans les indésirables.');
  } catch (e) { next(e); }
});
r.post('/devis/:t/verifier', (req, res) => {
  const x = findQuote(req);
  if (!x || x.status !== 'sent') return res.redirect(`/p/devis/${req.params.t}`);
  const back = `/p/devis/${req.params.t}`;
  if (!x.otp_hash || x.otp_tries >= 5) return res.flashTo(back, 'Demandez un nouveau code.', 'ko');
  if (q.get("SELECT datetime('now') > ? late", x.otp_expires).late) return res.flashTo(back, 'Ce code a expiré. Demandez-en un nouveau.', 'ko');
  if (!verify(str(req.body.code), x.otp_hash)) { q.run('UPDATE quotes SET otp_tries = otp_tries + 1 WHERE id = ?', x.id); return res.flashTo(back, 'Code incorrect.', 'ko'); }
  q.run("UPDATE quotes SET email_verified_at = datetime('now'), otp_hash = NULL WHERE id = ?", x.id);
  req.session.vq = [...new Set([...(req.session.vq || []), x.id])];
  if (req.session.testCode) delete req.session.testCode[x.id];
  res.flashTo(back, 'Adresse e-mail vérifiée.');
});
r.post('/devis/:t/accepter', (req, res) => {
  const x = findQuote(req);
  const back = `/p/devis/${req.params.t}`;
  if (!x || x.status !== 'sent') return res.redirect(back);
  if (!(req.session.vq || []).includes(x.id) || !x.email_verified_at) return res.flashTo(back, 'Vérifiez d’abord votre adresse e-mail.', 'ko');
  if (!req.body.consent || !str(req.body.name)) return res.flashTo(back, 'Cochez la case et indiquez votre nom.', 'ko');
  // Le PDF n'a pas bougé depuis l'envoi ?
  if (sha256(fs.readFileSync(filePath(x.pdf))) !== x.pdf_sha256) return res.flashTo(back, 'Le document a changé : contactez l’atelier.', 'ko');
  const ref = `ACC-${x.id}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  tx(() => {
    q.run("UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), accept_name = ?, accept_quality = ?, accept_text = ?, accept_ip = ?, accept_ua = ?, accept_ref = ?, treated = 0 WHERE id = ?",
      str(req.body.name), str(req.body.quality) || 'Particulier', acceptText(x), req.ip, String(req.get('user-agent') || '').slice(0, 300), ref, x.id);
    L.projectFromQuote(q.get('SELECT * FROM quotes WHERE id = ?', x.id));
  });
  res.redirect(back);
});
r.post('/devis/:t/repondre', (req, res) => {
  const x = findQuote(req);
  if (x && x.status === 'sent' && str(req.body.text)) {
    q.run("UPDATE quotes SET status = ?, response_text = ?, responded_at = datetime('now'), treated = 0 WHERE id = ?", req.body.kind === 'refused' ? 'refused' : 'modif', str(req.body.text).slice(0, 2000), x.id);
  }
  res.redirect(`/p/devis/${req.params.t}`);
});

// ---------- Espace client ----------
const findSpace = (t) => q.get("SELECT * FROM projects WHERE portal_token_hash = ? AND portal_state = 'open'", sha256(String(t || '')));

function renderSpace(p, { token = null, preview = false, tab = 'projet' } = {}) {
  const client = q.get('SELECT * FROM clients WHERE id = ?', p.client_id) || { name: '' };
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
  // Devis signé hors portail : pas de devis en attente, l'étape est considérée comme faite.
  const pendingQuote = quote ? null : q.get("SELECT id FROM quotes WHERE project_id = ? AND status = 'sent'", p.id);
  const fr = L.frise(p);
  const st = (ph) => fr.find((f) => f.phase === ph)?.state;
  const trip = q.get('SELECT * FROM trips WHERE project_id = ? ORDER BY date LIMIT 1', p.id);
  const started = q.get("SELECT MIN(started_at) s FROM steps WHERE project_id = ? AND started_at IS NOT NULL", p.id).s;
  const remaining = q.get("SELECT COUNT(*) n FROM steps WHERE project_id = ? AND status != 'done' AND COALESCE(phase, '') NOT IN ('Livraison', 'Réception')", p.id).n;
  const anySteps = q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ?', p.id).n;
  const fabDone = anySteps > 0 && remaining === 0;
  const steps = [
    ['Devis accepté', quote || !pendingQuote ? 'd' : 'c'], ['Acompte', !p.deposit_needed || p.deposit_at ? 'd' : 'c'],
    ['Fabrication', fabDone ? 'd' : started ? 'c' : 't'], ['Prêt à poser', fabDone ? (trip?.done_at ? 'd' : 'c') : 't'],
    ['Pose', trip?.done_at ? 'd' : 't'], ['Réception', trip?.pv_signed_at ? 'd' : 't'],
  ];
  const miles = [
    quote && ['Devis accepté', `le ${dayMonth(quote.accepted_at)}`, true],
    p.deposit_at && ['Acompte reçu', `le ${dayMonth(p.deposit_at)}`, true],
    st('Bois') === 'd' && ['Bois et matériaux prêts', '', true],
    started && ['En fabrication', `depuis le ${dayMonth(started)}`, true],
    ['Prête à poser', p.ready_date ? `vers le ${dayMonth(p.ready_date)}` : 'date communiquée bientôt', fabDone, !!p.ready_date],
    ['Pose', trip ? `le ${dayMonth(trip.date)}` : 'date à choisir ensemble', !!trip?.done_at, !!trip],
    trip?.pv_signed_at && ['Réception', `le ${dayMonth(trip.pv_signed_at)}`, true],
  ].filter(Boolean);
  const photos = q.all('SELECT * FROM photos WHERE project_id = ? AND shared_client = 1 ORDER BY created_at DESC', p.id);
  const docs = q.all('SELECT * FROM documents WHERE project_id = ? AND visible_client = 1 ORDER BY id DESC', p.id);
  const pvs = q.all('SELECT * FROM trips WHERE project_id = ? AND pv_signed_at IS NOT NULL', p.id);
  const events = q.all('SELECT * FROM events WHERE project_id = ? AND show_client = 1 AND date >= ? ORDER BY date', p.id, today());
  const baseUrl = preview ? `/portails/espace/${p.id}/apercu` : `/p/espace/${token}`;
  const f = (name) => (preview ? `/fichiers/${encodeURIComponent(name)}` : `/p/espace/${token}/f/${encodeURIComponent(name)}`);
  const todo = pendingQuote ? 'Accepter le devis (lien envoyé par e-mail).' : p.deposit_needed && !p.deposit_at ? 'Régler l’acompte prévu au devis.' : '';
  const T = ['projet', 'suivi', 'documents'].includes(tab) ? tab : 'projet';
  const stepsHtml = h`<ol class="vsteps">${steps.map(([l, s], i) => h`<li class="${s === 'd' ? 'd' : s === 'c' ? 'c' : ''}"><span class="mk">${s === 'd' ? '✓' : ''}</span><b>${l}</b><span class="mut">${s === 'd' ? 'Fait' : s === 'c' ? 'En cours' : 'À venir'}</span></li>`)}</ol>`;
  const inner = h`<main class="cl">
${preview ? h`<div class="testband">Aperçu patron : c’est ce que voit ${client.name}. <a href="/portails">Revenir</a></div>` : ''}
<div class="mut">${client.name}</div><h1>${p.name}</h1>${quote ? h`<p class="mut">Devis n° ${quote.number} · version ${quote.version}</p>` : ''}
<nav class="cl-tabs">${[['projet', 'Projet'], ['suivi', 'Suivi'], ['documents', 'Documents']].map(([k, l]) => h`<a href="${baseUrl}?tab=${k}" class="${T === k ? 'on' : ''}">${l}</a>`)}</nav>
${T === 'projet' ? h`<section class="cl-step"><h2>À faire de votre côté</h2><p>${todo || 'Rien à faire pour le moment : nous vous tenons informé(e) de l’avancement.'}</p></section>
<section class="cl-step"><h2>Où en est votre pièce</h2>${stepsHtml}
${steps[2][1] === 'c' ? h`<div class="info-box"><b>À l’atelier</b><p>Votre pièce est en fabrication.${p.ready_date ? ` Prête à poser vers le ${dayMonth(p.ready_date)}.` : ''} Nous vous proposerons des dates de pose.</p></div>` : ''}</section>
${events.length ? h`<section class="cl-step"><h2>Rendez-vous</h2>${events.map((e) => h`<p><b>${dayMonth(e.date)}</b> · ${e.title}${e.detail ? ` — ${e.detail}` : ''}</p>`)}</section>` : ''}
${photos.length ? h`<section class="cl-step"><h2>Dernières photos</h2><div class="cl-photos">${photos.slice(0, 4).map((x) => h`<figure><img src="${f(x.file)}" alt="${x.title}" loading="lazy"><figcaption>${x.title}</figcaption></figure>`)}</div></section>` : ''}` : ''}
${T === 'suivi' ? h`<section class="cl-step"><h2>Étapes</h2><ol class="vsteps">${miles.map(([l, sub, done, dated]) => h`<li class="${done ? 'd' : dated ? 'c' : ''}"><span class="mk">${done ? '✓' : ''}</span><b>${l}</b><span class="mut">${sub}</span></li>`)}</ol></section>
<section class="cl-step"><h2>Photos de l’atelier</h2>${photos.length ? h`<div class="cl-photos">${photos.map((x) => h`<figure><a href="${f(x.file)}" target="_blank"><img src="${f(x.file)}" alt="${x.title}" loading="lazy"></a><figcaption>${x.title} · ${ddmm(x.created_at)}</figcaption></figure>`)}</div>` : h`<p class="mut">Pas encore de photo.</p>`}
<p class="mut t12">Seules les photos que l’atelier choisit de partager apparaissent ici.</p></section>` : ''}
${T === 'documents' ? h`<section class="cl-step"><h2>Documents</h2>
${quote ? h`<a class="docrow" href="${preview ? `/fichiers/${quote.pdf}` : `/p/espace/${token}/devis`}" target="_blank">Devis accepté n° ${quote.number} (PDF)</a>${quote.cgv ? h`<a class="docrow" href="${preview ? `/fichiers/${quote.cgv}` : `/p/espace/${token}/cgv`}" target="_blank">Conditions générales de vente (PDF)</a>` : ''}` : ''}
${pvs.map((t) => h`<a class="docrow" href="${preview ? `/poses/${t.id}/pv` : `/p/espace/${token}/pv/${t.id}`}">Procès-verbal de réception du ${ddmm(t.pv_signed_at)}</a>`)}
${docs.map((d) => h`<a class="docrow" href="${f(d.file)}" target="_blank">${d.title}</a>`)}
${quote || pvs.length || docs.length ? '' : h`<p class="mut">Bientôt ici : votre devis accepté, les conditions de vente, le procès-verbal et la facture.</p>`}</section>` : ''}
</main>`;
  return shell(p.name, inner, setting('portal_test_mode') === '1');
}

r.get('/espace/:t', (req, res) => {
  const p = findSpace(req.params.t);
  if (!p) return res.status(404).send(shell('Espace fermé', h`<main class="cl"><h1>Cet espace n’est pas accessible</h1><p class="mut">Le lien a peut-être été renouvelé. Demandez un nouveau lien à l’atelier.</p></main>`));
  res.send(renderSpace(p, { token: req.params.t, tab: req.query.tab }));
});
r.get('/espace/:t/f/:name', (req, res) => {
  const p = findSpace(req.params.t);
  const n = req.params.name;
  const ok = p && (q.get('SELECT id FROM photos WHERE project_id = ? AND file = ? AND shared_client = 1', p.id, n) || q.get('SELECT id FROM documents WHERE project_id = ? AND file = ? AND visible_client = 1', p.id, n));
  if (!ok || !fs.existsSync(filePath(n))) return res.status(404).send('Introuvable');
  res.sendFile(filePath(n));
});
for (const k of ['devis', 'cgv']) {
  r.get(`/espace/:t/${k}`, (req, res) => {
    const p = findSpace(req.params.t);
    const x = p && q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
    const f = x && (k === 'devis' ? x.pdf : x.cgv);
    if (!f) return res.status(404).send('Introuvable');
    res.type('application/pdf').sendFile(filePath(f));
  });
}
r.get('/espace/:t/pv/:id', (req, res) => {
  const p = findSpace(req.params.t);
  const t = p && q.get('SELECT * FROM trips WHERE id = ? AND project_id = ? AND pv_signed_at IS NOT NULL', req.params.id, p.id);
  if (!t) return res.status(404).send('Introuvable');
  res.send(shell('Procès-verbal', h`<main class="cl"><h1>Procès-verbal de réception</h1><p>Ouvrage : <b>${p.name}</b></p>
<p>Réception prononcée le <b>${ddmmyyyy(t.pv_signed_at)}</b> par <b>${t.pv_name}</b>, ${t.pv_reserves ? h`avec la réserve suivante : « ${t.pv_reserves} »${t.pv_reserves_lifted_at ? ` (levée le ${ddmmyyyy(t.pv_reserves_lifted_at)})` : ''}` : 'sans réserve'}.</p>
${t.pv_signature ? h`<img class="sig-img" src="/p/espace/${req.params.t}/sig/${t.id}" alt="Signature">` : ''}
<p><a href="/p/espace/${req.params.t}?tab=documents">Revenir aux documents</a></p></main>`));
});
r.get('/espace/:t/sig/:id', (req, res) => {
  const p = findSpace(req.params.t);
  const t = p && q.get('SELECT pv_signature FROM trips WHERE id = ? AND project_id = ?', req.params.id, p.id);
  if (!t?.pv_signature) return res.status(404).send('Introuvable');
  res.sendFile(filePath(t.pv_signature));
});

module.exports = r;
module.exports.renderSpace = renderSpace;
void isImage;
