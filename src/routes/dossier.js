'use strict';
// Dossier de production d'un projet : carnet généré depuis les plans + la dictée du patron,
// liste de débit, et commandes aux sous-traitants (laquage, verre, découpe numérique…).
const fs = require('node:fs');
const express = require('express');
const { q, tx, PHASES, GESTES, logActivity, company } = require('../db');
const { h, pill, postBtn, options, ddmm, ddmmyyyy, today, hoursLabel, printPage } = require('../html');
const L = require('../logic');
const { upload, fileUrl, filePath } = require('../uploads');
const { loadProject } = require('./patron');
const ai = require('../ai');
const auto = require('../automations');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : null; };
const parse = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };

// --- Sous-traitance : statuts et libellés ---
const SST = [
  ['a_commander', 'À commander', 'no'],
  ['commande', 'Commandé', 'wa'],
  ['envoye', 'Chez le sous-traitant', 'wa'],
  ['recu', 'Revenu à l’atelier', 'ok'],
  ['controle', 'Contrôlé', 'ok'],
];
const SST_LABEL = Object.fromEntries(SST.map(([k, l]) => [k, l]));
const SST_PILL = Object.fromEntries(SST.map(([k, , c]) => [k, c]));
// Ce que fait le bouton principal à chaque statut.
const NEXT = {
  a_commander: ['commande', 'Marquer commandé'],
  commande: ['envoye', 'Pièces parties chez lui'],
  envoye: ['recu', 'Revenu à l’atelier'],
  recu: ['controle', 'Contrôlé, conforme'],
};
const DATE_COL = { commande: 'ordered_at', envoye: 'sent_at', recu: 'back_at', controle: 'controlled_at' };

function subcontracts(projectId) {
  return q.all(`SELECT subcontracts.*, suppliers.name sname, suppliers.email semail, suppliers.phone sphone, suppliers.contact scontact
    FROM subcontracts LEFT JOIN suppliers ON suppliers.id = subcontracts.supplier_id WHERE project_id = ?
    ORDER BY CASE status WHEN 'controle' THEN 2 WHEN 'recu' THEN 1 ELSE 0 END, COALESCE(due_at, '9999'), id`, projectId);
}
const isLate = (s) => s.due_at && !s.back_at && s.status !== 'a_commander' && s.due_at < today();

// Résumé pour la fiche projet et « À décider ».
function sstSummary(projectId) {
  const list = subcontracts(projectId);
  const open = list.filter((s) => s.status !== 'controle');
  const late = open.filter(isLate);
  const nextBack = open.filter((s) => s.due_at && !s.back_at).map((s) => s.due_at).sort()[0] || null;
  return { list, open, late, nextBack, toOrder: list.filter((s) => s.status === 'a_commander').length };
}

// Bloc HTML « Sous-traitance » (fiche projet, onglet Achats et sous-traitance).
function sstSection(p) {
  const list = subcontracts(p.id);
  const sups = q.all('SELECT id, name, subcontractor FROM suppliers ORDER BY subcontractor DESC, name');
  const supOpts = sups.map((s) => [s.id, `${s.name}${s.subcontractor ? '' : ' (fournisseur)'}`]);
  return h`<section class="card" id="sous-traitance"><div class="line"><h2>Sous-traitance</h2>${list.length ? h`<span class="mut t13">${list.filter((s) => s.status !== 'controle').length} en cours</span>` : ''}</div>
<p class="mut">Ce qu’un autre atelier fait pour ce projet : du devis au retour contrôlé. Le bon de commande part avec les plans du dossier.</p>
${list.map((s, i) => sstRow(p, s, i, supOpts))}
${list.length ? '' : h`<p class="mut mt8">Aucune prestation sous-traitée.</p>`}
<details class="mt12"${list.length ? '' : ' open'}><summary class="btn alt sm">+ Commande à un sous-traitant</summary>
<form method="post" action="/projets/${p.id}/sous-traitance" enctype="multipart/form-data" class="form mt12">
<div class="grid2"><label>Prestation <input name="what" required placeholder="ex. Laquage blanc mat des façades"></label>
<label>Sous-traitant <select name="supplier_id"><option value="">— nouveau ou plus tard —</option>${options(supOpts)}</select></label></div>
<div class="grid2"><label>Ou nouveau sous-traitant : nom <input name="new_name" placeholder="ex. Laquage Martin"></label><label>Son e-mail <input type="email" name="new_email"></label></div>
<div class="grid2"><label>Pièces concernées <input name="pieces" placeholder="ex. 6 façades, 2 joues"></label><label>Quantité <input name="qty" placeholder="ex. 8 pièces · 4,2 m²"></label></div>
<label>Cahier des charges <textarea name="spec" rows="2" placeholder="ex. RAL 9010 mat 10 %, 2 faces, chants compris. Ponçage grain 240 fait à l’atelier."></textarea></label>
<div class="grid2"><label>Retour souhaité le <input type="date" name="due_at"></label><label>Prix HT (€) <input name="price" inputmode="decimal"></label></div>
<div class="grid2"><label>Réf. de son devis <input name="quote_ref"></label><label>Son devis (PDF ou image) <input type="file" name="file" accept="application/pdf,image/*"></label></div>
<button class="btn sm">Ajouter</button></form></details>
</section>`;
}

