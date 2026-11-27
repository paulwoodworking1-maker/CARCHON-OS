'use strict';
// Portails clients côté patron : envoyer un devis à accepter, ouvrir / couper les espaces clients.
const express = require('express');
const fs = require('node:fs');
const { q, tx, setting, setSetting, logActivity, FAMILIES, SOURCES } = require('../db');
const Q = require('../qonto');
const { h, layout, pill, postBtn, options, ddmm, ddmmyyyy, addDays, today, rel } = require('../html');
const { token, sha256 } = require('../auth');
const { upload, uploadDocs, filePath } = require('../uploads');
const L = require('../logic');
const ai = require('../ai');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
// Adresse publique du logiciel (retenue pour pouvoir mettre les liens dans les SMS envoyés plus tard).
const base = (req) => {
  const u = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  if (!process.env.PUBLIC_URL && setting('public_url') !== u) setSetting('public_url', u);
  return u;
};
const testMode = () => setting('portal_test_mode') === '1';
const testEmails = () => (setting('portal_test_emails') || '').split(/[\s,;]+/).map((e) => e.toLowerCase()).filter(Boolean);

const E = require('../emails');
const mail = require('../mail');
const SMS = require('../sms');
const parseLines = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40).map((l) => {
  const m = l.match(/^(.*?)\s*[;|]\s*([^;|]*)$/);
  return m ? { d: m[1].trim(), q: m[2].trim() || '1' } : { d: l, q: '1' };
});
const linesText = (lines) => (lines || []).map((l) => `${l.d} ; ${l.q}`).join('\n');
const J = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };

// Où en est le client sur son devis : envoyé → ouvert → lu → code demandé → signé.
function quoteTrack(x) {
  const st = [['Envoyé', x.link_at || x.created_at], ['Ouvert', x.opened_at], ['Devis lu', x.pdf_opened_at], ['Code demandé', x.code_sent_at], ['Signé', x.accepted_at]];
  let last = 0; st.forEach((s, i) => { if (s[1]) last = i; });
  return { st, last };
}
const ago = (d) => (d ? rel(d) : '');
function trackCell(x) {
  const { st, last } = quoteTrack(x);
  const label = x.status === 'accepted' ? `Signé ${ago(x.accepted_at)}` : x.status === 'modif' ? 'Demande de modification' : x.status === 'refused' ? 'Refusé'
    : x.status === 'revoked' ? 'Lien fermé' : x.status === 'expired' ? 'Lien expiré' : last === 0 ? 'Pas encore ouvert' : `${st[last][0]} ${ago(st[last][1])}`;
  return h`<div class="track" title="${st.map((s) => `${s[0]} : ${s[1] ? ddmm(s[1]) + ' ' + String(s[1]).slice(11, 16) : '—'}`).join('\n')}">${st.map((s, i) => h`<i class="${s[1] ? 'on' : ''}${i === st.length - 1 && x.status === 'accepted' ? ' ok' : ''}"></i>`)}</div>
<b class="t13">${label}</b>${x.views && x.status === 'sent' ? h`<div class="mut t12">ouvert ${x.views} fois${x.last_seen_at ? ` · dernière visite ${ago(x.last_seen_at)}` : ''}</div>` : ''}`;
}

const SUB = 'portails';
const SMS_ST = { attente: ['wa', 'SMS prévu'], envoye: ['ok', 'SMS envoyé'], echec: ['ko', 'SMS en échec'], test: ['no', 'SMS (test, non envoyé)'], non_branche: ['no', 'SMS non branché'] };
function smsLine(...targets) {
  const s = SMS.lastFor(...targets);
  if (!s) return '';
  const [k, l] = SMS_ST[s.status] || ['no', s.status];
  return h`<div class="t12 mt4" title="${s.text || ''}${s.error ? '\n' + s.error : ''}">${pill(k, l)} <span class="mut">${s.status === 'attente' ? `vers ${String(s.send_after).slice(11, 16)}` : rel(s.sent_at)}</span></div>`;
}
const warnMail = () => (!testMode() && !mail.configured() ? h`<div class="flash ko mt12">Les clients ne peuvent pas recevoir leur code de validation : l’envoi d’e-mails n’est pas encore branché. <a href="/portails/reglages#emails">Brancher Gmail (2 minutes)</a></div>` : '');

function shownCard(shown) {
  if (!shown) return '';
  // Le texte de l'e-mail est rédigé ici (trop long pour être gardé dans le cookie de session).
  const msg = shown.msg && E[shown.msg[0]] ? E[shown.msg[0]](shown.msg[1]) : null;
  if (msg) { shown.gmail = E.gmailUrl(shown.to, msg); shown.mailto = E.mailto(shown.to, msg); }
  return h`<section class="card ok-card mt20" role="status"><b>${shown.title}</b>
<p class="mut">Clique « Créer le brouillon Gmail » : le message est rédigé et rangé dans tes brouillons Gmail, tu n’as plus qu’à le relire et l’envoyer. Ce lien ne sera plus affiché ensuite (au besoin, « Relancer » en crée un nouveau).</p>
<div class="line mt8"><input class="qin" readonly value="${shown.url}" id="shownlink" aria-label="Lien">
${shown.gmail ? h`<a class="btn" href="${shown.gmail}" target="_blank" rel="noopener">Créer le brouillon Gmail</a>` : ''}<button type="button" class="btn alt" data-copy="#shownlink">Copier le lien</button></div>
${shown.mailto ? h`<p class="t12 mt8"><a class="mut" href="${shown.mailto}">Autre messagerie (Apple Mail, Outlook…)</a></p>` : ''}</section>`;
}

