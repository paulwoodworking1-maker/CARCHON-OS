'use strict';
// Pilotage (heures réelles vs chiffrées, par geste) et réglages de l'équipe.
const express = require('express');
const { q, setting, setSetting, COMPANY_FIELDS } = require('../db');
const { h, layout, pill, avatar, options, hoursLabel, today } = require('../html');
const B = require('../backup');
const { hash, verify } = require('../auth');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();

function gestureStats() {
  // 12 derniers projets livrés (ou tous les projets si aucun n'est terminé).
  let ids = q.all("SELECT id FROM projects WHERE status = 'termine' ORDER BY finished_at DESC LIMIT 12").map((p) => p.id);
  const scope = ids.length ? `${ids.length} dernier${ids.length > 1 ? 's' : ''} projet${ids.length > 1 ? 's' : ''} livré${ids.length > 1 ? 's' : ''}` : 'tous les projets en cours';
  if (!ids.length) ids = q.all('SELECT id FROM projects').map((p) => p.id);
  if (!ids.length) return { scope, rows: [] };
  const rows = q.all(`SELECT COALESCE(NULLIF(geste, ''), 'Autre') g, COUNT(*) n, SUM(est_hours) est, SUM(declared_hours) real FROM steps
    WHERE status = 'done' AND declared_hours IS NOT NULL AND project_id IN (${ids.map(() => '?').join(',')}) GROUP BY g ORDER BY n DESC`, ...ids);
  return { scope, rows: rows.map((x) => ({ ...x, avgEst: x.est / x.n, avgReal: x.real / x.n, diff: (x.real - x.est) / x.n })) };
}

