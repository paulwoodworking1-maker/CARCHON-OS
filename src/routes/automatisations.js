'use strict';
// Pilotage › Automatisations : ce que le logiciel fait tout seul, et les interrupteurs.
const express = require('express');
const { q, setting, setSetting } = require('../db');
const { h, layout, pill, postBtn, hoursLabel, rel } = require('../html');
const auto = require('../automations');
const ai = require('../ai');
const mail = require('../mail');

const r = express.Router();
const toggle = (key, def, title, text) => h`<label class="it"><input type="checkbox" class="ckb" name="${key}" value="1" ${setting(key, def) === '1' ? 'checked' : ''}><div class="grow"><b>${title}</b><span class="mut">${text}</span></div></label>`;

r.get('/automatisations', (req, res) => {
  const avg = auto.averages();
  const nAuto = q.get('SELECT COUNT(*) n FROM bars WHERE auto = 1').n;
  const body = h`<div class="eb">Pilotage</div><h1>Automatisations</h1>
<p class="mut mt8 mw680">Ce que Carchon OS fait tout seul pour toi. Rien ne part chez un client sans que tu l'aies décidé ici.</p>
<div class="cols">
<div class="main-col">
<form method="post" action="/automatisations" class="card form">
<h2>Interrupteurs</h2>
${toggle('auto_plan', '1', 'Planning automatique', 'Les fiches envoyées à l’atelier se posent toutes seules dans le planning de chacun, jour après jour, d’après les heures prévues (ou la moyenne réelle du geste). Recalculé à chaque changement et chaque nuit. Tes barres posées à la main (rendez-vous, congé) sont respectées.')}
${toggle('digest_email', '1', 'Résumé du matin par e-mail', 'Chaque jour vers 7 h : ce qui est à décider, qui fait quoi, les problèmes signalés.')}
<label>Adresse e-mail du patron (résumé du matin et « mot de passe oublié ») <input type="email" name="patron_email" value="${setting('patron_email') || ''}" placeholder="toi@carchon.com"></label>
<h3 class="h3 mt20">Suivi client (e-mails automatiques)</h3>
<p class="mut t12">Seulement pour ce qui arrive après la mise en route : aucun envoi sur les anciens dossiers. Textes : <a href="/messages">Messages aux clients</a>.</p>
${toggle('auto_reminder_pose', '1', 'Rappel deux jours avant une livraison ou une pose', 'Adresse, accès dégagé, comment nous joindre.')}
${toggle('auto_relance_devis', '1', 'Relance des devis sans réponse', 'À J+7, puis une dernière fois à J+21, avec le même lien.')}
${toggle('auto_relance_facture', '1', 'Rappel des factures impayées', 'Acompte et solde : un rappel le lendemain de l’échéance, avec le lien de paiement.')}
${toggle('qonto_auto_balance', '1', 'Facture de solde à la signature du PV (Qonto)', 'Montant du devis moins l’acompte, envoyée par Qonto ; payée, l’étape Règlement se coche toute seule.')}
${toggle('auto_avis', '1', 'Merci et demande d’avis, trois jours après la pose', 'Seulement si le PV est sans réserve.')}
<label>Lien de ta fiche Google pour les avis <input name="google_review_url" type="url" value="${setting('google_review_url', 'https://g.page/r/CRg9zwIzI__7EBM/review')}" placeholder="https://g.page/r/…/review"></label>
${toggle('auto_anniversaire', '1', 'Message « un an déjà » après la pose', 'Conseil d’entretien et porte ouverte pour un nouveau projet.')}
<button class="btn">Enregistrer</button></form>

<section class="card"><h2>Alertes ajoutées à « À décider »</h2>
<ul class="mut checklist">
<li><b>Retard prévu</b> : la fabrication estimée finit après la date de livraison promise.</li>
<li><b>Devis sans réponse</b> qui expire dans 3 jours, avec une relance déjà rédigée.</li>
<li><b>Acompte</b> attendu depuis plus d’une semaine, avec une relance déjà rédigée.</li>
<li><b>Commande fournisseur en retard</b>, avec un e-mail de relance ou le numéro à appeler.</li>
<li><b>Pose dans 3 jours</b> alors que la liste du camion n’est pas complète.</li>
</ul>
<p class="mut">Les relances s’ouvrent dans ta messagerie : tu relis, tu envoies.</p></section>

<section class="card"><h2>Ce que l’atelier met vraiment</h2><p class="mut">Appris des « Ça t’a pris combien ? ». Sert de durée par défaut aux nouvelles fiches et au planning automatique.</p>
${Object.keys(avg).length ? Object.entries(avg).map(([g, hr], i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${g}</span><b>${hoursLabel(Math.round(hr * 2) / 2)}</b></div>`) : h`<p class="mut">Pas encore de fiche terminée avec un geste.</p>`}</section>
</div>