r.get('/portails', (req, res) => {
  if (req.query.nouveau === '1') return res.redirect('/portails/envoyer');
  if (req.query.reglages) return res.redirect('/portails/reglages');
  const quotes = q.all('SELECT quotes.*, projects.name projname FROM quotes LEFT JOIN projects ON projects.id = quotes.project_id ORDER BY quotes.created_at DESC');
  const responses = quotes.filter((x) => ['accepted', 'modif', 'refused'].includes(x.status) && !x.treated);
  const latest = new Map(); quotes.forEach((x) => { if (!latest.has(x.number)) latest.set(x.number, x); });
  const qs = [...latest.values()];
  const spaces = q.all("SELECT projects.*, clients.name cname, clients.email cemail FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.status = 'en_cours' ORDER BY projects.portal_seen_at DESC, projects.created_at DESC");
  const open = spaces.filter((p) => p.portal_state === 'open');
  const noSpace = spaces.filter((p) => p.portal_state !== 'open');
  const F = {
    tous: ['Tous en cours', qs.filter((x) => ['sent', 'modif', 'accepted'].includes(x.status) || (x.status === 'refused' && !x.treated))],
    attente: ['En attente de signature', qs.filter((x) => x.status === 'sent')],
    reponses: ['Réponses', qs.filter((x) => x.status === 'modif' || (x.status === 'refused' && !x.treated))],
    signes: ['Signés', qs.filter((x) => x.status === 'accepted')],
    fermes: ['Fermés ou expirés', qs.filter((x) => ['revoked', 'expired'].includes(x.status) || (x.status === 'refused' && x.treated))],
  };
  const f = F[req.query.f] || req.query.f === 'espaces' ? req.query.f : 'tous';
  const shown = req.session.shownLink;
  if (shown) { delete req.session.shownLink; res.saveSession(); }
  const quoteRow = (x) => h`<tr id="q${x.id}"><td><b>${x.signer_name}</b><div class="mut t13">${x.project_name || x.projname || ''}${x.test ? ' · test' : ''}</div></td>
<td class="t13">${x.number}${x.version > 1 ? ` · v${x.version}` : ''}<div class="mut t12">envoyé le ${ddmm(x.link_at || x.created_at)}${x.status === 'sent' ? ` · jusqu’au ${ddmm(x.valid_until)}` : ''}</div></td>
<td>${trackCell(x)}${smsLine(`q${x.id}`, ...(x.project_id ? [`p${x.project_id}`] : []))}</td>
<td><div class="line acts">${['sent', 'expired', 'revoked'].includes(x.status) ? postBtn(`/portails/devis/${x.id}/relancer`, 'Relancer', 'btn alt sm', {}, x.status === 'sent' ? 'Créer un nouveau lien et préparer une relance ? L’ancien lien ne marchera plus.' : '') : ''}
${x.status === 'modif' || x.status === 'refused' ? h`<a class="btn sm" href="/portails#q${x.id}r">Voir la demande</a>` : ''}
${x.status === 'accepted' ? h`<a class="btn alt sm" href="/portails/devis/${x.id}/preuve">Preuve</a>` : ''}${x.status === 'accepted' && x.project_id ? h`<a class="btn alt sm" href="/projets/${x.project_id}">OF</a>` : ''}
<a class="btn ghost sm" href="/portails/parcours?n=${encodeURIComponent(x.number)}${x.project_id ? `&p=${x.project_id}` : ''}">Parcours</a><a class="btn ghost sm" href="/fichiers/${x.pdf}" target="_blank">PDF</a>
${['sent', 'modif'].includes(x.status) ? postBtn(`/portails/devis/${x.id}/fermer`, 'Fermer', 'btn ghost sm', {}, 'Fermer ce devis ? Le client ne pourra plus l’accepter (par exemple si tu ne fais plus le projet).') : ''}</div></td></tr>`;
  const spaceRow = (p) => h`<tr id="p${p.id}"><td><b>${p.cname}</b><div class="mut t13">${p.name}</div></td><td class="t13">ouvert${p.portal_link_at ? ` le ${ddmm(p.portal_link_at)}` : ''}</td>
<td><b class="t13">${p.portal_views ? `Vu ${p.portal_views} fois` : 'Pas encore consulté'}</b>${p.portal_seen_at ? h`<div class="mut t12">dernière visite ${ago(p.portal_seen_at)}</div>` : ''}${smsLine(`p${p.id}`)}</td>
<td><div class="line acts">${postBtn(`/portails/espace/${p.id}/ouvrir`, 'Nouveau lien', 'btn alt sm', {}, 'Créer un nouveau lien ? L’ancien ne marchera plus.')}<a class="btn ghost sm" href="/portails/parcours?p=${p.id}">Parcours</a><a class="btn ghost sm" href="/portails/espace/${p.id}/apercu">Voir comme le client</a>
${postBtn(`/portails/espace/${p.id}/couper`, 'Couper l’accès', 'btn ghost sm', {}, 'Couper l’accès du client à son espace ?')}</div></td></tr>`;
  const rows = f === 'espaces' ? open : F[f][1];
  const body = h`
<p class="mut mw680">Tous les devis et espaces publiés, et où en est chaque client. Survole les points pour voir les dates exactes.</p>
${warnMail()}${shownCard(shown)}
${responses.length ? h`<section class="card mt20"><div class="line"><h2>Réponses des clients</h2>${pill('ko', responses.length)}</div>
${responses.map((x, i) => { const rj = J(x.response_json, null); return h`<div class="row${i ? '' : ' f'}" id="q${x.id}r"><span class="kind">${pill(x.status === 'accepted' ? 'ok' : x.status === 'refused' ? 'ko' : 'wa', x.status === 'accepted' ? 'Accepté' : x.status === 'refused' ? 'Refusé' : 'Modification')}</span>
<div class="grow"><b>${x.signer_name} · ${x.number}${x.project_name ? ` · ${x.project_name}` : ''}</b>${x.status === 'accepted' ? h`<span class="mut">Accepté le ${ddmm(x.accepted_at)} avec code e-mail · preuve conservée · la commande est créée</span>` : rj ? demandeView(rj) : h`<span class="mut">« ${x.response_text || ''} »</span>`}</div>
${x.status === 'accepted' && x.project_id ? postBtn(`/portails/espace/${x.project_id}/ouvrir`, 'Ouvrir son espace', 'btn sm') : ''}
${x.status === 'modif' ? h`<a class="btn sm" href="/portails/envoyer?depuis=${x.id}">Préparer la nouvelle version</a>` : ''}
${postBtn(`/portails/devis/${x.id}/traite`, 'Marquer traité', 'btn alt sm')}</div>`; })}</section>` : ''}
<div class="chips mt20" role="group" aria-label="Filtrer">${Object.entries(F).map(([k, [l, list]]) => h`<a class="chip${f === k ? ' on' : ''}" href="/portails?f=${k}">${l} · ${list.length}</a>`)}<a class="chip${f === 'espaces' ? ' on' : ''}" href="/portails?f=espaces">Espaces de suivi ouverts · ${open.length}</a>
<a class="btn push" href="/portails/envoyer">Envoyer un devis</a></div>
<div class="tablebox mt12"><table class="tbl dense portals"><thead><tr><th>Client · affaire</th><th>${f === 'espaces' ? 'Espace' : 'Devis'}</th><th>${f === 'espaces' ? 'Consultation' : 'Où en est le client'}</th><th>Actions</th></tr></thead><tbody>
${rows.map((x) => (f === 'espaces' ? spaceRow(x) : quoteRow(x)))}
${rows.length ? '' : h`<tr><td colspan="4" class="mut">Rien ici pour l’instant.</td></tr>`}</tbody></table></div>
${f === 'espaces' && noSpace.length ? h`<details class="card mt20"><summary class="b" style="cursor:pointer">Projets clients sans espace de suivi · ${noSpace.length}</summary>
${noSpace.map((p) => h`<div class="row"><div class="grow"><b>${p.cname}</b><span class="mut">${p.name}${p.portal_state === 'cut' ? ' · accès coupé' : ''}</span></div>${postBtn(`/portails/espace/${p.id}/ouvrir`, 'Ouvrir l’espace', 'btn alt sm')}</div>`)}</details>` : ''}
<p class="mut t12 mt8">« Relancer » crée un nouveau lien et prépare l’e-mail de relance dans Gmail. « Fermer » rend le devis non valable : le client ne peut plus l’accepter. « Couper l’accès » ferme un espace de suivi tout de suite.</p>`;
  res.send(layout({ title: 'Portails clients', heading: 'Portails clients', tab: SUB, sub: '/portails', body, flash: req.flash }));
});

