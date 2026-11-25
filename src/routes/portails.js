'use strict';
// Portails clients côté patron : envoyer un devis à accepter, ouvrir / couper les espaces clients.
const express = require('express');
const fs = require('node:fs');
const { q, tx, setting, setSetting, logActivity } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, ddmmyyyy, addDays, today } = require('../html');
const { token, sha256 } = require('../auth');
const { upload, filePath } = require('../uploads');
const L = require('../logic');
const ai = require('../ai');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const base = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const testMode = () => setting('portal_test_mode') === '1';
const testEmails = () => (setting('portal_test_emails') || '').split(/[\s,;]+/).map((e) => e.toLowerCase()).filter(Boolean);

r.get('/portails', (req, res) => {
  const quotes = q.all('SELECT quotes.*, projects.name projname FROM quotes LEFT JOIN projects ON projects.id = quotes.project_id ORDER BY quotes.created_at DESC');
  const responses = quotes.filter((x) => ['accepted', 'modif', 'refused'].includes(x.status) && !x.treated);
  const projects = q.all("SELECT projects.*, clients.name cname, clients.email cemail FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.status = 'en_cours' ORDER BY projects.created_at DESC");
  const latest = new Map(); quotes.forEach((x) => { const k = x.number; if (!latest.has(k)) latest.set(k, x); });
  const pending = [...latest.values()].filter((x) => x.status === 'sent' || x.status === 'revoked' || x.status === 'expired' || (x.status === 'refused' && !x.project_id));
  const shown = req.session.shownLink; // lien affiché une seule fois
  if (shown) { delete req.session.shownLink; res.saveSession(); }
  const draft = req.session.draftQuote || null;
  const open = req.query.nouveau === '1' || !!draft;
  const LINK = { sent: ['wa', (x) => `Envoyé le ${ddmm(x.created_at)} · ouvert jusqu’au ${ddmm(x.valid_until)}`], accepted: ['ok', (x) => `Accepté le ${ddmm(x.accepted_at)}`], modif: ['wa', () => 'Modification demandée'], refused: ['ko', () => 'Refusé'], revoked: ['no', () => 'Fermé (non valable)'] };
  const body = h`<div class="head"><div><div class="eb">Projets</div><h1>Portails clients</h1>
<p class="mut mt8 mw680">Un espace par client et par commande. Il reçoit le devis, l'avancement, la date de pose prévue et les photos que tu partages. Jamais de prix de revient, de fournisseur ni de notes internes.</p></div>
<a class="btn push" href="/portails?nouveau=1#envoi">Envoyer un devis</a></div>

<details class="card warm mt20"><summary class="line"><b>${testMode() ? 'Mode test' : 'Mode réel'}</b>${pill(testMode() ? 'wa' : 'ok', testMode() ? 'Seules les adresses de test reçoivent un lien' : 'Tous les clients peuvent recevoir un lien')}</summary>
<form method="post" action="/portails/reglages" enctype="multipart/form-data" class="form mt12"><label class="ck"><input type="checkbox" name="test" value="1" ${testMode() ? 'checked' : ''}> Mode test (pages marquées « sans valeur contractuelle »)</label>
<label>Adresses de test, séparées par des virgules <input name="emails" value="${setting('portal_test_emails') || ''}"></label>
<label>Conditions générales de vente (PDF, jointes à chaque devis) <input type="file" name="cgv" accept="application/pdf"></label>
${setting('cgv_file') ? h`<p class="mut">CGV actuelles : <a href="/fichiers/${setting('cgv_file')}" target="_blank">ouvrir</a></p>` : h`<p class="mut red">Aucune CGV déposée pour l’instant.</p>`}
<button class="btn sm">Enregistrer</button></form>
<p class="mut t12 mt8">Le passage en réel se fait après l'avis de ton juriste. ${require('../mail').configured() ? 'Envoi des codes par e-mail : configuré.' : 'Envoi des codes par e-mail : non configuré (SMTP), en mode test le code s’affiche directement sur la page du client.'}</p></details>

${shown ? h`<section class="card ok-card mt20" role="status"><b>${shown.title}</b><p class="mut">Copie-le et envoie-le toi-même ${shown.to ? `à ${shown.to}` : 'au client'}. Il ne sera plus affiché ensuite : si besoin, on en crée un nouveau.</p>
<div class="line mt8"><input class="qin" readonly value="${shown.url}" id="shownlink" aria-label="Lien"><button type="button" class="btn" data-copy="#shownlink">Copier le lien</button>${shown.mailto ? h`<a class="btn alt" href="${shown.mailto}">Préparer l’e-mail</a>` : ''}</div></section>` : ''}

${open ? h`<section class="card mt20" id="envoi"><div class="line"><h2>Envoyer un devis au client</h2><a class="push btn alt sm" href="/portails/devis/annuler">Annuler</a></div>
${ai.enabled() && !draft ? h`<form method="post" action="/portails/devis/lire" enctype="multipart/form-data" class="card warm form mt12 mw680" data-busy="L’assistant lit le devis…">
<b>Le plus rapide : dépose le PDF, l’assistant remplit le reste.</b>
<input type="file" name="pdf" accept="application/pdf" required aria-label="PDF du devis"><button class="btn alt sm">Lire le devis</button></form>` : ''}
${draft?.resume ? h`<p class="mut mt12">Lu par l’assistant : ${draft.resume}${draft.montant ? ` · ${draft.montant}` : ''}${draft.acompte ? ` · acompte ${draft.acompte}` : ''}. Vérifie avant de créer le lien.</p>` : ''}
<form method="post" action="/portails/devis" enctype="multipart/form-data" class="form mt12 mw680">
<div class="grid2"><label>N° du devis <input name="number" required placeholder="D-(2026)-00399" value="${draft?.number || ''}"></label><label>Projet (nom court) <input name="project_name" placeholder="ex. Table à manger · chêne" value="${draft?.project_name || ''}"></label></div>
${draft ? h`<p class="mut">PDF du devis déposé ✓ <a href="/portails/devis/annuler?nouveau=1">changer</a></p>` : h`<label>PDF du devis (exporté de Qonto) <input type="file" name="pdf" accept="application/pdf" required></label>`}
<div class="grid2"><label>Qui signe <input name="signer_name" required value="${draft?.signer_name || ''}"></label><label>Son e-mail <input type="email" name="signer_email" required value="${draft?.signer_email || ''}"></label></div>
<label>Rattacher à un projet existant (nouvelle version) <select name="project_id"><option value="">Non : l’acceptation crée la commande</option>${options(q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name").map((p) => [p.id, p.name]))}</select></label>
<fieldset class="chips m0"><legend>Valable</legend>${['15', '30'].map((d) => h`<label class="chip"><input type="radio" name="days" value="${d}" ${d === '30' ? 'checked' : ''}>${d} jours</label>`)}</fieldset>
<ul class="mut checklist"><li>PDF du devis repris tel quel, empreinte calculée</li><li>CGV jointes ${setting('cgv_file') ? '' : '(aucune CGV déposée : à ajouter dans le bloc Mode test)'}</li><li>Ce document ne bougera plus : le client accepte exactement celui-ci</li></ul>
<p class="mut">Si tu modifies le devis ensuite, tu renvoies une nouvelle version avec le même numéro : l'ancien lien se ferme tout seul.</p>
<button class="btn">Créer le lien d'acceptation</button></form></section>` : ''}

<section class="card mt20"><div class="line"><h2>Réponses des clients</h2>${pill(responses.length ? 'ko' : 'ok', responses.length)}</div>
${responses.map((x, i) => h`<div class="row${i ? '' : ' f'}" id="q${x.id}"><span class="kind">${pill(x.status === 'accepted' ? 'ok' : x.status === 'refused' ? 'ko' : 'wa', x.status === 'accepted' ? 'Devis accepté' : x.status === 'refused' ? 'Refusé' : 'Modification demandée')}</span>
<div class="grow"><b>${x.signer_name} · ${x.number}</b><span class="mut">${x.status === 'accepted' ? `Accepté le ${ddmm(x.accepted_at)} avec code e-mail · preuve conservée · la commande est créée` : `« ${x.response_text || ''} »`}</span></div>
${x.status === 'accepted' && x.project_id ? h`<a class="btn alt sm" href="/projets/${x.project_id}">Ouvrir le projet</a>` : ''}
${x.status === 'accepted' && x.project_id ? postBtn(`/portails/espace/${x.project_id}/ouvrir`, 'Ouvrir son espace', 'btn sm') : ''}
${x.status === 'modif' ? h`<a class="btn alt sm" href="/portails?nouveau=1#envoi">Nouvelle version du devis</a>` : ''}
${x.status === 'accepted' ? h`<a class="btn alt sm" href="/portails/devis/${x.id}/preuve">Preuve</a>` : ''}
${postBtn(`/portails/devis/${x.id}/traite`, 'Marquer traité', 'btn alt sm')}</div>`)}
${responses.length ? '' : h`<p class="mut">Aucune réponse en attente.</p>`}</section>

<section class="card mt20"><h2>Affaires sur le portail</h2>
<div class="tablebox"><table class="tbl"><thead><tr><th>Client · affaire</th><th>Devis</th><th>Lien d'acceptation</th><th>Espace client</th></tr></thead><tbody>
${pending.map((x) => h`<tr id="q${x.id}"><td><b>${x.signer_name}</b><div class="mut">${x.project_name || 'devis en attente'}${x.test ? ' · test' : ''}</div></td><td>${x.number} · v${x.version}</td>
<td>${pill(LINK[x.status]?.[0] || 'no', (LINK[x.status]?.[1] || (() => x.status))(x))} ${x.status === 'sent' ? postBtn(`/portails/devis/${x.id}/fermer`, 'Non valable', 'linkbtn', {}, 'Fermer ce lien ? Le client ne pourra plus accepter.') : ''}</td><td>${pill('no', 'Pas encore ouvert')}</td></tr>`)}
${projects.map((p) => {
    const qt = q.get('SELECT * FROM quotes WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
    const nph = q.get('SELECT COUNT(*) n FROM photos WHERE project_id = ? AND shared_client = 1', p.id).n;
    const cur = L.currentPhase(L.frise(p));
    return h`<tr id="p${p.id}"><td><b>${p.name}</b><div class="mut">${p.cname}</div></td><td>${qt ? `${qt.number} · v${qt.version}` : '—'}</td>
<td>${qt ? pill(LINK[qt.status]?.[0] || 'no', (LINK[qt.status]?.[1] || (() => qt.status))(qt)) : '—'}</td>
<td>${pill(p.portal_state === 'open' ? 'ok' : 'no', p.portal_state === 'open' ? 'Ouvert' : p.portal_state === 'cut' ? 'Accès coupé' : 'Pas encore ouvert')}
${p.portal_state === 'open' ? h`<div class="mut t12">Suivi : ${cur.phase.toLowerCase()} · ${nph} photo${nph > 1 ? 's' : ''} partagée${nph > 1 ? 's' : ''}</div>` : ''}
<div class="line mt4">${p.portal_state === 'open' ? postBtn(`/portails/espace/${p.id}/couper`, 'Couper l’accès', 'linkbtn', {}, 'Couper l’accès du client à son espace ?') : ''}
${postBtn(`/portails/espace/${p.id}/ouvrir`, p.portal_state === 'open' ? 'Nouveau lien' : 'Ouvrir l’espace', 'linkbtn')}<a class="linkbtn" href="/portails/espace/${p.id}/apercu">Voir comme le client</a></div></td></tr>`;
  })}
${pending.length + projects.length ? '' : h`<tr><td colspan="4" class="mut">Rien sur le portail pour l’instant.</td></tr>`}
</tbody></table></div>
<p class="mut t12 mt8">« Non valable » ferme le lien : le client ne peut plus accepter. « Couper l'accès » ferme son espace tout de suite. L'avancement et les photos partent tout seuls depuis chaque projet.</p></section>`;
  res.send(layout({ title: 'Portails clients', tab: 'projets', sub: '/portails', body, flash: req.flash }));
});

r.post('/portails/reglages', upload.single('cgv'), (req, res) => {
  setSetting('portal_test_mode', req.body.test ? '1' : '0');
  setSetting('portal_test_emails', str(req.body.emails));
  if (req.file) setSetting('cgv_file', req.file.filename);
  res.flashTo('/portails', 'Réglages du portail enregistrés.');
});

// L'assistant lit le PDF et prépare le formulaire.
r.post('/portails/devis/lire', upload.single('pdf'), async (req, res, next) => {
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo('/portails?nouveau=1', 'Il faut un PDF.', 'ko');
  try {
    const x = await ai.readQuotePdf(fs.readFileSync(req.file.path));
    req.session.draftQuote = { pdf: req.file.filename, number: x.numero, signer_name: x.client_nom, signer_email: x.client_email, project_name: x.objet, resume: x.resume, montant: x.montant_ttc, acompte: x.acompte };
    res.saveSession();
    res.redirect('/portails#envoi');
  } catch (e) {
    req.session.draftQuote = { pdf: req.file.filename };
    res.saveSession();
    if (e instanceof ai.AIError) return res.flashTo('/portails#envoi', `${e.message} Le PDF est gardé : remplis les champs à la main.`, 'ko');
    next(e);
  }
});
r.get('/portails/devis/annuler', (req, res) => {
  const d = req.session.draftQuote;
  if (d?.pdf) fs.rmSync(filePath(d.pdf), { force: true });
  delete req.session.draftQuote; res.saveSession();
  res.redirect(req.query.nouveau ? '/portails?nouveau=1#envoi' : '/portails');
});

r.post('/portails/devis', upload.single('pdf'), (req, res) => {
  const b = req.body;
  const draft = req.session.draftQuote;
  if (!req.file && draft?.pdf) req.file = { filename: draft.pdf, path: filePath(draft.pdf) };
  delete req.session.draftQuote;
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo('/portails?nouveau=1', 'Il faut le PDF du devis.', 'ko');
  const email = str(b.signer_email).toLowerCase();
  const isTest = testMode();
  if (isTest && !testEmails().includes(email)) {
    fs.rmSync(filePath(req.file.filename), { force: true });
    return res.flashTo('/portails?nouveau=1', `Mode test : ${email} n’est pas une adresse de test. Ajoute-la dans le bloc « Mode test », ou passe en mode réel.`, 'ko');
  }
  const number = str(b.number);
  const prev = q.get('SELECT * FROM quotes WHERE number = ? ORDER BY version DESC LIMIT 1', number);
  const t = token();
  const cgv = setting('cgv_file');
  const days = b.days === '15' ? 15 : 30;
  const projectId = b.project_id ? Number(b.project_id) : prev?.project_id || null;
  tx(() => {
    if (prev) q.run("UPDATE quotes SET status = 'revoked', treated = 1 WHERE number = ? AND status IN ('sent', 'modif', 'refused')", number);
    q.run(`INSERT INTO quotes (project_id, client_id, number, version, pdf, pdf_sha256, cgv, cgv_sha256, signer_name, signer_email, project_name, valid_until, token_hash, test)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, projectId, prev?.client_id || null, number, prev ? prev.version + 1 : 1, req.file.filename, sha256(fs.readFileSync(req.file.path)),
    cgv, cgv ? sha256(fs.readFileSync(filePath(cgv))) : null, str(b.signer_name), email, str(b.project_name) || prev?.project_name || '', addDays(today(), days), sha256(t), isTest ? 1 : 0);
  });
  const url = `${base(req)}/p/devis/${t}`;
  req.session.shownLink = { title: `Lien d’acceptation créé · valable ${days} jours`, url, to: str(b.signer_name),
    mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Votre devis ${number}`)}&body=${encodeURIComponent(`Bonjour,\n\nVoici le lien pour consulter et accepter votre devis ${number} :\n${url}\n\nCe lien est personnel.\n\nCarchon Les Ateliers`)}` };
  res.saveSession();
  res.redirect('/portails');
});

