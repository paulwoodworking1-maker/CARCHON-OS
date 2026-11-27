'use strict';
// Portail client (liens privés, sans compte) : accepter un devis, suivre son projet.
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { q, tx, setting, logActivity, company } = require('../db');
const { h, page, ddmm, ddmmyyyy, dayMonth, today } = require('../html');
const { sha256, verify, hash, throttle, fail } = require('../auth');
const { filePath, isImage, sendUpload } = require('../uploads');
const mail = require('../mail');
const L = require('../logic');
const M = require('../messages');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const J = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };
r.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); next(); });

const siteUrl = (s) => (/^https?:\/\//.test(s) ? s : `https://${s}`);
// Habillage commun : logo et référence du dossier en tête, e-mail de contact en pied.
const shell = (title, inner, test, ref = '') => {
  const c = company(); const mail = M.t('portail_email');
  return page(title, h`<div class="phone">
<header class="cl-head"><a href="${siteUrl(c.site)}" target="_blank" rel="noopener" aria-label="${c.name}, site web"><img src="/static/logo.png" alt="Carchon Les Ateliers"></a>${ref ? h`<span class="cl-ref">${ref}</span>` : ''}</header>
${test ? h`<div class="testband">Page de test — sans valeur contractuelle.</div>` : ''}
${inner}
<footer class="cl-foot"><p>${M.t('portail_pied')}</p>${mail ? h`<a class="cl-mail" href="mailto:${mail}">${mail}</a>` : ''}
<a class="cl-site" href="${siteUrl(c.site)}" target="_blank" rel="noopener">${c.site}</a></footer></div>`, { bodyClass: 'client' });
};
// « Bonsoir Mme Schifano Stéphanie »
const C = require('../civilite');
const greeting = (client, fallbackName) => { const id = C.identity(client, fallbackName); return M.t('portail_titre', { salutation: C.salutation(), civilite: id.civ, nom: id.last, prenom: id.first }); };
// Le nom du projet n'est rappelé que s'il dit autre chose que le nom du client.
const sameAsClient = (projName, client, fallbackName) => { const a = C.split(projName || ''); const b = C.identity(client, fallbackName); return !projName || (C.tidy(a.first) === b.first && C.tidy(a.last) === b.last) || C.tidy(projName) === C.tidy(client?.name || fallbackName || ''); };

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
  const flash = req.flash ? h`<div class="flash ${req.flash.kind}">${req.flash.text}</div>` : '';
  // Une fois le client passé (signé, modification demandée…), le lien ouvre l'accueil de son portail.
  if (x.status !== 'sent' || req.query.tab) {
    if (x.status === 'revoked' && !q.get("SELECT id FROM quotes WHERE number = ? AND version > ?", x.number, x.version) && !x.project_id) {
      return res.send(shell('Devis', h`<main class="cl"><h1>Devis n° ${x.number}</h1><p>Ce devis n’est plus valable. Pour toute question, contactez l’atelier.</p></main>`, x.test));
    }
    const p = x.project_id ? q.get('SELECT * FROM projects WHERE id = ?', x.project_id) : null;
    return res.send(renderSpace(p, { quote: x, token: t, tab: req.query.tab || 'accueil', flash }));
  }
  q.run("UPDATE quotes SET opened_at = COALESCE(opened_at, datetime('now')), last_seen_at = datetime('now'), views = views + 1 WHERE id = ?", x.id);
  const verified = (req.session.vq || []).includes(x.id) && x.email_verified_at;
  const showCode = x.test && !mail.configured() && req.session.testCode?.[x.id];
  const c = company();
  const Q = require('../qonto');
  const amounts = x.amount_ht > 0 ? Q.depositAmounts(x.amount_ht) : null;
  const vat = Q.opts().vat;
  const E0 = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;
  const stepState = (n) => (n === 1 ? (x.pdf_opened_at ? 'd' : 'c') : n === 2 ? (verified ? 'd' : x.pdf_opened_at || x.code_sent_at ? 'c' : '') : verified ? 'c' : '');
  const bill = J(x.billing_json, {});
  const client = x.client_id ? q.get('SELECT * FROM clients WHERE id = ?', x.client_id) : null;
  const needBill = Q.on() && !x.test;
  res.send(shell(`Devis ${x.number}`, h`<main class="cl">${flash}
<h1>${greeting(client, x.signer_name)}</h1>
<p class="cl-meta">${sameAsClient(x.project_name, client, x.signer_name) ? '' : `${x.project_name} · `}Votre devis n° ${x.number}${x.version > 1 ? `, version ${x.version}` : ''} du ${ddmmyyyy(x.link_at || x.created_at)}</p>
${tabsHtml(`/p/devis/${t}`, 'devis', true)}
<dl class="cl-sum">
${amounts ? h`<div><dt>Montant HT</dt><dd>${E0(x.amount_ht)}<small>${E0(x.amount_ht * (1 + vat / 100))} TTC</small></dd></div>
<div><dt>Acompte ${amounts.percent}\u00a0%</dt><dd>${E0(amounts.ttc)}<small>TTC à la commande</small></dd></div>` : ''}
<div><dt>Valable jusqu’au</dt><dd>${ddmm(x.valid_until)}<small>${x.valid_until.slice(0, 4)}</small></dd></div>
</dl>
<ol class="cl-prog" aria-label="Étapes">${[[1, 'Lire'], [2, 'Code'], [3, 'Accepter']].map(([n, l]) => h`<li class="${stepState(n)}"><span>${stepState(n) === 'd' ? '✓' : n}</span>${l}</li>`)}</ol>
<details class="howto" ${x.views <= 1 ? 'open' : ''}><summary>Comment ça marche ? <span class="mut">2 minutes, sans compte</span></summary>
<p class="mut">Lisez le devis, recevez un code par e-mail pour prouver que c’est bien vous, puis acceptez.${amounts && Q.on() ? ' La facture d’acompte vous arrive aussitôt par e-mail.' : ''} Vous souhaitez changer quelque chose ? « Demander une modification », en bas de page.${c.phone ? ` Une question : ${c.phone}.` : ''}</p></details>
<section class="cl-step"><h2><span class="n">1</span>Lisez le devis</h2>
<div class="cl-btns"><a class="btn wfull" href="/p/devis/${t}/pdf" target="_blank">Ouvrir le devis (PDF)</a>
${x.cgv ? h`<a class="btn alt wfull" href="/p/devis/${t}/cgv" target="_blank">Conditions générales de vente</a>` : ''}</div></section>
<section class="cl-step${verified ? ' ok' : ''}"><h2><span class="n">2</span>Recevez votre code</h2>
${verified ? h`<p class="cl-ok">Adresse e-mail vérifiée ✓</p>` : h`<p class="mut">Un code à 6 chiffres part à ${maskEmail(x.signer_email)} (pensez aux indésirables).</p>
<form method="post" action="/p/devis/${t}/code"><button class="btn ${x.code_sent_at ? 'alt ' : ''}wfull">${x.code_sent_at ? 'Renvoyer un code' : 'Recevoir mon code'}</button></form>
${showCode ? h`<p class="testband">Mode test : votre code est <b>${showCode}</b></p>` : ''}
${x.code_sent_at ? h`<form method="post" action="/p/devis/${t}/verifier" class="form mt8"><label>Code reçu <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="••••••" class="code-in"></label><button class="btn wfull">Valider le code</button></form>` : ''}`}</section>
<section class="cl-step${verified ? '' : ' dim'}"><h2><span class="n">3</span>Acceptez le devis</h2>
${verified ? '' : h`<p class="mut">Disponible dès que votre code est validé.</p>`}
<form method="post" action="/p/devis/${t}/accepter" class="form">
<div class="grid2"><label>Nom et prénom <input name="name" value="${x.signer_name}" required ${verified ? '' : 'disabled'} autocomplete="name"></label>
<label>Qualité <select name="quality" ${verified ? '' : 'disabled'}><option>Particulier</option><option>Représentant d’une entreprise</option><option>Architecte mandaté</option></select></label></div>
<fieldset class="cl-bill"><legend>Adresse de facturation</legend>
<label>Société (si la facture est à son nom) <input name="b_company" value="${bill.company || ''}" ${verified ? '' : 'disabled'} autocomplete="organization"></label>
<label>Adresse <input name="b_street" value="${bill.street || client?.address || ''}" ${needBill ? 'required' : ''} ${verified ? '' : 'disabled'} autocomplete="street-address"></label>
<div class="grid2 cp"><label>Code postal <input name="b_zip" value="${bill.zip || ''}" inputmode="numeric" ${needBill ? 'required' : ''} ${verified ? '' : 'disabled'} autocomplete="postal-code"></label><label>Ville <input name="b_city" value="${bill.city || ''}" ${needBill ? 'required' : ''} ${verified ? '' : 'disabled'} autocomplete="address-level2"></label></div></fieldset>
<label class="ck top"><input type="checkbox" name="consent" value="1" required ${verified ? '' : 'disabled'}> <span class="t13">${acceptText(x)}</span></label>
<button class="btn wfull" ${verified ? '' : 'disabled'}>J’accepte le devis${amounts ? ` · ${Q.eur(x.amount_ht * (1 + vat / 100))} TTC` : ''}</button>
${amounts && Q.on() && !x.test ? h`<p class="mut t12 center">Vous recevrez aussitôt par e-mail la facture d’acompte de ${Q.eur(amounts.ttc)} TTC.</p>` : ''}</form></section>
<section class="cl-step"><h2>Vous souhaitez changer quelque chose ?</h2><p class="mut">Dimensions, essence, finition, délai… ligne par ligne : nous vous renvoyons une nouvelle version.</p>
<a class="btn alt wfull" href="/p/devis/${t}/modifier">Demander une modification</a></section>
</main>`, x.test, `Devis ${x.number}`));
});