// Demande de modification structurée, telle que le client l'a remplie.
function demandeView(rj) {
  return h`<div class="demande">${(rj.lines || []).filter((l) => l.action !== 'garder').map((l) => h`<div>${pill(l.action === 'retirer' ? 'ko' : 'wa', l.action === 'retirer' ? 'Retirer' : 'Modifier')} <b>${l.d}</b>${l.q2 && l.q2 !== l.q ? ` · quantité ${l.q} → ${l.q2}` : ''}${l.note ? ` · « ${l.note} »` : ''}</div>`)}
${(rj.topics || []).length ? h`<div><span class="mut">Sujets :</span> ${rj.topics.join(', ')}</div>` : ''}
${rj.add ? h`<div><span class="mut">À ajouter :</span> « ${rj.add} »</div>` : ''}
${rj.budget ? h`<div><span class="mut">Budget souhaité :</span> ${rj.budget}</div>` : ''}${rj.date ? h`<div><span class="mut">Date souhaitée :</span> ${ddmmyyyy(rj.date)}</div>` : ''}
${rj.reason ? h`<div><span class="mut">Motif :</span> ${rj.reason}</div>` : ''}${rj.text ? h`<div>« ${rj.text} »</div>` : ''}</div>`;
}

// Parcours client : rendez-vous, prises de cotes, échanges, affichés sur son portail.
const KINDS = [['rdv', 'Rendez-vous'], ['cotes', 'Prise de cotes'], ['plans', 'Plans et esquisses'], ['visite', 'Visite de l’atelier'], ['echange', 'Échange'], ['autre', 'Autre étape']];
r.get('/portails/parcours', (req, res) => {
  const pid = Number(req.query.p) || null;
  const n = str(req.query.n);
  const p = pid ? q.get('SELECT projects.*, clients.name cname FROM projects LEFT JOIN clients ON clients.id = projects.client_id WHERE projects.id = ?', pid) : null;
  const qt = n ? q.get('SELECT * FROM quotes WHERE number = ? ORDER BY version DESC LIMIT 1', n) : p ? q.get('SELECT * FROM quotes WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id) : null;
  if (!p && !qt) return res.redirect('/portails');
  const number = n || qt?.number || '';
  const log = q.all(`SELECT * FROM client_log WHERE ${p ? 'project_id = ? OR ' : ''}(number != '' AND number = ?) ORDER BY date DESC, id DESC`, ...(p ? [p.id] : []), number);
  const back = `/portails/parcours?${p ? `p=${p.id}&` : ''}n=${encodeURIComponent(number)}`;
  const body = h`<div class="eb"><a href="/portails">Portails clients</a></div><h1 class="mt8">Parcours · ${p ? p.cname || p.name : qt.signer_name}</h1>
<p class="mut mt8 mw680">Ce que vous avez fait ensemble et ce qui est prévu : le client le voit sur l'accueil de son portail, avec les versions du devis, l'acompte et l'avancement (ajoutés tout seuls). Une date à venir s'affiche comme prochaine étape.</p>
${(() => {
    const cl = p?.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : qt?.client_id ? q.get('SELECT * FROM clients WHERE id = ?', qt.client_id) : null;
    const phone = cl?.phone || qt?.signer_phone || '';
    return h`<form method="post" action="/portails/telephone" class="card warm form mt20 mw680"><input type="hidden" name="back" value="${back}"><input type="hidden" name="client_id" value="${cl ? cl.id : ''}"><input type="hidden" name="quote_number" value="${number}">
<b>SMS de suivi</b><p class="mut t13">Le client reçoit un SMS court à chaque nouveauté sur son portail (devis, rendez-vous, photo, document, acompte, fabrication, pose).</p>
<div class="grid2"><label>Son portable <input type="tel" name="phone" value="${phone}" placeholder="06 12 34 56 78"></label>
<label class="ck" style="align-self:end"><input type="checkbox" name="sms_on" value="1" ${cl?.sms_off ? '' : 'checked'}> Envoyer les SMS à ce client</label></div>
<button class="btn alt sm">Enregistrer</button></form>`;
  })()}
<form method="post" action="/portails/parcours" class="card form mt20 mw680"><input type="hidden" name="back" value="${back}"><input type="hidden" name="p" value="${p ? p.id : ''}"><input type="hidden" name="n" value="${number}">
<div class="grid2"><label>Date <input type="date" name="date" value="${today()}" required></label><label>Type <select name="kind">${options(KINDS)}</select></label></div>
<label>Titre (vu par le client) <input name="title" placeholder="ex. Prise de cotes chez vous, Présentation des esquisses…"></label>
<label>Détail (facultatif, vu par le client) <input name="note" placeholder="ex. Mesures de la niche : 212 × 248 cm. Choix du noyer."></label>
<button class="btn sm">Ajouter au parcours</button></form>
<section class="card mt20 mw680"><h2>Déjà sur son portail</h2>${log.map((e, i) => h`<div class="row${i ? '' : ' f'}"><span class="kind">${pill(e.date > today() ? 'wa' : 'no', e.date > today() ? 'À venir' : ddmm(e.date))}</span><div class="grow"><b>${e.title || KINDS.find((k) => k[0] === e.kind)?.[1]}</b><span class="mut">${(KINDS.find((k) => k[0] === e.kind) || [])[1] || ''}${e.note ? ` · ${e.note}` : ''}${e.date > today() ? ` · le ${ddmm(e.date)}` : ''}</span></div>
${postBtn(`/portails/parcours/${e.id}/suppr`, 'Retirer', 'btn ghost sm', { back }, 'Retirer cette étape du portail ?')}</div>`)}${log.length ? '' : h`<p class="mut">Rien encore. Ajoute par exemple le premier rendez-vous et la prise de cotes.</p>`}</section>`;
  res.send(layout({ title: 'Parcours client', tab: SUB, sub: '/portails', body, flash: req.flash }));
});
r.post('/portails/parcours', (req, res) => {
  const b = req.body;
  const kind = KINDS.some((k) => k[0] === b.kind) ? b.kind : 'autre';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(b.date))) {
    const title = str(b.title) || KINDS.find((k) => k[0] === kind)[1];
    q.run('INSERT INTO client_log (number, project_id, date, kind, title, note) VALUES (?, ?, ?, ?, ?, ?)', str(b.n), Number(b.p) || null, str(b.date), kind, title, str(b.note));
    const qid = str(b.n) ? q.get('SELECT id FROM quotes WHERE number = ? ORDER BY version DESC LIMIT 1', str(b.n))?.id : null;
    const target = Number(b.p) ? { projectId: Number(b.p) } : { quoteId: qid };
    if (str(b.date) > today()) SMS.notify('rdv', { ...target, date: ddmm(str(b.date)), titre: title });
    else SMS.notify('maj', { ...target, quoi: `compte rendu : ${title.toLowerCase()}` });
  }
  res.flashTo(String(b.back || '/portails').startsWith('/portails') ? b.back : '/portails', 'Ajouté : le client le voit sur son portail.');
});
r.post('/portails/telephone', (req, res) => {
  const b = req.body;
  if (Number(b.client_id)) q.run('UPDATE clients SET phone = ?, sms_off = ? WHERE id = ?', str(b.phone), b.sms_on ? 0 : 1, Number(b.client_id));
  if (str(b.quote_number)) q.run('UPDATE quotes SET signer_phone = ? WHERE number = ?', str(b.phone), str(b.quote_number));
  const ok = !str(b.phone) || SMS.normalize(b.phone);
  res.flashTo(String(b.back || '/portails').startsWith('/portails') ? b.back : '/portails', ok ? 'Portable enregistré.' : 'Numéro enregistré, mais il ne ressemble pas à un portable (06… ou 07…).', ok ? 'ok' : 'ko');
});
r.post('/portails/parcours/:id/suppr', (req, res) => {
  q.run('DELETE FROM client_log WHERE id = ?', req.params.id);
  res.flashTo(String(req.body.back || '/portails').startsWith('/portails') ? req.body.back : '/portails', 'Retiré.');
});