r.get('/pilotage', (req, res) => {
  const { scope, rows } = gestureStats();
  const max = Math.max(8, ...rows.map((x) => Math.max(x.avgEst, x.avgReal)));
  const note = (x) => {
    if (!x.est) return 'Pas chiffré au devis';
    const pct = x.diff / (x.avgEst || 1);
    if (Math.abs(pct) < 0.15) return 'Bien chiffré';
    return pct > 0 ? `+${hoursLabel(x.diff)} par fois` : `${hoursLabel(-x.diff)} de moins par fois`;
  };
  const body = h`<div class="head"><div><div class="eb">Pilotage</div><h1>Heures et chiffrage</h1></div><a class="btn alt push" href="/pilotage/export.csv">Exporter pour le logiciel commercial</a></div>
<p class="mut mt8 mw680">Ce que chaque geste te coûte vraiment en temps : quand une fiche est finie, l'iPad demande « Ça t'a pris combien ? ». C'est la base pour chiffrer juste tes prochains devis. Le temps « chiffré » est celui que tu as mis sur la fiche.</p>
<section class="card mt20"><div class="h3">Par geste · ${scope}</div>
<div class="tablebox"><table class="tbl"><thead><tr><th>Geste</th><th>Fois</th><th>Chiffré (moy.)</th><th>Déclaré (moy.)</th><th class="wbar">Écart</th><th>À retenir</th></tr></thead>
<tbody>${rows.map((x) => h`<tr><td class="b">${x.g}</td><td>${x.n}</td><td>${hoursLabel(x.avgEst)}</td><td>${hoursLabel(x.avgReal)}</td>
<td><div class="gbar"><span class="e" style="width:${(x.avgEst / max) * 100}%"></span><span class="${x.diff > 0.15 * (x.avgEst || 1) ? 'r' : 'g'}" style="width:${(x.avgReal / max) * 100}%"></span></div></td><td>${note(x)}</td></tr>`)}
${rows.length ? '' : h`<tr><td colspan="6" class="mut">Rien encore : les chiffres se remplissent dès que l'atelier termine des fiches avec un geste choisi.</td></tr>`}</tbody></table></div>
<p class="mut t12 mt8">Barre grise : chiffré · rouge : plus long que chiffré · verte : plus court ou égal.</p></section>`;
  res.send(layout({ title: 'Pilotage', tab: 'pilotage', sub: '/pilotage', body }));
});

r.get('/pilotage/export.csv', (req, res) => {
  const rows = q.all(`SELECT projects.name p, steps.title t, steps.geste g, steps.est_hours e, steps.declared_hours d, people.name w, steps.done_at f
    FROM steps JOIN projects ON projects.id = steps.project_id LEFT JOIN people ON people.id = steps.who_id WHERE steps.status = 'done' ORDER BY steps.done_at`);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Projet;Fiche;Geste;Heures prévues;Heures déclarées;Qui;Terminé le', ...rows.map((x) => [x.p, x.t, x.g, x.e, x.d, x.w, x.f].map(cell).join(';'))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="carchon-heures.csv"').send('﻿' + csv);
});

// ---------- Équipe ----------
r.get('/equipe', (req, res) => {
  const people = q.all('SELECT * FROM people ORDER BY active DESC, role = \'patron\' DESC, id');
  const COLORS = [['#1A1714', 'Noir'], ['#4A443E', 'Brun foncé'], ['#6B635A', 'Pierre'], ['#2E2925', 'Charbon'], ['#5A534B', 'Taupe'], ['#3E3832', 'Bois sombre']];
  const form = (p = {}) => h`<div class="grid2"><label>Prénom <input name="name" value="${p.name || ''}" required></label><label>Initiales <input name="ini" value="${p.ini || ''}" maxlength="3" required></label></div>
<div class="grid2"><label>Métier <input name="sub" value="${p.sub || ''}" placeholder="ex. ébéniste"></label><label>Couleur <select name="color">${options(COLORS, p.color)}</select></label></div>
<div class="grid2"><label>Code iPad (4 chiffres)${p.pin_hash ? ' · vide = inchangé' : ''} <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" ${p.id ? '' : 'required'}></label>
<label>Heures à l'atelier par semaine <input name="hours_week" inputmode="decimal" value="${p.hours_week ?? 35}"></label></div>`;
  const body = h`<div class="head"><div><div class="eb">Réglages</div><h1>Équipe</h1><p class="mut mt8">Un prénom et un code à 4 chiffres pour ouvrir son carnet sur l'iPad. Pas de compte, pas de mot de passe.</p></div>
<details class="menu push"><summary class="btn">+ Ajouter quelqu'un</summary><form method="post" action="/equipe" class="menu-list right-al form pad wide">${form()}<button class="btn sm">Ajouter</button></form></details></div>
<section class="card mt20">${people.map((p, i) => h`<div class="it${i ? '' : ' f'}${p.active ? '' : ' off'}">${avatar(p, 44)}<div class="grow"><b class="t16">${p.role === 'patron' ? `${p.name} (toi)` : p.name}</b><div class="mut">${p.sub}</div></div>
<span class="mut">${p.role === 'patron' ? 'Ordinateur et iPad' : p.pin_hash ? 'Code iPad ••••' : 'Pas de code'}</span>${pill('no', p.role === 'patron' ? 'Voit tout' : 'Ne voit pas les prix')}${p.active ? '' : pill('ko', 'Désactivé')}
<details class="menu"><summary class="btn alt sm">Modifier</summary><form method="post" action="/equipe/${p.id}" class="menu-list right-al form pad wide">${form(p)}<div class="line"><button class="btn sm">Enregistrer</button>${p.role === 'patron' ? '' : h`<button class="btn alt sm" name="toggle" value="1">${p.active ? 'Désactiver' : 'Réactiver'}</button>`}</div></form></details></div>`)}</section>
<section class="card mt20 mw680"><h2>Mot de passe du patron</h2>
<form method="post" action="/equipe/mot-de-passe" class="form mt12"><label>Mot de passe actuel <input type="password" name="old" required autocomplete="current-password"></label><label>Nouveau (8 caractères minimum) <input type="password" name="pw" minlength="8" required autocomplete="new-password"></label><button class="btn sm">Changer</button></form></section>`;
  res.send(layout({ title: 'Équipe', tab: 'pilotage', sub: '/equipe', body, flash: req.flash }));
});
r.post('/equipe', (req, res) => {
  const b = req.body;
  if (!/^\d{4}$/.test(b.pin || '')) return res.flashTo('/equipe', 'Le code iPad doit faire 4 chiffres.', 'ko');
  q.run("INSERT INTO people (name, ini, sub, color, role, pin_hash, hours_week) VALUES (?, ?, ?, ?, 'ouvrier', ?, ?)", str(b.name), str(b.ini).toUpperCase(), str(b.sub), str(b.color) || '#4A443E', hash(b.pin), Number(String(b.hours_week || 35).replace(',', '.')) || 35);
  res.flashTo('/equipe', `${str(b.name)} est ajouté(e). Son code ouvre « Mon carnet » sur l’iPad.`);
});
r.post('/equipe/mot-de-passe', (req, res) => {
  if (!verify(req.body.old || '', setting('patron_password'))) return res.flashTo('/equipe', 'Mot de passe actuel incorrect.', 'ko');
  if (String(req.body.pw || '').length < 8) return res.flashTo('/equipe', 'Le nouveau mot de passe doit faire 8 caractères minimum.', 'ko');
  setSetting('patron_password', hash(req.body.pw));
  res.flashTo('/equipe', 'Mot de passe changé.');
});
r.post('/equipe/:id', (req, res) => {
  const b = req.body;
  const p = q.get('SELECT * FROM people WHERE id = ?', req.params.id);
  if (!p) return res.redirect('/equipe');
  if (b.toggle && p.role !== 'patron') { q.run('UPDATE people SET active = 1 - active WHERE id = ?', p.id); return res.redirect('/equipe'); }
  if (b.pin && !/^\d{4}$/.test(b.pin)) return res.flashTo('/equipe', 'Le code iPad doit faire 4 chiffres.', 'ko');
  q.run('UPDATE people SET name = ?, ini = ?, sub = ?, color = ?, pin_hash = COALESCE(?, pin_hash), hours_week = ? WHERE id = ?', str(b.name), str(b.ini).toUpperCase(), str(b.sub), str(b.color), b.pin ? hash(b.pin) : null, Number(String(b.hours_week || 35).replace(',', '.')) || 35, p.id);
  res.flashTo('/equipe', 'Enregistré.');
});