// Demande de modification guidée : ligne par ligne, puis sujets, puis message libre.
const TOPICS = ['Dimensions', 'Essence de bois', 'Finition ou teinte', 'Quantité', 'Délai ou date', 'Budget', 'Livraison ou pose', 'Autre'];
r.get('/devis/:t/modifier', (req, res) => {
  const x = findQuote(req);
  if (!x || x.status !== 'sent') return res.redirect(`/p/devis/${req.params.t}`);
  const t = req.params.t;
  const lines = J(x.lines, []);
  const flash = req.flash ? h`<div class="flash ${req.flash.kind}">${req.flash.text}</div>` : '';
  res.send(shell('Modifier le devis', h`<main class="cl">${flash}
<h1>Demander une modification</h1><p class="cl-meta">Devis n° ${x.number} · version ${x.version}</p>
<p class="mut">Indiquez simplement ce que vous souhaitez changer. Nous vous renvoyons une nouvelle version du devis par e-mail, en général sous 48 h ouvrées.</p>
<form method="post" action="/p/devis/${t}/repondre" class="form">
<input type="hidden" name="kind" value="modif">
${lines.length ? h`<section class="cl-step"><h2>Les lignes de votre devis</h2><p class="mut t13">Pour chaque ligne : on garde, on modifie ou on retire.</p>
${lines.map((l, i) => h`<div class="mline"><b>${l.d}</b><span class="mut t13">Quantité : ${l.q}</span>
<div class="seg3" role="radiogroup" aria-label="${l.d}">${[['garder', 'Garder'], ['modifier', 'Modifier'], ['retirer', 'Retirer']].map(([v, lab]) => h`<label><input type="radio" name="a${i}" value="${v}" ${v === 'garder' ? 'checked' : ''}><span>${lab}</span></label>`)}</div>
<div class="mdet"><label>Nouvelle quantité <input name="q${i}" inputmode="numeric" value="${l.q}"></label><label>Ce que vous souhaitez <input name="n${i}" placeholder="ex. 180 cm au lieu de 200, en noyer…"></label></div></div>`)}</section>` : ''}
<section class="cl-step"><h2>${lines.length ? 'Autre chose ?' : 'Qu’aimeriez-vous changer ?'}</h2>
<div class="chips m0">${TOPICS.map((tp) => h`<label class="chip"><input type="checkbox" name="topics" value="${tp}">${tp}</label>`)}</div>
<label>Ajouter un élément au devis <input name="add" placeholder="ex. une étagère supplémentaire, un tiroir…"></label>
<div class="grid2"><label>Budget souhaité (facultatif) <input name="budget" placeholder="ex. 3 500 € TTC"></label><label>Date souhaitée (facultatif) <input type="date" name="date"></label></div>
<label>Votre message <textarea name="text" rows="4" placeholder="Expliquez avec vos mots : nous lisons tout."></textarea></label></section>
<button class="btn wfull">Envoyer ma demande</button>
<p class="mut t12">Rien n’est engagé : vous recevrez une nouvelle version à accepter.</p></form>
<details class="cl-step"><summary class="b">Je préfère ne pas donner suite</summary>
<form method="post" action="/p/devis/${t}/repondre" class="form mt8"><input type="hidden" name="kind" value="refused">
<label>Pour quelle raison ? (facultatif) <select name="reason"><option value="">—</option><option>Le prix</option><option>Le délai</option><option>Le projet est reporté</option><option>J’ai choisi une autre solution</option><option>Autre</option></select></label>
<label>Un mot pour l’atelier (facultatif) <textarea name="text" rows="2"></textarea></label><button class="btn alt wfull">Décliner ce devis</button></form></details>
<p class="mt12"><a href="/p/devis/${t}">← Revenir au devis</a></p></main>`, x.test));
});