r.get('/portails/reglages', (req, res) => {
  const configured = mail.configured();
  const body = h`
<section class="card mw680" id="emails" style="border-top:0;padding-top:0"><h2>E-mails aux clients</h2>
${configured ? h`<p class="mt8">${pill('ok', 'Branché')} Les codes de validation partent de <b>${mail.fromAddress()}</b> ${mail.via() === 'brevo' ? '(via Brevo)' : mail.via() === 'gmail' ? '(via Gmail)' : ''}.</p>
<form method="post" action="/portails/test-email" class="line mt12"><button class="btn alt sm">M’envoyer un e-mail de test</button><span class="mut t12">à l’adresse du patron (Automatisations)</span></form>`
  : h`<p class="mt8">${pill('ko', 'Pas encore branché')} Sans cela, le client ne reçoit pas son code et ne peut pas signer en mode réel. Deux solutions, une seule suffit :</p>
<h3 class="mt12">Solution A · Brevo (la même clé que pour les SMS)</h3>
<ol class="steps mt8">
<li>Dans Brevo : menu en haut à droite › <b>Expéditeurs, domaines et IP dédiées</b> › <b>Expéditeurs</b> › Ajouter un expéditeur : nom « ${require('../db').company().name} », et l’adresse qui enverra les codes. Brevo t’envoie un code pour la valider.</li>
<li>Idéal contre les indésirables : une adresse de ton domaine (ex. contact@carchon.com) et, dans <b>Domaines</b>, « Authentifier le domaine » (Brevo donne 2 ou 3 lignes à copier chez l’hébergeur du site).</li>
<li>Dans Render › Environment : <code>BREVO_API_KEY</code> (si ce n’est pas déjà fait) et <code>MAIL_FROM</code> = l’adresse validée. Save, rebuild and deploy.</li></ol>
${process.env.BREVO_API_KEY && !mail.sender() ? h`<p class="flash ko mt8">La clé Brevo est là, il ne manque que l’adresse d’expédition (MAIL_FROM, ou l’e-mail dans Réglages › Entreprise).</p>` : ''}
<h3 class="mt12">Solution B · Gmail</h3>
<ol class="steps mt8">
<li>Validation en deux étapes activée sur ton compte Google.</li>
<li>Mot de passe d’application : <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> (vérifie en haut à droite que c’est le bon compte Google), nom « Carchon OS ». Copie les 16 lettres.</li>
<li>Dans Render › Environment : <code>GMAIL_USER</code> = ton adresse Gmail, <code>GMAIL_APP_PASSWORD</code> = les 16 lettres. Save, rebuild and deploy.</li></ol>`}
<form method="post" action="/portails/gmail" class="form mt20"><label>Compte Gmail où ranger les brouillons (devis, relances, liens de suivi) <input type="email" name="gmail_account" value="${setting('gmail_account') || ''}" placeholder="ton.adresse@gmail.com"></label>
<p class="mut t12">Si tu es connecté à plusieurs comptes Google dans ton navigateur, c’est celui-ci qui s’ouvrira.</p><button class="btn sm">Enregistrer</button></form></section>

<section class="card mt20 mw680" id="sms"><h2>SMS au client</h2>
${SMS.configured() ? h`<p class="mt8">${pill('ok', 'Branché')} Les SMS partent via Brevo, au nom de <b>${setting('sms_sender') || 'CARCHON'}</b>.</p>`
  : h`<p class="mt8">${pill('ko', 'Pas encore branché')} Les SMS sont préparés et visibles dans le suivi, mais ne partent pas.</p>
<ol class="steps mt12"><li>Crée un compte gratuit sur <a href="https://www.brevo.com/fr/" target="_blank" rel="noopener">brevo.com</a> (société française), puis achète un pack de SMS (environ 4,5 centimes le SMS en France, sans abonnement).</li>
<li>Dans Brevo, déclare ton nom d’expéditeur « CARCHON » (menu SMS › Expéditeurs) : c’est ce que verra le client à la place d’un numéro.</li>
<li>Crée une clé API : menu en haut à droite › <b>SMTP et API</b> › <b>Clés API</b> › Générer.</li>
<li>Dans Render › carchon-os › <b>Environment</b>, ajoute <code>BREVO_API_KEY</code> = cette clé, puis <b>Save, rebuild and deploy</b>.</li></ol>`}
<form method="post" action="/portails/sms" class="form mt12">
<label class="ck"><input type="checkbox" name="enabled" value="1" ${SMS.enabled() ? 'checked' : ''}> Prévenir les clients par SMS à chaque nouveauté sur leur portail</label>
<div class="grid2"><label>Nom d’expéditeur (11 caractères, sans espace) <input name="sender" maxlength="11" value="${setting('sms_sender') || 'CARCHON'}"></label><label>Signature dans le texte <input name="signature" value="${setting('sms_signature') || require('../db').company().name}"></label></div>
<p class="mut t12">Chaque SMS attend ${SMS.DELAY_MIN} minutes avant de partir : si tu fais plusieurs choses d’affilée, le client ne reçoit qu’un SMS qui les résume. Aucun SMS la nuit (20 h – 8 h) ni le dimanche : il part le lendemain matin.</p>
${Object.entries(SMS.EVENTS).map(([k, [label, def]]) => h`<fieldset class="smsev"><label class="ck"><input type="checkbox" name="on_${k}" value="1" ${SMS.eventOn(k) ? 'checked' : ''}> <b>${label}</b></label>
<textarea name="tpl_${k}" rows="2" maxlength="300">${SMS.template(k)}</textarea><span class="mut t12">Exemple : ${SMS.compose({ event: k, vars: JSON.stringify({ quoi: 'nouvelle photo', date: '12/12', titre: 'prise de cotes', numero: 'D-2026-0399' }) }).replace('le lien reçu par e-mail', 'https://…/p/espace/…')}</span></fieldset>`)}
<p class="mut t12">Mots remplacés automatiquement : {atelier} {projet} {numero} {quoi} {date} {titre} {lien}. Gardez les messages courts : 160 caractères = 1 SMS.</p>
<label>En mode test, numéros autorisés (séparés par des virgules) <input name="test_phones" value="${setting('sms_test_phones') || ''}" placeholder="ton portable"></label>
<div class="line"><button class="btn sm">Enregistrer</button></div></form>
${SMS.configured() ? h`<form method="post" action="/portails/sms/test" class="line mt12"><label class="sr" for="smsto">Portable</label><input id="smsto" name="to" type="tel" placeholder="Ton portable" required style="max-width:220px"><button class="btn alt sm">M’envoyer un SMS de test</button></form>` : ''}</section>

<section class="card mt20 mw680" id="qonto"><h2>Facture d’acompte automatique (Qonto)</h2>
${Q.configured() ? h`<p class="mt8">${pill('ok', 'Relié à Qonto')} Dès qu’un client accepte son devis sur le portail, la facture d’acompte est créée dans Qonto (numéro automatique) et envoyée au client par e-mail depuis Qonto. Quand Qonto la voit payée, l’acompte passe à « reçu » et les achats bloqués se débloquent.</p>
<form method="post" action="/portails/qonto/test" class="line mt12"><button class="btn alt sm">Tester la liaison</button></form>`
  : h`<p class="mt8">${pill('ko', 'Pas encore relié')} Pour que la facture parte toute seule :</p>
<ol class="steps mt8"><li>Dans Qonto (app.qonto.com) : <b>Paramètres › Intégrations et partenariats › Clé API</b>. Note ton <b>identifiant</b> et génère la <b>clé secrète</b>.</li>
<li>Dans Render › carchon-os › <b>Environment</b> : <code>QONTO_LOGIN</code> = l’identifiant, <code>QONTO_SECRET_KEY</code> = la clé secrète. Save, rebuild and deploy.</li></ol>`}
<form method="post" action="/portails/qonto" class="form mt12">
<label class="ck"><input type="checkbox" name="auto" value="1" ${setting('qonto_auto_deposit', '1') === '1' ? 'checked' : ''}> Créer et envoyer la facture d’acompte dès l’acceptation du devis</label>
<div class="grid2"><label>Acompte (% du montant HT) <input name="percent" inputmode="decimal" value="${Q.opts().percent}"></label><label>TVA (%) <input name="vat" inputmode="decimal" value="${Q.opts().vat}"></label></div>
<div class="grid2"><label>À régler sous (jours) <input name="due" inputmode="numeric" value="${Q.opts().dueDays}"></label><label>IBAN (vide = compte principal Qonto) <input name="iban" value="${setting('qonto_iban', '')}"></label></div>
<label>Objet de l’e-mail <input name="title" value="${Q.opts().title}"></label>
<label>Message <textarea name="body" rows="7">${Q.opts().body}</textarea></label>
<p class="mut t12">Mots remplacés : {prenom} {projet} {devis} {pourcent} {montant} {echeance} {entreprise}. Le montant HT doit être indiqué à l’envoi du devis. Les devis de test ne créent jamais de facture.</p>
<button class="btn sm">Enregistrer</button></form></section>

<section class="card mt20 mw680"><h2>${testMode() ? 'Mode test' : 'Mode réel'}</h2>
<form method="post" action="/portails/reglages" enctype="multipart/form-data" class="form mt12"><label class="ck"><input type="checkbox" name="test" value="1" ${testMode() ? 'checked' : ''}> Mode test (pages marquées « sans valeur contractuelle », seules les adresses de test reçoivent un lien)</label>
<label>Adresses de test, séparées par des virgules <input name="emails" value="${setting('portal_test_emails') || ''}"></label>
<label>Conditions générales de vente (PDF, jointes à chaque devis) <input type="file" name="cgv" accept="application/pdf"></label>
${setting('cgv_file') ? h`<p class="mut">CGV actuelles : <a href="/fichiers/${setting('cgv_file')}" target="_blank">ouvrir</a></p>` : h`<p class="mut red">Aucune CGV déposée pour l’instant.</p>`}
<button class="btn sm">Enregistrer</button></form>
<p class="mut t12 mt8">Le passage en réel se fait après l'avis de ton juriste.</p></section>`;
  res.send(layout({ title: 'Réglages des portails', heading: 'Portails clients', tab: SUB, sub: '/portails/reglages', body, flash: req.flash }));
});
r.post('/portails/qonto', (req, res) => {
  const b = req.body; const n = (v) => Number(String(v ?? '').replace(',', '.'));
  setSetting('qonto_auto_deposit', b.auto ? '1' : '0');
  if (n(b.percent) > 0 && n(b.percent) <= 100) setSetting('deposit_percent', String(n(b.percent)));
  if (n(b.vat) >= 0 && n(b.vat) <= 30 && str(b.vat) !== '') setSetting('deposit_vat', String(n(b.vat)));
  if (n(b.due) >= 0 && str(b.due) !== '') setSetting('deposit_due_days', String(Math.round(n(b.due))));
  setSetting('qonto_iban', str(b.iban).replace(/\s/g, '').toUpperCase());
  setSetting('deposit_mail_title', str(b.title).slice(0, 200));
  setSetting('deposit_mail_body', String(b.body || '').trim().slice(0, 3000));
  res.flashTo('/portails/reglages#qonto', 'Réglages de la facture d’acompte enregistrés.');
});
r.post('/portails/qonto/test', async (req, res) => {
  try { const t = await Q.test(); res.flashTo('/portails/reglages#qonto', `Liaison Qonto OK : ${t.name}${t.iban ? ` · IBAN ${t.iban.slice(0, 4)}…${t.iban.slice(-4)}` : ''}.`); }
  catch (e) { res.flashTo('/portails/reglages#qonto', e.message, 'ko'); }
});
r.post('/portails/sms', (req, res) => {
  const b = req.body;
  setSetting('sms_enabled', b.enabled ? '1' : '0');
  setSetting('sms_sender', str(b.sender).replace(/[^A-Za-z0-9]/g, '').slice(0, 11) || 'CARCHON');
  setSetting('sms_signature', str(b.signature));
  setSetting('sms_test_phones', str(b.test_phones));
  for (const k of Object.keys(SMS.EVENTS)) {
    setSetting(`sms_on_${k}`, b[`on_${k}`] ? '1' : '0');
    const tpl = str(b[`tpl_${k}`]);
    setSetting(`sms_tpl_${k}`, tpl && tpl !== SMS.EVENTS[k][1] ? tpl : '');
  }
  res.flashTo('/portails/reglages#sms', 'Réglages des SMS enregistrés.');
});
r.post('/portails/sms/test', async (req, res) => {
  const to = SMS.normalize(req.body.to);
  if (!to) return res.flashTo('/portails/reglages#sms', 'Numéro de portable non reconnu.', 'ko');
  try { await SMS.sendNow(to, `${setting('sms_signature') || require('../db').company().name} : ceci est un SMS de test de Carchon OS. Tout fonctionne.`); res.flashTo('/portails/reglages#sms', 'SMS de test envoyé : regarde ton téléphone.'); }
  catch (e) { res.flashTo('/portails/reglages#sms', `Échec : ${e.message}`, 'ko'); }
});
r.post('/portails/gmail', (req, res) => { setSetting('gmail_account', str(req.body.gmail_account)); res.flashTo('/portails/reglages', 'Compte Gmail enregistré.'); });
r.post('/portails/test-email', async (req, res) => {
  const to = setting('patron_email') || process.env.SMTP_USER;
  try {
    await mail.send({ to, ...E.otp({ number: 'TEST', signer_name: 'Test' }, '123456') });
    res.flashTo('/portails/reglages', `E-mail de test envoyé à ${to}. Regarde ta boîte de réception : c’est exactement ce que reçoit le client.`);
  } catch (e) { res.flashTo('/portails/reglages', `Échec de l’envoi : ${e.message}. Vérifie GMAIL_USER et GMAIL_APP_PASSWORD dans Render.`, 'ko'); }
});