// ---------- Entreprise ----------
r.get('/entreprise', (req, res) => {
  const body = h`<div class="eb">Réglages</div><h1>Entreprise</h1>
<p class="mut mt8 mw680">Tes coordonnées, reprises sur les documents imprimés (carnet, bon de commande, PV) et en bas du portail client.</p>
<form method="post" action="/entreprise" class="card form mt20 mw680">
${COMPANY_FIELDS.map(([k, label, def]) => h`<label>${label} <input name="${k}" value="${setting(k, def) || ''}"${k === 'company_name' ? ' required' : ''}></label>`)}
<div class="grid2"><label>Taux horaire de l'atelier (€ / h, pour le coût réel) <input name="hourly_rate" inputmode="decimal" value="${setting('hourly_rate', '')}"></label>
<label>Garantie des pièces (mois) <input name="warranty_months" inputmode="numeric" value="${setting('warranty_months', '24')}"></label></div>
<button class="btn">Enregistrer</button></form>
<section class="card mt20 mw680" id="cockpit"><h2>Liaison avec Cockpit</h2>
<form method="post" action="/entreprise/cockpit-adresse" class="form mt12"><label>Adresse de Cockpit (pour le bouton « Passer sur Cockpit » en bas de la colonne) <input type="url" name="cockpit_url" placeholder="https://…" value="${setting('cockpit_url') || process.env.COCKPIT_URL || ''}"></label><button class="btn alt sm">Enregistrer l’adresse</button></form>
<p class="mut mt12">Cockpit envoie les affaires signées et les acomptes à Carchon OS, et lit l'avancement, les dates et le coût réel des OF. Adresse : <b>${process.env.PUBLIC_URL || ''}/api/v1</b> · clé : ${setting('api_token') ? 'créée (masquée)' : 'pas encore créée'}.</p>
<form method="post" action="/entreprise/cle" data-confirm="Créer une nouvelle clé ? L’ancienne ne marchera plus."><button class="btn alt sm">${setting('api_token') ? 'Créer une nouvelle clé' : 'Créer la clé'}</button></form>
<form method="post" action="/entreprise/cockpit" class="form mt12"><label>Adresse de Cockpit à prévenir quand un devis est signé (webhook) <input name="url" type="url" value="${setting('cockpit_webhook_url') || ''}" placeholder="https://cockpit…/webhooks/carchon"></label><button class="btn alt sm">Enregistrer</button></form>
${(() => { try { const l = JSON.parse(setting('cockpit_last') || 'null'); return l ? h`<p class="mut t12 mt8">Dernier envoi : ${l.event} · ${l.error ? `échec (${l.error})` : `réponse ${l.status}`} · ${l.at.slice(0, 16).replace('T', ' ')}</p>` : ''; } catch { return ''; } })()}
<details class="mt12"><summary class="mut t13" style="cursor:pointer">Détail technique pour Cockpit</summary><div class="mut t12 mt8" style="line-height:1.7">
Entrées (en-tête « Authorization: Bearer &lt;clé&gt; ») : POST /api/v1/affaires · POST /api/v1/affaires/{réf}/acompte · <b>POST /api/v1/affaires/{réf ou n° de devis}/factures</b> (multipart : pdf, type = acompte | solde | autre, numero, montant_ttc, echeance ; ou JSON avec pdf_base64) · GET /api/v1/ofs.<br>
Sortie : à chaque devis signé, POST JSON vers l’adresse ci-dessus, évènement « devis.accepte » (OF, devis, client, lignes, adresse de retour de la facture). Signature : en-tête « X-Carchon-Signature: sha256=… », HMAC SHA-256 du corps avec la clé de liaison.</div></details></section>
<section class="card mt20 mw680" id="sauvegardes"><h2>Sauvegardes</h2>
<p class="mut mt8">Chaque nuit, une copie complète de la base est faite sur le disque du serveur ; les ${B.KEEP} dernières sont gardées. Télécharge-en une de temps en temps (par exemple chaque lundi) et range-la sur ton ordinateur ou ton cloud : c'est ta garantie si l'hébergeur a un souci.</p>
<div class="line mt12"><a class="btn" href="/sauvegarde/maintenant">Télécharger une sauvegarde maintenant</a></div>
${B.list().length ? h`<div class="mt12">${B.list().map((f) => h`<div class="who"><span class="grow">${f.name.replace('carchon-', 'Copie du ').replace('.db', '')}</span><span class="mut t12">${Math.max(1, Math.round(f.size / 1024))} Ko</span><a class="btn alt sm" href="/sauvegarde/${f.name}">Télécharger</a></div>`)}</div>` : h`<p class="mut mt8">Première copie automatique cette nuit.</p>`}
<p class="mut t12 mt8">Les photos et plans joints restent dans le dossier des fichiers du serveur ; la base contient tout le reste (OF, carnets, heures, stock, clients, réglages).</p></section>`;
  res.send(layout({ title: 'Entreprise', tab: 'pilotage', sub: '/entreprise', body, flash: req.flash }));
});
// Sauvegardes : copie fraîche ou copie de nuit.
r.get('/sauvegarde/maintenant', (req, res) => {
  const file = B.make(require('node:path').join(B.DIR, 'tmp', `carchon-${today()}-${Date.now()}.db`));
  res.download(file, `carchon-os-${today()}.db`, () => { try { require('node:fs').unlinkSync(file); } catch {} });
});
r.get('/sauvegarde/:name', (req, res) => {
  const f = B.fileOf(req.params.name);
  if (!f || !require('node:fs').existsSync(f)) return res.status(404).send('Introuvable');
  res.download(f, req.params.name.replace('carchon-', 'carchon-os-'));
});