<aside class="side-col">
<section class="card"><div class="line"><h2>Assistant IA</h2>${pill(ai.enabled() ? 'ok' : 'no', ai.enabled() ? 'Activé' : 'Pas activé')}</div>
<ul class="mut checklist mt8"><li><a href="/assistant">Répond à tes questions sur l’atelier</a> et note un achat, une fiche ou une absence quand tu le demandes.</li><li>Écrit un carnet de fabrication à partir de ce que tu racontes.</li><li>Lit le PDF d’un devis et remplit le formulaire d’envoi.</li><li>Rédige un message d’avancement pour le client.</li></ul>
${ai.enabled() ? '' : h`<p class="mut mt8">Pour l’activer : crée une clé sur console.anthropic.com, puis ajoute-la à l’hébergeur sous le nom <b>ANTHROPIC_API_KEY</b> (Render › Environment). Coût à l’usage, quelques centimes par demande.</p>`}</section>
<section class="card"><div class="line"><h2>E-mails</h2>${pill(mail.configured() ? 'ok' : 'no', mail.configured() ? 'Configurés' : 'Pas configurés')}</div>
${mail.configured() ? '' : h`<p class="mut mt8">Résumé du matin, rappels J-2 et codes clients ont besoin de l’envoi d’e-mails (variables SMTP chez l’hébergeur).</p>`}</section>
<section class="card"><h2>Maintenant</h2>
<p class="mut">${nAuto} barre${nAuto > 1 ? 's' : ''} posée${nAuto > 1 ? 's' : ''} automatiquement${setting('last_plan') ? ` · calculé ${rel(setting('last_plan').replace('T', ' ').slice(0, 19))}` : ''}.</p>
<div class="line mt8">${postBtn('/automatisations/planifier', 'Replanifier', 'btn alt sm')}${postBtn('/automatisations/resume', 'M’envoyer le résumé', 'btn alt sm')}<a class="btn alt sm" href="/automatisations/resume">Voir le résumé</a></div></section>
</aside></div>`;
  res.send(layout({ title: 'Automatisations', tab: 'pilotage', sub: '/automatisations', body, flash: req.flash }));
});

r.post('/automatisations', (req, res) => {
  for (const k of ['auto_plan', 'digest_email', 'auto_reminder_pose', 'auto_relance_devis', 'auto_relance_facture', 'qonto_auto_balance', 'auto_avis', 'auto_anniversaire']) setSetting(k, req.body[k] ? '1' : '0');
  const gr = String(req.body.google_review_url || '').trim(); setSetting('google_review_url', /^https:\/\//.test(gr) ? gr : '');
  setSetting('patron_email', String(req.body.patron_email || '').trim());
  if (req.body.auto_plan) auto.autoPlan(); else q.run('DELETE FROM bars WHERE auto = 1');
  res.flashTo('/automatisations', 'Enregistré.');
});
r.post('/automatisations/planifier', (req, res) => { const x = auto.autoPlan(); res.flashTo('/automatisations', x.skipped ? 'Le planning automatique est désactivé.' : `Planning recalculé : ${x.bars} barre(s).`); });
r.get('/automatisations/resume', (req, res) => {
  res.send(layout({ title: 'Résumé du matin', tab: 'pilotage', sub: '/automatisations', body: h`<div class="eb"><a href="/automatisations">Automatisations</a></div><h1>Résumé du matin</h1><pre class="card mt20 pre">${auto.digestText()}</pre>` }));
});
r.post('/automatisations/resume', async (req, res, next) => {
  try {
    if (!setting('patron_email')) return res.flashTo('/automatisations', 'Indique d’abord ton adresse e-mail.', 'ko');
    const x = await auto.sendDigest();
    res.flashTo('/automatisations', x.logged ? 'SMTP absent : le résumé a seulement été écrit dans le journal du serveur.' : 'Résumé envoyé.');
  } catch (e) { next(e); }
});

module.exports = r;