r.get('/portails/envoyer', (req, res) => {
  let draft = req.session.draftQuote || null;
  // Nouvelle version d'un devis dont le client a demandé une modification.
  if (!draft && req.query.depuis) {
    const x = q.get('SELECT * FROM quotes WHERE id = ?', req.query.depuis);
    if (x) draft = { number: x.number, project_name: x.project_name, signer_name: x.signer_name, signer_email: x.signer_email, lines: J(x.lines, []), project_id: x.project_id, from: x.id };
  }
  const from = draft?.from ? q.get('SELECT * FROM quotes WHERE id = ?', draft.from) : null;
  const body = h`${warnMail()}
<section class="card" id="envoi" style="border-top:0;padding-top:0"><div class="line"><h2>Envoyer un devis au client</h2>${draft ? h`<a class="push btn alt sm" href="/portails/devis/annuler">Repartir de zéro</a>` : ''}</div>
${from && from.response_json ? h`<div class="card warm mt12 mw680"><b>Ce que le client a demandé</b>${demandeView(J(from.response_json, {}))}</div>` : ''}
${ai.enabled() && !draft?.pdf ? h`<form method="post" action="/portails/devis/lire" enctype="multipart/form-data" class="card warm form mt12 mw680" data-busy="L’assistant lit le devis…">
<b>Le plus rapide : dépose le PDF, l’assistant remplit le reste (y compris les lignes).</b>
<input type="file" name="pdf" accept="application/pdf" required aria-label="PDF du devis"><button class="btn alt sm">Lire le devis</button></form>` : ''}
${draft?.resume ? h`<p class="mut mt12">Lu par l’assistant : ${draft.resume}${draft.montant ? ` · ${draft.montant}` : ''}${draft.acompte ? ` · acompte ${draft.acompte}` : ''}. Vérifie avant de créer le lien.</p>` : ''}
<form method="post" action="/portails/devis" enctype="multipart/form-data" class="form mt12 mw680">
<div class="grid2"><label>N° du devis <input name="number" required placeholder="D-(2026)-00399" value="${draft?.number || ''}"></label><label>Projet (nom court) <input name="project_name" placeholder="ex. Table à manger · chêne" value="${draft?.project_name || ''}"></label></div>
${draft?.pdf ? h`<p class="mut">PDF du devis déposé ✓ <a href="/portails/devis/annuler?nouveau=1">changer</a></p>` : h`<label>PDF du devis${from ? ' (nouvelle version)' : ''} (exporté de Qonto) <input type="file" name="pdf" accept="application/pdf" required></label>`}
<div class="grid2"><label>Qui signe <input name="signer_name" required value="${draft?.signer_name || ''}"></label><label>Son e-mail <input type="email" name="signer_email" required value="${draft?.signer_email || ''}"></label></div>
<div class="grid2"><label>Montant HT (€) <input name="amount_ht" inputmode="decimal" value="${draft?.amount_ht ?? ''}" placeholder="ex. 8400"></label><label>Famille <select name="family"><option value="">—</option>${options(FAMILIES, draft?.family)}</select></label></div>
<label>Comment ce client t'a trouvé <select name="source"><option value="">—</option>${options(SOURCES, draft?.source)}</select></label>
<label>Son portable (pour les SMS de suivi, facultatif) <input type="tel" name="signer_phone" placeholder="06 12 34 56 78" value="${draft?.signer_phone || ''}"></label>
<label>Lignes du devis, une par ligne : « désignation ; quantité » <textarea name="lines" rows="5" placeholder="Table à manger chêne 220 × 95 cm ; 1&#10;Allonges 50 cm ; 2&#10;Livraison et installation ; 1">${linesText(draft?.lines)}</textarea></label>
<p class="mut t12">Facultatif, mais conseillé : le client pourra ajuster chaque ligne (modifier, retirer, changer la quantité) au lieu d’écrire un long message.</p>
<fieldset class="card warm m0"><legend class="b">Pour préparer la fabrication (facultatif)</legend>
<p class="mut t13">À la signature, l’assistant lit le devis et ces fichiers, puis crée les pièces, le carnet de fabrication et la liste de matière à commander. Le planning démarre quand toute la matière est livrée.</p>
<label>Modèle 3D : STEP (TopSolid, Rhino…) ou Rhino .3dm <input type="file" name="modele3d" multiple accept=".step,.stp,.3dm,.igs,.iges"></label>
<label>Vues et plans : PDF ou images <input type="file" name="plan3d" multiple accept=".pdf,.png,.jpg,.jpeg,.webp"></label>
<label>Nomenclature, liste de débit ou chiffrage : CSV, Excel ou PDF <input type="file" name="chiffrage" multiple accept=".csv,.xlsx,.txt,.pdf"></label>
${draft?.extra?.length ? h`<p class="mut t12">Déjà joints : ${draft.extra.map((f) => f.name).join(', ')}</p>` : ''}
${from ? (() => { const prevFiles = q.all('SELECT name FROM quote_files WHERE number = ?', from.number); return prevFiles.length ? h`<p class="mut t12">Fichiers de la version précédente repris : ${prevFiles.map((f) => f.name).join(', ')}</p>` : ''; })() : ''}
<p class="mut t12">Le modèle 3D est mesuré pièce par pièce (longueur × largeur × épaisseur) et affiché dans l’OF. Garde un nom par pièce et un calque (ou sous-ensemble) par ensemble : la nomenclature en sera plus juste.</p></fieldset>
<label>Rattacher à un projet existant (nouvelle version) <select name="project_id"><option value="">Non : l’acceptation crée la commande</option>${options(q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name").map((p) => [p.id, p.name]), draft?.project_id)}</select></label>
<fieldset class="chips m0"><legend>Valable</legend>${['15', '30'].map((d) => h`<label class="chip"><input type="radio" name="days" value="${d}" ${d === '30' ? 'checked' : ''}>${d} jours</label>`)}</fieldset>
<ul class="mut checklist"><li>PDF du devis repris tel quel, empreinte calculée</li><li>CGV jointes ${setting('cgv_file') ? '' : '(aucune CGV déposée : à ajouter dans Réglages)'}</li><li>Le client accepte exactement ce document</li><li>Même numéro qu’un devis déjà envoyé : l’ancien lien se ferme tout seul</li></ul>
<div class="line"><button class="btn">Créer le lien et préparer l’e-mail</button>
${testMode() && draft?.signer_email && !testEmails().includes(String(draft.signer_email).toLowerCase()) ? h`<button class="btn alt" name="allow_test" value="1">Autoriser cette adresse et envoyer</button>` : ''}</div></form></section>`;
  res.send(layout({ title: 'Envoyer un devis', heading: 'Portails clients', tab: SUB, sub: '/portails/envoyer', body, flash: req.flash }));
});