function sstRow(p, s, i, supOpts) {
  const nx = NEXT[s.status];
  const steps = SST.map(([k, l]) => {
    const idx = SST.findIndex(([x]) => x === s.status), me = SST.findIndex(([x]) => x === k);
    const d = k === 'a_commander' ? s.created_at : s[DATE_COL[k]];
    return h`<li class="${me < idx ? 'd' : me === idx ? 'c' : ''}"><b>${l}</b><span>${me <= idx && d ? ddmm(d) : k === 'recu' && s.due_at ? `prévu ${ddmm(s.due_at)}` : ''}</span></li>`;
  });
  const mail = s.semail ? `mailto:${encodeURIComponent(s.semail)}?subject=${encodeURIComponent(`Commande ${p.ref} · ${s.what}`)}&body=${encodeURIComponent(mailBody(p, s))}` : '';
  return h`<details class="sst${i ? '' : ' f'}${isLate(s) ? ' late' : ''}" id="sst${s.id}"><summary>
<div class="grow"><b>${s.what}</b><span class="mut">${[s.sname || 'Sous-traitant à choisir', s.pieces, s.price ? `${String(s.price).replace('.', ',')} € HT` : ''].filter(Boolean).join(' · ')}</span></div>
${isLate(s) ? pill('ko', `Retour en retard · prévu ${ddmm(s.due_at)}`) : s.due_at && !s.back_at ? h`<span class="mut t13">retour ${ddmm(s.due_at)}</span>` : ''}${pill(SST_PILL[s.status], SST_LABEL[s.status])}${s.ai ? pill('no', 'Proposé par l’IA') : ''}</summary>
<ol class="sst-track">${steps}</ol>
<div class="line mt12">${nx ? postBtn(`/projets/${p.id}/sous-traitance/${s.id}/etape`, nx[1], 'btn sm', { to: nx[0] }) : ''}
<a class="btn alt sm" href="/projets/${p.id}/sous-traitance/${s.id}/bon">Bon de commande</a>
${mail ? h`<a class="btn alt sm" href="${mail}">Écrire au sous-traitant</a>` : ''}
${s.file ? h`<a class="btn alt sm" href="${fileUrl(s.file)}" target="_blank">Son devis</a>` : ''}
${s.status !== 'a_commander' ? postBtn(`/projets/${p.id}/sous-traitance/${s.id}/etape`, 'Revenir en arrière', 'linkbtn', { to: SST[Math.max(0, SST.findIndex(([x]) => x === s.status) - 1)][0] }) : ''}</div>
<form method="post" action="/projets/${p.id}/sous-traitance/${s.id}" enctype="multipart/form-data" class="form mt12">
<div class="grid2"><label>Prestation <input name="what" value="${s.what}" required></label><label>Sous-traitant <select name="supplier_id"><option value="">—</option>${options(supOpts, s.supplier_id)}</select></label></div>
<div class="grid2"><label>Pièces concernées <input name="pieces" value="${s.pieces}"></label><label>Quantité <input name="qty" value="${s.qty}"></label></div>
<label>Cahier des charges <textarea name="spec" rows="2">${s.spec}</textarea></label>
<div class="grid2"><label>Retour prévu le <input type="date" name="due_at" value="${s.due_at || ''}"></label><label>Prix HT (€) <input name="price" inputmode="decimal" value="${s.price ?? ''}"></label></div>
<div class="grid2"><label>Réf. de son devis <input name="quote_ref" value="${s.quote_ref}"></label><label>${s.file ? 'Remplacer son devis' : 'Son devis (PDF ou image)'} <input type="file" name="file" accept="application/pdf,image/*"></label></div>
<label>Note interne <input name="note" value="${s.note}" placeholder="ex. Livré par transporteur, prévoir palette"></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Supprimer cette commande de sous-traitance ?">Supprimer</button></div></form>
</details>`;
}