r.post('/portails/devis/:id/fermer', (req, res) => { q.run("UPDATE quotes SET status = 'revoked' WHERE id = ? AND status = 'sent'", req.params.id); res.flashTo('/portails', 'Lien fermé.'); });
r.post('/portails/devis/:id/traite', (req, res) => { q.run('UPDATE quotes SET treated = 1 WHERE id = ?', req.params.id); res.redirect('/portails'); });

r.get('/portails/devis/:id/preuve', (req, res) => {
  const x = q.get('SELECT * FROM quotes WHERE id = ?', req.params.id);
  if (!x || x.status !== 'accepted') return res.redirect('/portails');
  const body = h`<div class="eb"><a href="/portails">Portails clients</a></div><h1>Preuve d'acceptation · ${x.number} v${x.version}</h1>
<section class="card mt20 mw680"><dl class="facts wide">
<dt>Accepté le</dt><dd>${ddmmyyyy(x.accepted_at)} à ${x.accepted_at.slice(11, 16)} (UTC)</dd><dt>Par</dt><dd>${x.accept_name} (${x.accept_quality})</dd>
<dt>E-mail vérifié</dt><dd>${x.signer_email} · code à usage unique validé le ${ddmmyyyy(x.email_verified_at)} à ${String(x.email_verified_at).slice(11, 16)}</dd>
<dt>Empreinte du devis</dt><dd class="mono">${x.pdf_sha256}</dd><dt>Empreinte des CGV</dt><dd class="mono">${x.cgv_sha256 || '—'}</dd>
<dt>Texte accepté</dt><dd>« ${x.accept_text} »</dd><dt>Adresse IP</dt><dd>${x.accept_ip}</dd><dt>Navigateur</dt><dd class="t12">${x.accept_ua}</dd><dt>Référence</dt><dd class="mono">${x.accept_ref}</dd>
<dt>Niveau</dt><dd>Signature électronique simple${x.test ? ' · PAGE DE TEST' : ''}</dd></dl>
<div class="line mt12"><a class="btn alt sm" href="/fichiers/${x.pdf}" target="_blank">Devis accepté (PDF)</a>${x.cgv ? h`<a class="btn alt sm" href="/fichiers/${x.cgv}" target="_blank">CGV</a>` : ''}<button class="btn alt sm" type="button" data-print>Imprimer</button></div></section>`;
  res.send(layout({ title: 'Preuve', tab: 'projets', sub: '/portails', body }));
});