r.post('/portails/reglages', upload.single('cgv'), (req, res) => {
  setSetting('portal_test_mode', req.body.test ? '1' : '0');
  setSetting('portal_test_emails', str(req.body.emails));
  if (req.file) setSetting('cgv_file', req.file.filename);
  res.flashTo('/portails/reglages', 'Réglages du portail enregistrés.');
});

// L'assistant lit le PDF et prépare le formulaire.
r.post('/portails/devis/lire', upload.single('pdf'), async (req, res, next) => {
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo('/portails/envoyer', 'Il faut un PDF.', 'ko');
  try {
    const x = await ai.readQuotePdf(fs.readFileSync(req.file.path));
    req.session.draftQuote = { ...(req.session.draftQuote || {}), pdf: req.file.filename, number: x.numero, signer_name: x.client_nom, signer_email: x.client_email, project_name: x.objet, resume: x.resume, montant: x.montant_ttc, acompte: x.acompte, amount_ht: x.montant_ht ? String(x.montant_ht).replace(/[^\d,.]/g, '') : '',
      lines: (x.lignes || []).map((l) => ({ d: l.designation, q: l.quantite || '1' })) };
    res.saveSession();
    res.redirect('/portails/envoyer');
  } catch (e) {
    req.session.draftQuote = { ...(req.session.draftQuote || {}), pdf: req.file.filename };
    res.saveSession();
    if (e instanceof ai.AIError) return res.flashTo('/portails/envoyer', `${e.message} Le PDF est gardé : remplis les champs à la main.`, 'ko');
    next(e);
  }
});
r.get('/portails/devis/annuler', (req, res) => {
  const d = req.session.draftQuote;
  if (d?.pdf) fs.rmSync(filePath(d.pdf), { force: true });
  delete req.session.draftQuote; res.saveSession();
  res.redirect('/portails/envoyer');
});