function sendQuoteFile(kind) {
  return (req, res) => {
    const x = findQuote(req);
    const f = x && (kind === 'pdf' ? x.pdf : x.cgv);
    if (!f || !fs.existsSync(filePath(f))) return res.status(404).send('Introuvable');
    if (kind === 'pdf') q.run("UPDATE quotes SET pdf_opened_at = COALESCE(pdf_opened_at, datetime('now')), last_seen_at = datetime('now') WHERE id = ?", x.id);
    res.type('application/pdf').sendFile(filePath(f));
  };
}
r.get('/devis/:t/pdf', sendQuoteFile('pdf'));
r.get('/devis/:t/cgv', sendQuoteFile('cgv'));

r.post('/devis/:t/code', async (req, res, next) => {
  const back = `/p/devis/${req.params.t}`;
  try {
    const x = findQuote(req);
    if (!x || x.status !== 'sent') return res.redirect(back);
    const canShow = x.test && !mail.configured();
    if (!mail.configured() && !canShow) {
      const c = company();
      return res.flashTo(back, `L’envoi du code est momentanément indisponible. Contactez l’atelier${c.phone ? ` au ${c.phone}` : ''} : nous réglons cela tout de suite.`, 'ko');
    }
    // Pas plus d'un code par minute (double clic, impatience).
    if (x.code_sent_at && q.get("SELECT datetime('now', '-60 seconds') < ? recent", x.code_sent_at).recent && !canShow) {
      return res.flashTo(back, `Un code vient de vous être envoyé à ${maskEmail(x.signer_email)}. Il peut mettre une minute à arriver : regardez aussi dans les indésirables (spam).`);
    }
    // Au plus 8 codes par devis et 8 par adresse IP toutes les 10 minutes (pas d'inondation de la boîte du client).
    const kq = `otp:${x.id}`, ki = `otp-ip:${req.ip}`;
    if (throttle(kq) || throttle(ki)) return res.flashTo(back, 'Trop de codes demandés. Réessayez dans 10 minutes.', 'ko');
    fail(kq); fail(ki);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    q.run("UPDATE quotes SET otp_hash = ?, otp_expires = datetime('now', '+15 minutes'), otp_tries = 0, code_sent_at = datetime('now'), last_seen_at = datetime('now') WHERE id = ?", hash(code), x.id);
    try {
      await mail.send({ to: x.signer_email, ...require('../emails').otp(x, code) });
    } catch (e) {
      console.error('[code devis] envoi impossible', e.message);
      const c = company();
      return res.flashTo(back, `Le code n’a pas pu être envoyé. Réessayez dans un instant, ou contactez l’atelier${c.phone ? ` au ${c.phone}` : ''}.`, 'ko');
    }
    if (canShow) { req.session.testCode = { ...(req.session.testCode || {}), [x.id]: code }; }
    res.flashTo(back, `Code envoyé à ${maskEmail(x.signer_email)}. Il arrive en général en moins d’une minute ; sinon, regardez dans les indésirables (spam).`);
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
  const bill = { company: str(req.body.b_company).slice(0, 120), street: str(req.body.b_street).slice(0, 200), zip: str(req.body.b_zip).slice(0, 12), city: str(req.body.b_city).slice(0, 80), country: 'FR' };
  if (require('../qonto').on() && !x.test && (!bill.street || !bill.zip || !bill.city)) return res.flashTo(back, 'Indiquez votre adresse de facturation : elle figure sur la facture d’acompte.', 'ko');
  let pid;
  tx(() => {
    q.run('UPDATE quotes SET billing_json = ? WHERE id = ?', JSON.stringify(bill), x.id);
    q.run("UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), accept_name = ?, accept_quality = ?, accept_text = ?, accept_ip = ?, accept_ua = ?, accept_ref = ?, treated = 0 WHERE id = ?",
      str(req.body.name), str(req.body.quality) || 'Particulier', acceptText(x), req.ip, String(req.get('user-agent') || '').slice(0, 300), ref, x.id);
    pid = L.projectFromQuote(q.get('SELECT * FROM quotes WHERE id = ?', x.id));
    const cid = q.get('SELECT client_id FROM quotes WHERE id = ?', x.id).client_id;
    if (cid && bill.street) q.run("UPDATE clients SET address = ? WHERE id = ? AND COALESCE(address, '') = ''", [bill.company, bill.street, `${bill.zip} ${bill.city}`.trim()].filter(Boolean).join(', '), cid);
    logActivity(pid, null, `Devis ${x.number} v${x.version} accepté en ligne par ${str(req.body.name)} (réf. ${ref})`, 'Client');
  });
  afterAccept(x.id);
  if (!x.test) require('../qonto').afterAccept(pid);
  res.flashTo(back, M.t('portail_accepte', { reference: ref }));
});
// Après la signature : Cockpit est prévenu (facture d'acompte) et la chaîne de production se prépare.
function afterAccept(quoteId) {
  try {
    const x = q.get('SELECT * FROM quotes WHERE id = ?', quoteId);
    if (!x?.project_id) return;
    require('../cockpit').notify('devis.accepte', require('../cockpit').quotePayload(x));
    const p = q.get('SELECT * FROM projects WHERE id = ?', x.project_id);
    if (setting('chain_auto', '0') === '1' && require('../ai').enabled() && !p.prod_status && !q.get('SELECT id FROM steps WHERE project_id = ?', p.id)) require('../chain').start(p.id);
  } catch (e) { console.error('[après signature]', e); }
}

r.post('/devis/:t/repondre', (req, res) => {
  const x = findQuote(req);
  const t = req.params.t;
  if (!x || x.status !== 'sent') return res.redirect(`/p/devis/${t}`);
  const b = req.body;
  const refused = b.kind === 'refused';
  const lines = J(x.lines, []).map((l, i) => ({ d: l.d, q: l.q, action: ['modifier', 'retirer'].includes(b[`a${i}`]) ? b[`a${i}`] : 'garder', q2: str(b[`q${i}`]).slice(0, 20), note: str(b[`n${i}`]).slice(0, 300) }))
    .map((l) => (l.action === 'garder' && (l.note || (l.q2 && l.q2 !== l.q)) ? { ...l, action: 'modifier' } : l));
  const rj = refused ? { reason: str(b.reason).slice(0, 80), text: str(b.text).slice(0, 2000) }
    : { lines, topics: [].concat(b.topics || []).filter((tp) => TOPICS.includes(tp)), add: str(b.add).slice(0, 500), budget: str(b.budget).slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(str(b.date)) ? str(b.date) : '', text: str(b.text).slice(0, 2000) };
  const changes = refused ? [] : rj.lines.filter((l) => l.action !== 'garder');
  if (!refused && !changes.length && !rj.topics.length && !rj.add && !rj.budget && !rj.date && !rj.text) {
    return res.flashTo(`/p/devis/${t}/modifier`, 'Indiquez au moins une modification, un sujet ou un message.', 'ko');
  }
  // Résumé lisible (À décider, journal, assistant).
  const summary = refused ? [rj.reason, rj.text].filter(Boolean).join(' · ') || 'sans motif'
    : [...changes.map((l) => `${l.action === 'retirer' ? 'Retirer' : 'Modifier'} « ${l.d} »${l.q2 && l.q2 !== l.q ? ` (qté ${l.q} → ${l.q2})` : ''}${l.note ? ` : ${l.note}` : ''}`),
      rj.topics.length ? `Sujets : ${rj.topics.join(', ')}` : '', rj.add ? `Ajouter : ${rj.add}` : '', rj.budget ? `Budget : ${rj.budget}` : '', rj.date ? `Date souhaitée : ${ddmm(rj.date)}` : '', rj.text].filter(Boolean).join(' · ');
  q.run("UPDATE quotes SET status = ?, response_text = ?, response_json = ?, responded_at = datetime('now'), treated = 0 WHERE id = ?", refused ? 'refused' : 'modif', summary.slice(0, 2000), JSON.stringify(rj), x.id);
  if (x.project_id) logActivity(x.project_id, null, `${refused ? 'Devis décliné' : 'Modification demandée'} par le client : ${summary.slice(0, 200)}`, 'Client');
  res.flashTo(`/p/devis/${t}`, refused ? M.t('portail_refus_envoye') : M.t('portail_modif_envoyee'));
});

// ---------- Espace client ----------
const findSpace = (t) => q.get("SELECT * FROM projects WHERE portal_token_hash = ? AND portal_state = 'open'", sha256(String(t || '')));

const KIND = { rdv: 'Rendez-vous', cotes: 'Prise de cotes', plans: 'Plans et esquisses', echange: 'Échange', visite: 'Visite de l’atelier', autre: 'Étape' };
function tabsHtml(base, T, withQuote) {
  const tabs = [...(withQuote ? [['devis', 'Votre devis']] : []), ['accueil', 'Accueil'], ['photos', 'Photos'], ['documents', 'Documents']];
  return h`<nav class="cl-tabs">${tabs.map(([k, l]) => h`<a href="${base}${k === 'devis' ? '' : `?tab=${k}`}" class="${T === k ? 'on' : ''}">${l}</a>`)}</nav>`;
}

// Portail du client : accueil (prochaine étape, étapes, ce que nous avons fait ensemble), photos, documents.
// Accessible par le lien de l'espace de suivi, ou par le lien du devis une fois que le client a répondu.
function renderSpace(p, { token = null, preview = false, tab = 'accueil', quote: viaQuote = null, flash = '' } = {}) {
  const mode = preview ? 'apercu' : viaQuote ? 'devis' : 'espace';
  const baseUrl = mode === 'apercu' ? `/portails/espace/${p.id}/apercu` : mode === 'devis' ? `/p/devis/${token}` : `/p/espace/${token}`;
  const f = (name) => (mode === 'apercu' ? `/fichiers/${encodeURIComponent(name)}` : `${baseUrl}/f/${encodeURIComponent(name)}`);
  const vUrl = (x) => (mode === 'apercu' ? `/fichiers/${x.pdf}` : `${baseUrl}/v/${x.id}`);
  const client = p ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) || { name: '' } : { name: viaQuote.signer_name };
  const numbers = [...new Set([...(p ? q.all('SELECT DISTINCT number FROM quotes WHERE project_id = ?', p.id).map((x) => x.number) : []), ...(viaQuote ? [viaQuote.number] : [])])];
  const quotes = numbers.length ? q.all(`SELECT * FROM quotes WHERE number IN (${numbers.map(() => '?').join(',')}) ORDER BY number, version`, ...numbers) : [];
  const latest = quotes.length ? quotes.reduce((a, x) => (x.version >= a.version ? x : a)) : null;
  const accepted = quotes.filter((x) => x.status === 'accepted').pop() || null;
  const log = q.all(`SELECT * FROM client_log WHERE ${p ? 'project_id = ? OR ' : ''}(number != '' AND number IN (${numbers.map(() => '?').join(',') || "''"})) ORDER BY date, id`, ...(p ? [p.id] : []), ...numbers);
  const t = today();
  const fr = p ? L.frise(p) : [];
  const st = (ph) => fr.find((x) => x.phase === ph)?.state;
  const trip = p ? q.get('SELECT * FROM trips WHERE project_id = ? ORDER BY date LIMIT 1', p.id) : null;
  const started = p ? q.get('SELECT MIN(started_at) s FROM steps WHERE project_id = ? AND started_at IS NOT NULL', p.id).s : null;
  const remaining = p ? q.get("SELECT COUNT(*) n FROM steps WHERE project_id = ? AND status != 'done' AND COALESCE(phase, '') NOT IN ('Livraison', 'Réception')", p.id).n : 1;
  const anySteps = p ? q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ?', p.id).n : 0;
  const fabDone = anySteps > 0 && remaining === 0;
  const quoteOk = !!accepted || (p && !quotes.some((x) => x.status === 'sent'));
  const depositOk = p ? !p.deposit_needed || !!p.deposit_at : false;
  const events = p ? q.all('SELECT * FROM events WHERE project_id = ? AND show_client = 1 AND date >= ? ORDER BY date', p.id, t) : [];
  const upcoming = [...log.filter((e) => e.date >= t).map((e) => ({ date: e.date, title: e.title || KIND[e.kind], note: e.note })), ...events.map((e) => ({ date: e.date, title: e.title, note: e.detail })),
    ...(trip && !trip.done_at && trip.date >= t ? [{ date: trip.date, title: 'Pose chez vous', note: '' }] : [])].sort((x, y) => x.date.localeCompare(y.date));

  // 1. La prochaine étape, en une phrase (textes : Messages aux clients).
  const nx = (k, vars, extra = {}) => ({ t: M.t(`${k}_titre`, vars), d: M.t(`${k}_texte`, vars), ...extra });
  let next;
  if (latest && latest.status === 'sent' && !accepted) next = nx('next_devis', { version: latest.version, date_limite: dayMonth(latest.valid_until), date_envoi: dayMonth(latest.link_at || latest.created_at) },
    mode === 'devis' && viaQuote.id === latest.id ? { href: baseUrl, cta: 'Voir mon devis', you: true } : { you: true });
  else if (latest && latest.status === 'modif') next = nx('next_modif', { date: dayMonth(latest.responded_at) });
  else if (latest && latest.status === 'refused' && !accepted) next = nx('next_refus', {});
  else if (p && !depositOk) {
    const inv = p.deposit_invoice_id ? null : q.get("SELECT * FROM documents WHERE project_id = ? AND kind = 'facture_acompte' AND visible_client = 1 ORDER BY id DESC LIMIT 1", p.id);
    if (p.deposit_invoice_id) next = nx('next_acompte_facture', { montant: require('../qonto').eur(p.deposit_invoice_ttc || 0), numero: p.deposit_invoice_number, echeance: p.deposit_invoice_due ? dayMonth(p.deposit_invoice_due) : '' },
      { you: true, ...(p.deposit_invoice_url ? { href: p.deposit_invoice_url, cta: 'Voir la facture et payer', ext: true } : {}) });
    else if (inv) next = nx('next_acompte_facture', { montant: inv.amount, numero: inv.number, echeance: '' }, { href: f(inv.file), cta: 'Voir la facture d’acompte', you: true });
    else next = nx('next_acompte_attente', {}, { you: true });
  }
  else if (upcoming[0]) next = { t: upcoming[0].title, d: `Le ${dayMonth(upcoming[0].date)}${upcoming[0].note ? ` · ${upcoming[0].note}` : ''}.` };
  else if (p && fabDone) next = trip ? nx('next_prete', { date_pose: dayMonth(trip.date) }) : { t: M.t('next_prete_titre'), d: M.t('next_prete_sans_date') };
  else if (p && started) next = nx('next_fabrication', { date_prete: p.ready_date ? dayMonth(p.ready_date) : '' });
  else if (p) next = nx('next_preparation', { date_prete: p.ready_date ? dayMonth(p.ready_date) : '' });
  else next = nx('next_recu', {});
  if (!next.t) next = null; // texte vidé dans « Messages aux clients » : pas d'encadré

  // 2. Les grandes étapes du projet.
  const steps = [
    [M.t('etape_1'), log.some((e) => e.date <= t) || quotes.length || p ? 'd' : 'c'],
    [M.t('etape_2'), quoteOk ? 'd' : 'c', accepted ? `accepté le ${dayMonth(accepted.accepted_at)}` : latest?.status === 'modif' ? 'nouvelle version en préparation' : ''],
    [M.t('etape_3'), depositOk ? 'd' : quoteOk ? 'c' : 't', p?.deposit_at ? `reçu le ${dayMonth(p.deposit_at)}` : p?.deposit_invoice_id ? `facture envoyée le ${dayMonth(p.deposit_invoice_sent_at || today())}` : ''],
    [M.t('etape_4'), fabDone ? 'd' : started ? 'c' : 't', started && !fabDone ? `depuis le ${dayMonth(started)}` : ''],
    [M.t('etape_5'), fabDone ? 'd' : 't', !fabDone && p?.ready_date ? `vers le ${dayMonth(p.ready_date)}` : ''],
    [M.t('etape_6'), trip?.done_at ? 'd' : trip ? 'c' : 't', trip ? `le ${dayMonth(trip.date)}` : ''],
    [M.t('etape_7'), trip?.pv_signed_at ? 'd' : 't', trip?.pv_signed_at ? `le ${dayMonth(trip.pv_signed_at)}` : ''],
  ];

  // 3. Ce que nous avons fait ensemble (le plus récent en haut).
  const hist = [
    ...log.filter((e) => e.date <= t).map((e) => ({ at: e.date, kind: KIND[e.kind] || 'Étape', t: e.title, d: e.note })),
    ...quotes.flatMap((x) => [
      { at: x.link_at || x.created_at, w: 1, kind: 'Devis', t: `Devis n° ${x.number}${x.version > 1 ? ` · version ${x.version}` : ''} envoyé`, href: vUrl(x) },
      x.responded_at && x.status !== 'accepted' && { at: x.responded_at, w: 2, kind: 'Votre demande', t: x.status === 'refused' ? 'Vous avez décliné le devis' : 'Vous avez demandé une modification', d: x.response_text },
      x.accepted_at && { at: x.accepted_at, w: 3, kind: 'Devis', t: `Vous avez accepté le devis${x.version > 1 ? ` (version ${x.version})` : ''}`, d: `Référence ${x.accept_ref}` },
    ]).filter(Boolean),
    p?.deposit_invoice_sent_at && { at: p.deposit_invoice_sent_at, kind: 'Facture', t: `Facture d’acompte ${p.deposit_invoice_number || ''} envoyée`, ...(p.deposit_invoice_url ? { href: p.deposit_invoice_url, hl: 'Voir la facture' } : {}) },
    p?.deposit_at && { at: p.deposit_at, kind: 'Acompte', t: 'Acompte reçu' },
    started && { at: started, kind: 'Atelier', t: 'Début de la fabrication' },
    trip?.done_at && { at: trip.done_at, kind: 'Pose', t: 'Pose réalisée' },
    trip?.pv_signed_at && { at: trip.pv_signed_at, kind: 'Réception', t: 'Réception de la pièce' },
  ].filter(Boolean).sort((x, y) => String(y.at).localeCompare(String(x.at)) || (y.w || 0) - (x.w || 0));

  const photos = p ? q.all('SELECT * FROM photos WHERE project_id = ? AND shared_client = 1 ORDER BY created_at DESC', p.id) : [];
  const docs = p ? q.all('SELECT * FROM documents WHERE project_id = ? AND visible_client = 1 ORDER BY id DESC', p.id) : [];
  const pvs = p ? q.all('SELECT * FROM trips WHERE project_id = ? AND pv_signed_at IS NOT NULL', p.id) : [];
  const withQuoteTab = mode === 'devis' && viaQuote.status === 'sent';
  const T = ['accueil', 'photos', 'documents'].includes(tab) ? tab : tab === 'projet' || tab === 'suivi' ? (tab === 'suivi' ? 'photos' : 'accueil') : 'accueil';
  const co = company();
  const inner = h`<main class="cl">${flash}
${preview ? h`<div class="testband">Aperçu patron : c’est ce que voit ${client.name}. <a href="/portails?f=espaces">Revenir</a></div>` : ''}
<h1>${greeting(p ? client : null, client.name)}</h1>${(() => { const pn = p ? p.name : viaQuote.project_name; return pn && !sameAsClient(pn, p ? client : null, client.name) ? h`<p class="cl-meta">${pn}</p>` : ''; })()}
${tabsHtml(baseUrl, T, withQuoteTab)}
${T === 'accueil' ? h`
${next ? h`<section class="next-box${next.you ? ' you' : ''}"><span class="cl-eyebrow">${next.you ? 'À faire de votre côté' : 'Prochaine étape'}</span><h2>${next.t}</h2><p>${next.d}</p>${next.href ? h`<a class="btn wfull" href="${next.href}"${next.ext ? h` target="_blank" rel="noopener"` : ''}>${next.cta}</a>` : ''}</section>` : ''}
${upcoming.length > (next?.t === upcoming[0]?.title ? 1 : 0) ? h`<section class="cl-step"><h2>À venir</h2>${upcoming.map((e) => h`<div class="hrow"><span class="hdate">${ddmm(e.date)}</span><div><b>${e.title}</b>${e.note ? h`<p class="mut">${e.note}</p>` : ''}</div></div>`)}</section>` : ''}
<section class="cl-step"><h2>Les étapes de votre projet</h2><ol class="vsteps">${steps.map(([l, s2, sub]) => h`<li class="${s2 === 'd' ? 'd' : s2 === 'c' ? 'c' : ''}"><span class="mk">${s2 === 'd' ? '✓' : ''}</span><b>${l}</b><span class="mut">${sub || (s2 === 'd' ? 'Fait' : s2 === 'c' ? 'En cours' : 'À venir')}</span></li>`)}</ol></section>
<section class="cl-step"><h2>Ce que nous avons fait ensemble</h2>
${hist.length ? hist.map((e) => h`<div class="hrow"><span class="hdate">${ddmm(e.at)}</span><div><span class="hkind">${e.kind}</span><b>${e.t}</b>${e.d ? h`<p class="mut">${e.d}</p>` : ''}${e.href ? h`<a class="t13 hlink" href="${e.href}" target="_blank" rel="noopener">${e.hl || 'Voir le PDF'}</a>` : ''}</div></div>`) : h`<p class="mut">L’historique de votre projet apparaîtra ici.</p>`}</section>
${photos.length ? h`<section class="cl-step"><h2>Dernières photos</h2><div class="cl-photos">${photos.slice(0, 4).map((x) => h`<figure><img src="${f(x.file)}" alt="${x.title}" loading="lazy"><figcaption>${x.title}</figcaption></figure>`)}</div><a class="t13" href="${baseUrl}?tab=photos">Toutes les photos</a></section>` : ''}
<section class="cl-step"><h2>Une question ?</h2><p class="mut">${M.t('portail_question')}</p></section>` : ''}
${T === 'photos' ? h`<section class="cl-step"><h2>Photos de l’atelier</h2>${photos.length ? h`<div class="cl-photos">${photos.map((x) => h`<figure><a href="${f(x.file)}" target="_blank"><img src="${f(x.file)}" alt="${x.title}" loading="lazy"></a><figcaption>${x.title} · ${ddmm(x.created_at)}</figcaption></figure>`)}</div>` : h`<p class="mut">${M.t('portail_photos_vide')}</p>`}
<p class="mut t12">Seules les photos que l’atelier choisit de partager apparaissent ici.</p></section>` : ''}
${T === 'documents' ? h`<section class="cl-step"><h2>Documents</h2>
${[...quotes].reverse().map((x) => h`<a class="docrow" href="${vUrl(x)}" target="_blank">Devis n° ${x.number} · version ${x.version} (${x.status === 'accepted' ? 'accepté' : x.status === 'sent' ? 'en attente' : x.status === 'modif' ? 'modification demandée' : x.status === 'refused' ? 'décliné' : 'remplacé'})</a>`)}
${(accepted || latest)?.cgv ? h`<a class="docrow" href="${mode === 'apercu' ? `/fichiers/${(accepted || latest).cgv}` : `${baseUrl}/cgv-doc`}" target="_blank">Conditions générales de vente (PDF)</a>` : ''}
${pvs.map((tr) => h`<a class="docrow" href="${mode === 'apercu' ? `/poses/${tr.id}/pv` : `${baseUrl}/pv/${tr.id}`}">Procès-verbal de réception du ${ddmm(tr.pv_signed_at)}</a>`)}
${p?.deposit_invoice_url ? h`<a class="docrow" href="${p.deposit_invoice_url}" target="_blank" rel="noopener">Facture d’acompte ${p.deposit_invoice_number || ''}${p.deposit_at ? ' (réglée)' : ''}</a>` : ''}
${docs.map((d) => h`<a class="docrow" href="${f(d.file)}" target="_blank">${d.title}</a>`)}
${quotes.length || pvs.length || docs.length ? '' : h`<p class="mut">Bientôt ici : votre devis, les conditions de vente, le procès-verbal et la facture.</p>`}</section>` : ''}
</main>`;
  return shell(p ? p.name : `Devis ${viaQuote.number}`, inner, setting('portal_test_mode') === '1', p ? `Dossier ${p.ref}` : `Devis ${viaQuote.number}`);
}