// Espace client du projet : un lien privé, montré une seule fois.
r.post('/portails/espace/:pid/ouvrir', (req, res) => {
  const p = q.get('SELECT projects.*, clients.name cname, clients.email cemail FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.id = ?', req.params.pid);
  if (!p) return res.redirect('/portails');
  const t = token();
  q.run("UPDATE projects SET portal_token_hash = ?, portal_state = 'open' WHERE id = ?", sha256(t), p.id);
  logActivity(p.id, null, p.portal_state === 'open' ? 'Nouveau lien d’espace client créé (l’ancien est fermé)' : 'Espace client ouvert', 'Patron');
  q.run('UPDATE quotes SET treated = 1 WHERE project_id = ? AND status = ?', p.id, 'accepted');
  const url = `${base(req)}/p/espace/${t}`;
  req.session.shownLink = { title: `Espace client ouvert pour ${p.cname}`, url, to: p.cname,
    mailto: p.cemail ? `mailto:${encodeURIComponent(p.cemail)}?subject=${encodeURIComponent('Le suivi de votre projet')}&body=${encodeURIComponent(`Bonjour,\n\nVous pouvez suivre l'avancement de votre projet ici :\n${url}\n\nCe lien est personnel.\n\nCarchon Les Ateliers`)}` : '' };
  res.saveSession();
  res.redirect('/portails');
});
r.post('/portails/espace/:pid/couper', (req, res) => { q.run("UPDATE projects SET portal_state = 'cut', portal_token_hash = NULL WHERE id = ?", req.params.pid); res.flashTo('/portails', 'Accès coupé.'); });
r.get('/portails/espace/:pid/apercu', (req, res) => {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.pid);
  if (!p) return res.redirect('/portails');
  res.send(require('./client').renderSpace(p, { preview: true, tab: req.query.tab }));
});

module.exports = r;