r.post('/portails/devis', uploadDocs.fields([{ name: 'pdf', maxCount: 1 }, { name: 'modele3d', maxCount: 4 }, { name: 'plan3d', maxCount: 10 }, { name: 'chiffrage', maxCount: 6 }]), (req, res) => {
  const b = req.body;
  const extra = [...(req.files?.modele3d || []).map((f) => ({ kind: 'modele3d', file: f.filename, name: f.originalname })), ...(req.files?.plan3d || []).map((f) => ({ kind: 'plan3d', file: f.filename, name: f.originalname })), ...(req.files?.chiffrage || []).map((f) => ({ kind: 'chiffrage', file: f.filename, name: f.originalname }))];
  req.file = req.files?.pdf?.[0];
  if (req.file && !/\.pdf$/i.test(req.file.originalname)) req.file = null;
  const draft = req.session.draftQuote;
  if (!req.file && draft?.pdf) req.file = { filename: draft.pdf, path: filePath(draft.pdf) };
  delete req.session.draftQuote;
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo('/portails/envoyer', 'Il faut le PDF du devis.', 'ko');
  const email = str(b.signer_email).toLowerCase();
  const isTest = testMode();
  if (isTest && req.body.allow_test && email) setSetting('portal_test_emails', [...new Set([...testEmails(), email])].join(', '));
  if (isTest && !testEmails().includes(email)) {
    // On garde le PDF et ce qui a été saisi : il suffit d'autoriser l'adresse puis de renvoyer.
    req.session.draftQuote = { ...(draft || {}), pdf: req.file.filename, amount_ht: str(b.amount_ht), family: str(b.family), source: str(b.source), number: str(b.number), project_name: str(b.project_name), signer_name: str(b.signer_name), signer_email: email, signer_phone: str(b.signer_phone), lines: parseLines(b.lines), project_id: b.project_id || null, extra: [...(draft?.extra || []), ...extra] };
    return res.flashTo('/portails/envoyer', `Mode test : ${email} n’est pas une adresse de test. Clique « Autoriser cette adresse et envoyer », ou passe le portail en mode réel dans Réglages.`, 'ko');
  }
  const number = str(b.number);
  const prev = q.get('SELECT * FROM quotes WHERE number = ? ORDER BY version DESC LIMIT 1', number);
  const t = token();
  const cgv = setting('cgv_file');
  const days = b.days === '15' ? 15 : 30;
  const projectId = b.project_id ? Number(b.project_id) : prev?.project_id || null;
  let newId;
  tx(() => {
    if (prev) q.run("UPDATE quotes SET status = 'revoked', treated = 1 WHERE number = ? AND status IN ('sent', 'modif', 'refused')", number);
    newId = Number(q.run(`INSERT INTO quotes (project_id, client_id, number, version, pdf, pdf_sha256, cgv, cgv_sha256, signer_name, signer_email, project_name, valid_until, token_hash, test, lines, link_at, token_enc, signer_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`, projectId, prev?.client_id || null, number, prev ? prev.version + 1 : 1, req.file.filename, sha256(fs.readFileSync(req.file.path)),
    cgv, cgv ? sha256(fs.readFileSync(filePath(cgv))) : null, str(b.signer_name), email, str(b.project_name) || prev?.project_name || '', addDays(today(), days), sha256(t), isTest ? 1 : 0, JSON.stringify(parseLines(b.lines)), SMS.seal(t), str(b.signer_phone) || prev?.signer_phone || '').lastInsertRowid);
  });
  { const a = Number(str(b.amount_ht).replace(/[\s\u00a0\u202f€]/g, '').replace(',', '.'));
    q.run('UPDATE quotes SET amount_ht = ?, family = ?, source = ? WHERE id = ?', str(b.amount_ht) && Number.isFinite(a) ? a : prev?.amount_ht ?? null,
      FAMILIES.includes(b.family) ? b.family : prev?.family || '', SOURCES.includes(b.source) ? b.source : prev?.source || '', newId); }
  // Vues 3D et nomenclature / chiffrage : gardés avec le devis, l'assistant s'en sert à l'acceptation.
  for (const f of [...(draft?.extra || []), ...extra]) q.run('INSERT INTO quote_files (number, kind, file, name) VALUES (?, ?, ?, ?)', number, f.kind, f.file, f.name);
  SMS.notify('devis', { quoteId: newId });
  const url = `${base(req)}/p/devis/${t}`;
  req.session.shownLink = { title: `Lien d’acceptation créé pour ${str(b.signer_name)} · valable ${days} jours`, url, to: email,
    msg: ['quote', { name: str(b.signer_name), number, project: str(b.project_name) || prev?.project_name || '', url, until: addDays(today(), days) }] };
  res.saveSession();
  res.redirect('/portails');
});