r.get('/espace/:t', (req, res) => {
  const p = findSpace(req.params.t);
  if (!p) return res.status(404).send(shell('Espace fermé', h`<main class="cl"><h1>Cet espace n’est pas accessible</h1><p class="mut">Le lien a peut-être été renouvelé. Demandez un nouveau lien à l’atelier.</p></main>`));
  q.run("UPDATE projects SET portal_opened_at = COALESCE(portal_opened_at, datetime('now')), portal_seen_at = datetime('now'), portal_views = portal_views + 1 WHERE id = ?", p.id);
  res.send(renderSpace(p, { token: req.params.t, tab: req.query.tab, flash: req.flash ? h`<div class="flash ${req.flash.kind}">${req.flash.text}</div>` : '' }));
});
// Fichiers du portail, par le lien de l'espace ou par le lien du devis (une fois répondu).
function portalCtx(kind, t) {
  if (kind === 'espace') { const p = findSpace(t); return p ? { p, numbers: q.all('SELECT DISTINCT number FROM quotes WHERE project_id = ?', p.id).map((x) => x.number) } : null; }
  const x = q.get('SELECT * FROM quotes WHERE token_hash = ?', sha256(String(t || '')));
  if (!x) return null;
  return { p: x.project_id ? q.get('SELECT * FROM projects WHERE id = ?', x.project_id) : null, numbers: [x.number], quote: x };
}
for (const kind of ['espace', 'devis']) {
  r.get(`/${kind}/:t/f/:name`, (req, res) => {
    const c = portalCtx(kind, req.params.t);
    const n = req.params.name;
    const ok = c?.p && (q.get('SELECT id FROM photos WHERE project_id = ? AND file = ? AND shared_client = 1', c.p.id, n) || q.get('SELECT id FROM documents WHERE project_id = ? AND file = ? AND visible_client = 1', c.p.id, n));
    if (!ok || !fs.existsSync(filePath(n))) return res.status(404).send('Introuvable');
    sendUpload(res, filePath(n));
  });
  // Une version du devis (même numéro que ceux du client).
  r.get(`/${kind}/:t/v/:id`, (req, res) => {
    const c = portalCtx(kind, req.params.t);
    const x = c && q.get('SELECT * FROM quotes WHERE id = ?', req.params.id);
    if (!x || !c.numbers.includes(x.number) || !fs.existsSync(filePath(x.pdf))) return res.status(404).send('Introuvable');
    res.type('application/pdf').sendFile(filePath(x.pdf));
  });
  r.get(`/${kind}/:t/cgv-doc`, (req, res) => {
    const c = portalCtx(kind, req.params.t);
    const x = c && c.numbers.length && q.get(`SELECT cgv FROM quotes WHERE number IN (${c.numbers.map(() => '?').join(',')}) AND cgv IS NOT NULL ORDER BY id DESC LIMIT 1`, ...c.numbers);
    if (!x?.cgv) return res.status(404).send('Introuvable');
    res.type('application/pdf').sendFile(filePath(x.cgv));
  });
  r.get(`/${kind}/:t/pv/:id`, (req, res) => {
    const c = portalCtx(kind, req.params.t);
    const tr = c?.p && q.get('SELECT * FROM trips WHERE id = ? AND project_id = ? AND pv_signed_at IS NOT NULL', req.params.id, c.p.id);
    if (!tr) return res.status(404).send('Introuvable');
    res.send(shell('Procès-verbal', h`<main class="cl"><h1>Procès-verbal de réception</h1><p>Ouvrage : <b>${c.p.name}</b></p>
<p>Réception prononcée le <b>${ddmmyyyy(tr.pv_signed_at)}</b> par <b>${tr.pv_name}</b>, ${tr.pv_reserves ? h`avec la réserve suivante : « ${tr.pv_reserves} »${tr.pv_reserves_lifted_at ? ` (levée le ${ddmmyyyy(tr.pv_reserves_lifted_at)})` : ''}` : 'sans réserve'}.</p>
${tr.pv_signature ? h`<img class="sig-img" src="/p/${kind}/${req.params.t}/sig/${tr.id}" alt="Signature">` : ''}
<p><a href="/p/${kind}/${req.params.t}?tab=documents">Revenir aux documents</a></p></main>`));
  });
  r.get(`/${kind}/:t/sig/:id`, (req, res) => {
    const c = portalCtx(kind, req.params.t);
    const tr = c?.p && q.get('SELECT pv_signature FROM trips WHERE id = ? AND project_id = ?', req.params.id, c.p.id);
    if (!tr?.pv_signature) return res.status(404).send('Introuvable');
    res.sendFile(filePath(tr.pv_signature));
  });
}
// Anciennes adresses (liens déjà envoyés).
r.get('/espace/:t/devis', (req, res) => {
  const p = findSpace(req.params.t);
  const x = p && q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
  if (!x) return res.status(404).send('Introuvable');
  res.type('application/pdf').sendFile(filePath(x.pdf));
});
r.get('/espace/:t/cgv', (req, res) => res.redirect(`/p/espace/${req.params.t}/cgv-doc`));

module.exports = r;
module.exports.renderSpace = renderSpace;
void isImage;