r.post('/entreprise/cockpit-adresse', (req, res) => {
  const url = String(req.body.cockpit_url || '').trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return res.flashTo('/entreprise#cockpit', 'L’adresse de Cockpit doit commencer par https://', 'ko');
  setSetting('cockpit_url', url);
  res.flashTo('/entreprise#cockpit', url ? 'Adresse de Cockpit enregistrée : le bouton « Passer sur Cockpit » l’ouvre.' : 'Adresse de Cockpit retirée.');
});

r.post('/entreprise/cockpit', (req, res) => {
  const u = String(req.body.url || '').trim();
  if (u && !/^https:\/\//.test(u)) return res.flashTo('/entreprise#cockpit', 'L’adresse doit commencer par https://', 'ko');
  setSetting('cockpit_webhook_url', u);
  res.flashTo('/entreprise#cockpit', u ? 'Cockpit sera prévenu à chaque devis signé.' : 'Adresse retirée.');
});

// Clé de la liaison avec Cockpit (montrée une fois à la création).
r.post('/entreprise/cle', (req, res) => {
  const key = require('node:crypto').randomBytes(24).toString('base64url');
  setSetting('api_token', key);
  res.flashTo('/entreprise', '', 'ok', { html: `Nouvelle clé de liaison : <code style="user-select:all">${key}</code> · copie-la dans Cockpit, l’ancienne ne marche plus.` });
});

// Coût réel par OF : heures déclarées × taux horaire.
r.get('/pilotage/couts', (req, res) => {
  const rate = Number(String(setting('hourly_rate', '0')).replace(',', '.')) || 0;
  const rows = q.all(`SELECT projects.id, projects.ref, projects.name, projects.canal, projects.status, projects.qty, COALESCE(SUM(steps.est_hours), 0) e, COALESCE(SUM(steps.declared_hours), 0) d
    FROM projects LEFT JOIN steps ON steps.project_id = projects.id GROUP BY projects.id HAVING e > 0 OR d > 0 ORDER BY projects.status = 'en_cours' DESC, projects.id DESC LIMIT 60`);
  const eur = (x) => `${Math.round(x).toLocaleString('fr-FR')} €`;
  const body = h`<section class="card" style="border-top:0;padding-top:0">
${rate ? h`<p class="mut">Coût de main-d'œuvre = heures déclarées × ${String(rate).replace('.', ',')} € / h. Il est aussi envoyé à Cockpit pour calculer la marge de chaque affaire.</p>` : h`<p class="flash ko">Indique le taux horaire de l'atelier dans <a href="/entreprise">Entreprise</a> pour voir les coûts.</p>`}
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>OF</th><th>Pièce</th><th>Canal</th><th class="num">Prévu</th><th class="num">Réel</th><th class="num">Écart</th><th class="num">Coût réel</th><th class="num">Par pièce</th></tr></thead><tbody>
${rows.map((x) => h`<tr><td class="ref">${x.ref}</td><td><a href="/projets/${x.id}">${x.name}</a>${x.status === 'termine' ? h` <span class="mut t12">· terminé</span>` : ''}</td><td>${pill('no', x.canal)}</td><td class="num">${hoursLabel(x.e)}</td><td class="num b">${hoursLabel(x.d)}</td>
<td class="num" style="color:${x.e && x.d > x.e * 1.1 ? 'var(--red)' : 'var(--ink)'}">${x.e ? `${x.d >= x.e ? '+' : '−'}${Math.abs(Math.round((x.d - x.e) / x.e * 100))} %` : '—'}</td><td class="num b">${rate ? eur(x.d * rate) : '—'}</td><td class="num">${rate && x.qty > 1 ? eur(x.d * rate / x.qty) : ''}</td></tr>`)}
${rows.length ? '' : h`<tr><td colspan="8" class="mut">Aucune heure encore.</td></tr>`}</tbody></table></div></section>`;
  res.send(layout({ title: 'Coût par OF', heading: 'Heures et coûts', tab: 'pilotage', sub: '/pilotage/couts', body }));
});

r.post('/entreprise', (req, res) => {
  for (const [k] of COMPANY_FIELDS) setSetting(k, str(req.body[k]).slice(0, 200));
  setSetting('hourly_rate', str(req.body.hourly_rate).replace(',', '.'));
  setSetting('warranty_months', String(Math.max(0, Number(req.body.warranty_months) || 24)));
  res.flashTo('/entreprise', 'Coordonnées enregistrées.');
});

module.exports = r;
void L;
