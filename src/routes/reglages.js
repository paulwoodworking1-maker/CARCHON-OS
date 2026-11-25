'use strict';
// Pilotage (heures réelles vs chiffrées, par geste) et réglages de l'équipe.
const express = require('express');
const { q, setting, setSetting, COMPANY_FIELDS } = require('../db');
const { h, layout, pill, avatar, options, hoursLabel } = require('../html');
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
<label>Code iPad (4 chiffres)${p.pin_hash ? ' · laisse vide pour garder l’actuel' : ''} <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" ${p.id ? '' : 'required'}></label>`;
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
  q.run("INSERT INTO people (name, ini, sub, color, role, pin_hash) VALUES (?, ?, ?, ?, 'ouvrier', ?)", str(b.name), str(b.ini).toUpperCase(), str(b.sub), str(b.color) || '#4A443E', hash(b.pin));
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
  q.run('UPDATE people SET name = ?, ini = ?, sub = ?, color = ?, pin_hash = COALESCE(?, pin_hash) WHERE id = ?', str(b.name), str(b.ini).toUpperCase(), str(b.sub), str(b.color), b.pin ? hash(b.pin) : null, p.id);
  res.flashTo('/equipe', 'Enregistré.');
});

// ---------- Entreprise ----------
r.get('/entreprise', (req, res) => {
  const body = h`<div class="eb">Réglages</div><h1>Entreprise</h1>
<p class="mut mt8 mw680">Tes coordonnées, reprises sur les documents imprimés (carnet, bon de commande, PV) et en bas du portail client.</p>
<form method="post" action="/entreprise" class="card form mt20 mw680">
${COMPANY_FIELDS.map(([k, label, def]) => h`<label>${label} <input name="${k}" value="${setting(k, def) || ''}"${k === 'company_name' ? ' required' : ''}></label>`)}
<button class="btn">Enregistrer</button></form>`;
  res.send(layout({ title: 'Entreprise', tab: 'pilotage', sub: '/entreprise', body, flash: req.flash }));
});
r.post('/entreprise', (req, res) => {
  for (const [k] of COMPANY_FIELDS) setSetting(k, str(req.body[k]).slice(0, 200));
  res.flashTo('/entreprise', 'Coordonnées enregistrées.');
});

module.exports = r;
void L;