r.post('/portails/devis/:id/fermer', (req, res) => {
  const x = q.get('SELECT * FROM quotes WHERE id = ?', req.params.id);
  q.run("UPDATE quotes SET status = 'revoked', treated = 1 WHERE id = ? AND status IN ('sent', 'modif')", req.params.id);
  if (x?.project_id) logActivity(x.project_id, null, `Devis ${x.number} fermé (non valable)`, 'Patron');
  res.flashTo('/portails?f=fermes', 'Devis fermé : le client ne peut plus l’accepter.');
});
// Relance : nouveau lien (l'ancien ne marche plus) et e-mail de relance prêt dans Gmail.
r.post('/portails/devis/:id/relancer', (req, res) => {
  const x = q.get('SELECT * FROM quotes WHERE id = ?', req.params.id);
  if (!x || !['sent', 'expired', 'revoked'].includes(x.status)) return res.redirect('/portails');
  const t = token();
  const until = x.valid_until >= addDays(today(), 7) ? x.valid_until : addDays(today(), 15);
  q.run("UPDATE quotes SET token_hash = ?, token_enc = ?, status = 'sent', valid_until = ?, treated = 1, link_at = datetime('now') WHERE id = ?", sha256(t), SMS.seal(t), until, x.id);
  SMS.notify('devis', { quoteId: x.id });
  const url = `${base(req)}/p/devis/${t}`;
  req.session.shownLink = { title: `Relance prête pour ${x.signer_name} · lien valable jusqu’au ${ddmm(until)}`, url, to: x.signer_email,
    msg: ['relance', { name: x.signer_name, number: x.number, project: x.project_name, url, until }] };
  res.saveSession();
  res.redirect('/portails');
});
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
  res.send(layout({ title: 'Preuve', tab: 'portails', sub: '/portails', body }));
});

// Espace client du projet : un lien privé, montré une seule fois.
r.post('/portails/espace/:pid/ouvrir', (req, res) => {
  const p = q.get('SELECT projects.*, clients.name cname, clients.email cemail FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.id = ?', req.params.pid);
  if (!p) return res.redirect('/portails');
  const t = token();
  q.run("UPDATE projects SET portal_token_hash = ?, portal_token_enc = ?, portal_state = 'open', portal_link_at = datetime('now') WHERE id = ?", sha256(t), SMS.seal(t), p.id);
  if (p.portal_state !== 'open') SMS.notify('espace', { projectId: p.id });
  logActivity(p.id, null, p.portal_state === 'open' ? 'Nouveau lien d’espace client créé (l’ancien est fermé)' : 'Espace client ouvert', 'Patron');
  q.run('UPDATE quotes SET treated = 1 WHERE project_id = ? AND status = ?', p.id, 'accepted');
  const url = `${base(req)}/p/espace/${t}`;
  req.session.shownLink = { title: `Espace de suivi ouvert pour ${p.cname}`, url, to: p.cemail, msg: ['space', { name: p.cname, project: p.name, url }] };
  res.saveSession();
  res.redirect('/portails?f=espaces');
});
r.post('/portails/espace/:pid/couper', (req, res) => { q.run("UPDATE projects SET portal_state = 'cut', portal_token_hash = NULL, portal_token_enc = NULL WHERE id = ?", req.params.pid); res.flashTo('/portails?f=espaces', 'Accès coupé.'); });
r.get('/portails/espace/:pid/apercu', (req, res) => {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.pid);
  if (!p) return res.redirect('/portails');
  res.send(require('./client').renderSpace(p, { preview: true, tab: req.query.tab }));
});

module.exports = r;