function mailBody(p, s) {
  const plan = q.get("SELECT version FROM plans WHERE project_id = ? AND status = 'validee' ORDER BY id DESC LIMIT 1", p.id);
  return `Bonjour${s.scontact ? ` ${s.scontact}` : ''},

Nous souhaitons vous confier la prestation suivante pour notre dossier ${p.ref} :
- ${s.what}${s.pieces ? `\n- Pièces : ${s.pieces}` : ''}${s.qty ? `\n- Quantité : ${s.qty}` : ''}${s.spec ? `\n- Cahier des charges : ${s.spec}` : ''}${s.due_at ? `\n- Retour souhaité le ${ddmmyyyy(s.due_at)}` : ''}${plan ? `\n- Plan de référence : ${plan.version} (joint)` : ''}${s.quote_ref ? `\n- Votre devis : ${s.quote_ref}` : ''}

Merci de nous confirmer la date de retour.

Bien cordialement,
${company().name}`;
}

r.post('/projets/:id/sous-traitance', loadProject, upload.single('file'), (req, res) => {
  const b = req.body, p = req.project;
  if (!str(b.what)) return res.flashTo(`/projets/${p.id}#sous-traitance`, 'Indique la prestation.', 'ko');
  const id = tx(() => {
    let sid = b.supplier_id ? Number(b.supplier_id) : null;
    if (!sid && str(b.new_name)) sid = q.run('INSERT INTO suppliers (name, email, subcontractor) VALUES (?, ?, 1)', str(b.new_name), str(b.new_email)).lastInsertRowid;
    else if (sid) q.run('UPDATE suppliers SET subcontractor = 1 WHERE id = ?', sid);
    const newId = q.run('INSERT INTO subcontracts (project_id, supplier_id, what, pieces, qty, spec, price, quote_ref, file, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, sid, str(b.what), str(b.pieces), str(b.qty), str(b.spec), num(b.price), str(b.quote_ref), req.file ? req.file.filename : null, str(b.due_at) || null).lastInsertRowid;
    logActivity(p.id, null, `Sous-traitance ajoutée : ${str(b.what)}`, 'Patron');
    return newId;
  });
  res.flashTo(`/projets/${p.id}#sst${id}`, 'Commande de sous-traitance ajoutée. Envoie le bon quand tout est prêt.');
});

r.post('/projets/:id/sous-traitance/:sid', loadProject, upload.single('file'), (req, res) => {
  const b = req.body, p = req.project;
  const s = q.get('SELECT * FROM subcontracts WHERE id = ? AND project_id = ?', req.params.sid, p.id);
  if (!s) return res.redirect(`/projets/${p.id}#sous-traitance`);
  if (b.del) {
    q.run('DELETE FROM subcontracts WHERE id = ?', s.id);
    logActivity(p.id, null, `Sous-traitance retirée : ${s.what}`, 'Patron');
    return res.flashTo(`/projets/${p.id}#sous-traitance`, 'Commande de sous-traitance supprimée.');
  }
  q.run('UPDATE subcontracts SET what = ?, supplier_id = ?, pieces = ?, qty = ?, spec = ?, due_at = ?, price = ?, quote_ref = ?, note = ?, file = COALESCE(?, file), ai = 0 WHERE id = ?',
    str(b.what) || s.what, b.supplier_id ? Number(b.supplier_id) : null, str(b.pieces), str(b.qty), str(b.spec), str(b.due_at) || null, num(b.price), str(b.quote_ref), str(b.note), req.file ? req.file.filename : null, s.id);
  if (b.supplier_id) q.run('UPDATE suppliers SET subcontractor = 1 WHERE id = ?', Number(b.supplier_id));
  if ((str(b.due_at) || null) !== s.due_at && str(b.due_at)) logActivity(p.id, null, `Sous-traitance « ${s.what} » : retour prévu le ${ddmm(str(b.due_at))}`, 'Patron');
  res.flashTo(`/projets/${p.id}#sst${s.id}`, 'Enregistré.');
});

r.post('/projets/:id/sous-traitance/:sid/etape', loadProject, (req, res) => {
  const p = req.project;
  const s = q.get('SELECT * FROM subcontracts WHERE id = ? AND project_id = ?', req.params.sid, p.id);
  const to = String(req.body.to || '');
  if (!s || !SST_LABEL[to]) return res.redirect(`/projets/${p.id}#sous-traitance`);
  const order = SST.map(([k]) => k);
  tx(() => {
    // En avançant, on date l'étape ; en reculant, on efface les dates des étapes annulées.
    const sets = order.slice(1).map((k) => {
      const col = DATE_COL[k];
      if (order.indexOf(k) > order.indexOf(to)) return `${col} = NULL`;
      if (k === to && !s[col]) return `${col} = date('now', 'localtime')`;
      return null;
    }).filter(Boolean);
    q.run(`UPDATE subcontracts SET status = ?${sets.length ? ', ' + sets.join(', ') : ''}, ai = 0 WHERE id = ?`, to, s.id);
    logActivity(p.id, null, `Sous-traitance « ${s.what} » : ${SST_LABEL[to].toLowerCase()}`, 'Patron');
  });
  res.flashTo(`/projets/${p.id}#sst${s.id}`, `${s.what} : ${SST_LABEL[to].toLowerCase()}.`);
});

// Bon de commande imprimable (PDF depuis le navigateur), avec la référence du plan validé.
r.get('/projets/:id/sous-traitance/:sid/bon', loadProject, (req, res) => {
  const p = req.project;
  const s = subcontracts(p.id).find((x) => String(x.id) === String(req.params.sid));
  if (!s) return res.redirect(`/projets/${p.id}#sous-traitance`);
  const plan = q.get("SELECT * FROM plans WHERE project_id = ? AND status = 'validee' ORDER BY id DESC LIMIT 1", p.id);
  res.send(printPage('Bon de commande · sous-traitance', h`
<table><tr><td><b>Sous-traitant</b><br>${s.sname || '—'}${s.scontact ? h`<br>${s.scontact}` : ''}${s.sphone ? h`<br>${s.sphone}` : ''}${s.semail ? h`<br>${s.semail}` : ''}</td>
<td><b>Notre dossier</b><br>${p.ref}<br>${p.name}</td><td><b>Retour souhaité</b><br>${s.due_at ? ddmmyyyy(s.due_at) : 'à convenir'}</td>
<td><b>Plan de référence</b><br>${plan ? `${plan.version}${plan.descr ? ` · ${plan.descr}` : ''}` : '—'}</td></tr></table>
<h2>Prestation</h2>
<table><thead><tr><th>Désignation</th><th>Pièces</th><th>Quantité</th><th class="nr">Prix HT</th></tr></thead>
<tbody><tr><td><b>${s.what}</b></td><td>${s.pieces || '—'}</td><td>${s.qty || '—'}</td><td class="nr">${s.price ? `${s.price.toFixed(2).replace('.', ',')} €` : 'selon devis'}</td></tr></tbody></table>
${s.spec ? h`<h2>Cahier des charges</h2><p>${s.spec}</p>` : ''}
${s.quote_ref ? h`<p><b>Votre devis :</b> ${s.quote_ref}</p>` : ''}
<h2>Réception</h2><p>Merci de confirmer la date de retour. Les pièces sont contrôlées à leur arrivée à l’atelier ; toute réserve est signalée sous 48 h.</p>
<table><tr><td style="height:70px"><b>Pour ${company().name}</b><br>Date et signature</td><td><b>Pour le sous-traitant</b><br>Bon pour accord</td></tr></table>`, { ref: `${p.ref}-ST${s.id}` }));
});

// --- Dossier de production : génération du carnet depuis les plans + la dictée ---
function dossierSection(p, { dictee = '' } = {}) {
  const plans = q.all('SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC', p.id);
  const steps = q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, id', p.id);
  const runs = q.all('SELECT * FROM carnet_runs WHERE project_id = ? ORDER BY id DESC LIMIT 8', p.id);
  const last = runs[0];
  const debit = last ? parse(last.debit) : [];
  const questions = last ? parse(last.questions) : [];
  const pm = L.peopleMap();
  const done = steps.filter((s) => s.status === 'done').length;
  const drafts = steps.filter((s) => !s.sent).length;
  const preset = dictee || '';
  const checked = (x) => x.status === 'validee' || (!plans.some((y) => y.status === 'validee') && x === plans[0]);
  return h`<section class="card" id="carnet"><div class="line"><h2>Carnet de fabrication</h2>
<span class="push line"><a class="btn alt sm" href="/carnets/${p.id}/imprimer">Imprimer</a><a class="btn sm" href="/carnets/${p.id}">Ouvrir le carnet</a></span></div>
<p class="mut">${steps.length ? `${steps.length} fiche${steps.length > 1 ? 's' : ''} · ${done} faite${done > 1 ? 's' : ''} · ${hoursLabel(steps.reduce((a, s) => a + (s.est_hours || 0), 0))} prévus${drafts ? ` · ${drafts} pas encore envoyée${drafts > 1 ? 's' : ''} à l’atelier` : ''}` : 'Carnet vide : génère-le depuis les plans et ta dictée, ou écris les fiches à la main.'}</p>
${steps.length ? h`<ol class="carnet-mini mt8">${steps.map((s) => h`<li class="${s.status}"><a href="/carnets/${p.id}?fiche=${s.id}"><b>${s.title}</b><span class="mut">${[s.piece, pm[s.who_id] ? (pm[s.who_id].role === 'patron' ? 'Toi' : pm[s.who_id].name) : 'À prendre', s.est_hours ? hoursLabel(s.est_hours) : ''].filter(Boolean).join(' · ')}</span></a>${s.status === 'done' ? pill('ok', 'Fait') : s.status === 'doing' ? pill('wa', 'En cours') : !s.sent ? pill('no', s.ai_generated ? 'Brouillon IA' : 'Pas envoyée') : ''}</li>`)}</ol>` : ''}
${drafts ? h`<div class="line mt12">${postBtn(`/carnets/${p.id}/envoyer`, `Envoyer à l’atelier · ${drafts} fiche${drafts > 1 ? 's' : ''}`, 'btn sm')}<span class="mut t12">Relis d’abord les fiches dans le carnet.</span></div>` : ''}
</section>

<section class="card" id="generer"><h2>Générer le carnet depuis les plans</h2>
${ai.enabled() ? h`<p class="mut">L’assistant (${ai.MODEL}) lit les plans cochés — cotes, assemblages, matières — et ce que tu dictes, puis propose les fiches, la liste de débit et les prestations à sous-traiter. Rien ne part à l’atelier avant ton envoi.</p>
<form method="post" action="/projets/${p.id}/dossier/generer" class="form mt12" data-busy="Lecture des plans en cours… (1 à 3 minutes)">
<fieldset class="plansel"><legend>Plans à lire</legend>${plans.length ? plans.map((x) => h`<label class="ck"><input type="checkbox" name="plan_ids" value="${x.id}" ${checked(x) ? 'checked' : ''} ${x.file ? '' : 'disabled'}> <b>${x.version}</b>${x.descr ? ` · ${x.descr}` : ''} <span class="mut t12">${x.status === 'validee' ? 'validée' : x.status === 'archivee' ? 'remplacée' : 'brouillon'}${x.file ? '' : ' · pas de fichier'}</span></label>`) : h`<p class="mut t12">Aucun plan dans le dossier : ajoute-le dans « Plans » ci-dessous, ou dicte seulement.</p>`}</fieldset>
<label for="dictee">Ce que tu dictes <span class="mut t12">(qui fait quoi, consignes, ce qui part en sous-traitance, finitions…)</span></label>
<div class="dictee"><textarea id="dictee" name="text" rows="6" placeholder="ex. Caissons en mélaminé blanc 19, chants ABS 1 mm. Plateau chêne massif 30 mm, c’est Nina qui le débite. Les façades partent au laquage chez Martin, blanc mat. Pose murale, prévoir tasseaux.">${preset}</textarea>
<button type="button" class="btn alt sm" data-dictee="#dictee" hidden>● Dicter</button></div>
<label class="ck"><input type="checkbox" name="replace" value="1" ${steps.some((s) => !s.sent && s.ai_generated) ? 'checked' : ''}> Remplacer les fiches proposées par l’IA pas encore envoyées</label>
<label class="ck"><input type="checkbox" name="pieces" value="1" checked> Remplir « Éléments du projet » et les sous-traitances proposées</label>
<button class="btn">Générer le carnet</button></form>`
  : h`<p class="mut">Avec l’assistant activé (clé ANTHROPIC_API_KEY chez l’hébergeur), il lit les plans du dossier et ta dictée, et prépare les fiches, la liste de débit et les sous-traitances. En attendant, écris les fiches dans le carnet.</p>`}
</section>

${last ? h`<section class="card" id="debit"><div class="line"><h2>Liste de débit</h2><span class="mut t13">lue le ${ddmm(last.created_at)}${last.plans ? ` sur ${last.plans}` : ''}</span><a class="btn alt sm push" href="/projets/${p.id}/dossier/imprimer">Imprimer le dossier</a></div>
${debit.length ? h`<div class="tablebox mt8"><table class="tbl"><thead><tr><th>Élément</th><th class="nr">Qté</th><th class="nr">L</th><th class="nr">l</th><th class="nr">Ép.</th><th>Matière</th><th>Remarque</th></tr></thead>
<tbody>${debit.map((d) => h`<tr><td><b>${d.piece}</b></td><td class="nr">${d.quantite}</td><td class="nr">${d.longueur || '?'}</td><td class="nr">${d.largeur || '?'}</td><td class="nr">${d.epaisseur || '?'}</td><td>${d.matiere}</td><td class="mut">${d.remarque}</td></tr>`)}</tbody></table></div>
<p class="mut t12 mt8">Cotes en mm telles que lues sur le plan. « ? » = illisible ou absente : à mesurer sur le plan avant de débiter.</p>` : h`<p class="mut">Pas de liste de débit lisible sur les plans fournis.</p>`}
${questions.length ? h`<div class="h3 mt20">À vérifier avant de lancer</div><ul class="qlist">${questions.map((x) => h`<li>${x}</li>`)}</ul>` : ''}
${last.remarks ? h`<p class="mut mt12"><b>Remarque de l’assistant :</b> ${last.remarks}</p>` : ''}
</section>` : ''}

${runs.length ? h`<section class="card" id="dictees"><h2>Dictées</h2><p class="mut">Chaque génération du carnet est gardée ici, avec ce que tu as dicté.</p>
${runs.map((x, i) => h`<details class="row${i ? '' : ' f'}"><summary class="line grow"><span class="grow"><b>${ddmm(x.created_at)}</b> <span class="mut">${x.n} fiche${x.n > 1 ? 's' : ''}${x.plans ? ` · plans ${x.plans}` : ' · sans plan'}</span></span></summary>
<p class="mt8 pre">${x.dictation || '(pas de dictée)'}</p><a class="btn alt sm mt8" href="/projets/${p.id}?dictee=${x.id}#generer">Repartir de cette dictée</a></details>`)}</section>` : ''}`;
}

r.post('/projets/:id/dossier/generer', loadProject, async (req, res, next) => {
  const p = req.project;
  const text = str(req.body.text).slice(0, 12000);
  const ids = [].concat(req.body.plan_ids || []).map(Number).filter(Boolean);
  const plans = ids.length ? q.all(`SELECT * FROM plans WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, p.id, ...ids) : [];
  if (!plans.length && !text) return res.flashTo(`/projets/${p.id}#generer`, 'Coche au moins un plan ou dicte le travail.', 'ko');
  try {
    const people = L.people();
    if (req.body.replace) q.run('DELETE FROM steps WHERE project_id = ? AND sent = 0 AND ai_generated = 1', p.id);
    const existing = q.all('SELECT title FROM steps WHERE project_id = ? ORDER BY ord', p.id).map((s) => s.title);
    const suppliers = q.all('SELECT name FROM suppliers WHERE subcontractor = 1 ORDER BY name').map((s) => s.name);
    const out = await ai.carnetFromPlans({ project: p, plans, readFile: (f) => fs.readFileSync(filePath(f)), text, people, phases: PHASES, gestes: GESTES, averages: auto.averages(), existing, suppliers });
    const byName = (n) => people.find((x) => x.name.toLowerCase() === String(n).trim().toLowerCase() || (x.role === 'patron' && /^(toi|patron|moi)$/i.test(String(n).trim())));
    const validated = plans.find((x) => x.status === 'validee') || plans[plans.length - 1];
    let ord = q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', p.id).m || 0;
    tx(() => {
      out.fiches.slice(0, 60).forEach((f) => q.run('INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks, plan_id, ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        p.id, ++ord, str(f.titre).slice(0, 120) || 'Fiche', str(f.pieces), byName(f.qui)?.id || null, PHASES.includes(f.etape_frise) ? f.etape_frise : '', GESTES.includes(f.geste) ? f.geste : '',
        Math.max(0, Math.min(200, Number(f.heures) || 0)), str(f.mot_du_patron), JSON.stringify((f.reperes || []).slice(0, 6).map((t) => ({ t: str(t), done: false }))), validated?.id || null));
      if (req.body.pieces) {
        const have = new Set(q.all('SELECT lower(name) n FROM pieces WHERE project_id = ?', p.id).map((x) => x.n));
        out.elements.slice(0, 20).filter((e) => str(e.nom) && !have.has(str(e.nom).toLowerCase())).forEach((e) => q.run('INSERT INTO pieces (project_id, name, descr) VALUES (?, ?, ?)', p.id, str(e.nom), str(e.description)));
        const known = new Set(q.all('SELECT lower(what) w FROM subcontracts WHERE project_id = ?', p.id).map((x) => x.w));
        out.sous_traitance.slice(0, 10).filter((x) => str(x.prestation) && !known.has(str(x.prestation).toLowerCase()))
          .forEach((x) => q.run('INSERT INTO subcontracts (project_id, what, pieces, spec, ai) VALUES (?, ?, ?, ?, 1)', p.id, str(x.prestation), str(x.pieces), str(x.specification)));
      }
      q.run('INSERT INTO carnet_runs (project_id, plans, dictation, remarks, questions, debit, n, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', p.id, plans.map((x) => x.version).join(', '), text,
        str(out.remarques), JSON.stringify(out.questions.slice(0, 10)), JSON.stringify(out.debit.slice(0, 200)), out.fiches.length, ai.MODEL);
      logActivity(p.id, null, `Carnet généré depuis ${plans.length ? `les plans ${plans.map((x) => x.version).join(', ')}` : 'la dictée'} (${out.fiches.length} fiches proposées)`, 'Patron');
    });
    const sst = req.body.pieces ? out.sous_traitance.length : 0;
    res.flashTo(`/projets/${p.id}#carnet`, `${out.fiches.length} fiche(s) proposée(s)${out.debit.length ? `, ${out.debit.length} ligne(s) de débit` : ''}${sst ? `, ${sst} sous-traitance(s) à commander` : ''}. Relis puis « Envoyer à l’atelier ».${out.skipped.length ? ` Plans non lus : ${out.skipped.join(', ')}.` : ''}`);
  } catch (e) {
    if (e instanceof ai.AIError) return res.flashTo(`/projets/${p.id}#generer`, e.message, 'ko');
    next(e);
  }
});

// Dossier de production complet, à imprimer et ranger à l'établi.
r.get('/projets/:id/dossier/imprimer', loadProject, (req, res) => {
  const p = req.project;
  const pm = L.peopleMap();
  const steps = q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, id', p.id);
  const plan = q.get("SELECT * FROM plans WHERE project_id = ? AND status = 'validee' ORDER BY id DESC LIMIT 1", p.id);
  const pieces = q.all('SELECT * FROM pieces WHERE project_id = ? ORDER BY id', p.id);
  const last = q.get('SELECT * FROM carnet_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
  const debit = last ? parse(last.debit) : [];
  const questions = last ? parse(last.questions) : [];
  const sst = subcontracts(p.id);
  const client = p.client_id ? q.get('SELECT name FROM clients WHERE id = ?', p.client_id) : null;
  res.send(printPage('Dossier de production', h`
<table><tr><td><b>Projet</b><br>${p.name}</td><td><b>Client</b><br>${client ? client.name : 'Hors commande client'}</td><td><b>Livraison</b><br>${p.due_date ? ddmmyyyy(p.due_date) : 'à fixer'}</td><td><b>Plan de référence</b><br>${plan ? plan.version : '—'}</td></tr></table>
${p.wood ? h`<p><b>Bois / matière :</b> ${p.wood}</p>` : ''}
${pieces.length ? h`<h2>Éléments</h2><table><tbody>${pieces.map((x) => h`<tr><td><b>${x.name}</b></td><td>${x.descr}</td></tr>`)}</tbody></table>` : ''}
${debit.length ? h`<h2>Liste de débit</h2><table><thead><tr><th>Élément</th><th class="nr">Qté</th><th class="nr">L</th><th class="nr">l</th><th class="nr">Ép.</th><th>Matière</th><th>Remarque</th><th>Débité</th></tr></thead><tbody>
${debit.map((d) => h`<tr><td>${d.piece}</td><td class="nr">${d.quantite}</td><td class="nr">${d.longueur || '?'}</td><td class="nr">${d.largeur || '?'}</td><td class="nr">${d.epaisseur || '?'}</td><td>${d.matiere}</td><td>${d.remarque}</td><td><span class="box"></span></td></tr>`)}</tbody></table>` : ''}
${questions.length ? h`<h2>À vérifier avant de lancer</h2><ul>${questions.map((x) => h`<li>${x}</li>`)}</ul>` : ''}
<h2>Carnet · ${steps.length} fiches</h2>
<table><thead><tr><th>N°</th><th>Fiche</th><th>Qui</th><th class="nr">Prévu</th><th>Fait</th></tr></thead><tbody>
${steps.map((s, i) => { const ck = parse(s.checks); return h`<tr><td>${i + 1}</td><td><b>${s.title}</b>${s.piece ? h` · ${s.piece}` : ''}${s.note ? h`<br><i>« ${s.note} »</i>` : ''}${ck.length ? h`<br>${ck.map((c) => h`<span style="display:inline-block;margin:4px 12px 0 0"><span class="box${c.done ? ' on' : ''}"></span>${c.t}</span>`)}` : ''}</td>
<td>${pm[s.who_id]?.role === 'patron' ? 'Patron' : pm[s.who_id]?.name || 'À prendre'}</td><td class="nr">${s.est_hours ? hoursLabel(s.est_hours) : '—'}</td><td>${s.status === 'done' ? ddmm(s.done_at) : h`<span class="box"></span>`}</td></tr>`; })}
</tbody></table>
${sst.length ? h`<h2>Sous-traitance</h2><table><thead><tr><th>Prestation</th><th>Chez</th><th>Pièces</th><th>Retour prévu</th><th>État</th></tr></thead><tbody>
${sst.map((s) => h`<tr><td><b>${s.what}</b>${s.spec ? h`<br><i>${s.spec}</i>` : ''}</td><td>${s.sname || '—'}</td><td>${s.pieces || '—'}</td><td>${s.due_at ? ddmmyyyy(s.due_at) : '—'}</td><td>${SST_LABEL[s.status]}</td></tr>`)}</tbody></table>` : ''}
${p.notes ? h`<h2>Notes</h2><p>${p.notes}</p>` : ''}`, { ref: p.ref }));
});

module.exports = r;
module.exports.sstSection = sstSection;
module.exports.sstSummary = sstSummary;
module.exports.dossierSection = dossierSection;
module.exports.subcontracts = subcontracts;
module.exports.SST_LABEL = SST_LABEL;
module.exports.isLate = isLate;
