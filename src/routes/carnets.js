'use strict';
// Carnets de fabrication : le patron écrit les fiches, les envoie à l'atelier.
const express = require('express');
const { q, tx, PHASES, GESTES } = require('../db');
const { h, layout, pill, avatar, postBtn, options, ddmm, hoursLabel, rel } = require('../html');
const L = require('../logic');
const { upload, fileUrl } = require('../uploads');
const { loadProject } = require('./patron');
const ai = require('../ai');
const auto = require('../automations');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

r.get('/carnets', (req, res) => {
  const rows = q.all(`SELECT projects.*, COUNT(steps.id) n, SUM(steps.status = 'done') d, SUM(steps.sent = 0 OR steps.changed = 1) pending
    FROM projects LEFT JOIN steps ON steps.project_id = projects.id WHERE projects.status = 'en_cours' GROUP BY projects.id ORDER BY projects.due_date IS NULL, projects.due_date`);
  const body = h`<div class="eb">Projets</div><h1>Carnets de fabrication</h1>
<p class="mut mt8">Un carnet par projet : les fiches que l'atelier suit sur l'iPad, dans l'ordre proposé.</p>
<section class="card mt20">${rows.map((p, i) => h`<div class="row${i ? '' : ' f'}"><div class="grow"><b>${p.name}</b><span class="mut">${p.n ? `${p.n} fiche${p.n > 1 ? 's' : ''} · ${p.d || 0} faite${p.d > 1 ? 's' : ''}` : 'Carnet vide'}${p.pending ? ` · ${p.pending} à envoyer` : ''}</span></div>
${p.pending ? pill('wa', 'À envoyer') : p.n ? pill('ok', 'À jour sur l’iPad') : ''}<a class="btn alt sm" href="/carnets/${p.id}">Ouvrir</a></div>`)}
${rows.length ? '' : h`<p class="mut">Aucun projet en cours.</p>`}</section>`;
  res.send(layout({ title: 'Carnets', tab: 'projets', sub: '/carnets', body, flash: req.flash }));
});

r.get('/carnets/:id', loadProject, (req, res) => {
  const p = req.project;
  const pm = L.peopleMap();
  const steps = q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, id', p.id);
  const sel = steps.find((s) => String(s.id) === String(req.query.fiche)) || steps[0];
  const pending = steps.filter((s) => !s.sent || s.changed).length;
  const totalH = steps.reduce((a, s) => a + (s.est_hours || 0), 0);
  const others = q.all('SELECT projects.id, projects.name, COUNT(steps.id) n FROM projects JOIN steps ON steps.project_id = projects.id WHERE projects.id != ? GROUP BY projects.id ORDER BY projects.created_at DESC LIMIT 12', p.id);
  const plans = q.all('SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC', p.id);
  const client = p.client_id ? q.get('SELECT name FROM clients WHERE id = ?', p.client_id) : null;
  const msgs = sel ? q.all('SELECT messages.*, people.name pname, people.role prole FROM messages LEFT JOIN people ON people.id = messages.person_id WHERE step_id = ? ORDER BY created_at', sel.id) : [];
  if (sel) q.run('UPDATE messages SET read_by_patron = 1 WHERE step_id = ?', sel.id);
  const people = L.people();
  const avg = auto.averages();
  const checks = sel ? JSON.parse(sel.checks) : [];
  const stLabel = (s) => (s.status === 'done' ? pill('ok', `Fait${s.declared_label ? ' · ' + s.declared_label : ''}`) : s.status === 'doing' ? pill('wa', 'En cours') : !s.sent ? pill('no', s.ai_generated ? 'Proposée par l’IA' : 'Pas envoyée') : s.changed ? pill('wa', 'Modifiée') : '');

  const body = h`
<div class="mut"><a href="/projets/${p.id}">${p.name}</a>${client ? ` · ${client.name}` : ''}${p.due_date ? ` · livraison ${ddmm(p.due_date)}` : ''}</div>
<div class="head mt4"><div><h1 class="m0">Carnet de fabrication</h1><p class="mut mt4">${steps.length} fiche${steps.length > 1 ? 's' : ''} · ${hoursLabel(totalH)} prévus · ${steps.filter((s) => s.status === 'done').length} faite(s)</p></div>
<div class="push">${pending ? postBtn(`/carnets/${p.id}/envoyer`, `Envoyer à l'atelier · ${pending} fiche${pending > 1 ? 's' : ''}`, 'btn') : pill('ok', 'Tout est sur l’iPad')}</div></div>

<div class="cols3 mt20">
<aside class="card">
<h2 class="t16">Ajouter</h2>
<form method="post" action="/carnets/${p.id}/fiches" class="mt12"><button class="btn sm wfull">+ Une fiche</button></form>
<div class="h3 mt20">Écris comme tu parles</div>
${ai.enabled() ? h`<form method="post" action="/carnets/${p.id}/ia" class="form" data-busy="L’assistant prépare les fiches…">
<label class="sr" for="iatext">Décris le travail</label><textarea id="iatext" name="text" rows="6" required placeholder="ex. Nina débite le noyer lundi, garde les beaux fils pour la façade. Lucas fait les queues d'aronde du caisson à la main, puis on colle ensemble. Huile-cire 2 couches, et pose murale chez le client, mur en pierre."></textarea>
<button class="btn alt sm">Préparer les fiches</button><p class="mut t12">L’assistant propose des fiches (qui, durée, repères). Rien ne part à l’atelier avant que tu cliques sur « Envoyer ».</p></form>`
  : h`<p class="mut t12">Avec l’assistant IA activé (Pilotage › Automatisations), tu décris le travail en quelques phrases et les fiches se remplissent toutes seules.</p>`}
<div class="h3 mt20">Repartir d'un ancien carnet</div>
<p class="mut">Copie les fiches et les mots du patron, puis ajuste.</p>
${others.map((o) => postBtn(`/carnets/${p.id}/copier`, `${o.name} · ${o.n} fiches`, 'linkbtn block', { from: o.id }, `Copier les ${o.n} fiches de « ${o.name} » à la fin de ce carnet ?`))}
${others.length ? '' : h`<p class="mut t12">Aucun autre carnet pour l’instant.</p>`}
</aside>

<section class="card">
${steps.map((s, i) => h`<div class="fiche${sel && s.id === sel.id ? ' on' : ''}">
<a class="grow fl" href="/carnets/${p.id}?fiche=${s.id}"><span class="num">${i + 1}</span><span class="grow"><b>${s.title}</b><span class="mut">${s.piece}${s.note ? ` · « ${s.note} »` : ''}</span><span class="mut t12">${[s.phase, s.est_hours ? hoursLabel(s.est_hours) : ''].filter(Boolean).join(' · ')}</span></span></a>
${stLabel(s)}${avatar(pm[s.who_id], 30)}
<span class="updown">${postBtn(`/carnets/${p.id}/fiches/${s.id}/monter`, '↑', 'iconbtn', { dir: -1 })}${postBtn(`/carnets/${p.id}/fiches/${s.id}/monter`, '↓', 'iconbtn', { dir: 1 })}</span></div>`)}
${steps.length ? h`<p class="mut t12 mt12">L'ordre est une proposition : l'atelier peut avancer sur une fiche plus loin si le bois ou la colle le demande.</p>` : h`<p class="mut">Carnet vide. Ajoute une première fiche, ou repars d'un ancien carnet.</p>`}
</section>

${sel ? h`<section class="card">
<div class="line"><h2>Fiche ${steps.indexOf(sel) + 1}</h2>${postBtn(`/carnets/${p.id}/fiches/${sel.id}/supprimer`, 'Retirer', 'btn alt sm push', {}, 'Retirer cette fiche du carnet ?')}</div>
<form method="post" action="/carnets/${p.id}/fiches/${sel.id}" enctype="multipart/form-data" class="form mt12">
<label>Titre <input name="title" value="${sel.title}" required></label>
<label>Pièce(s) <input name="piece" value="${sel.piece}" placeholder="ex. Caisson, étagères"></label>
<fieldset class="whosel"><legend>Qui</legend>${people.map((pp) => h`<label class="chip${sel.who_id === pp.id ? ' on' : ''}"><input type="radio" name="who_id" value="${pp.id}" ${sel.who_id === pp.id ? 'checked' : ''}>${pp.role === 'patron' ? 'Toi' : pp.name}</label>`)}<label class="chip${sel.who_id ? '' : ' on'}"><input type="radio" name="who_id" value="" ${sel.who_id ? '' : 'checked'}>À prendre</label></fieldset>
<label>Mot du patron <textarea name="note" rows="3">${sel.note}</textarea></label>
<details ${checks.length || sel.phase || sel.est_hours ? 'open' : ''}><summary class="mut b">Plus de détails (facultatif)</summary>
<div class="form mt8">
<label>Repères, un par ligne <textarea name="checks" rows="3">${checks.map((c) => c.t).join('\n')}</textarea></label>
<div class="grid2"><label>Étape de la frise <select name="phase"><option value="">—</option>${options(PHASES, sel.phase)}</select></label>
<label>Geste (pour le chiffrage) <select name="geste"><option value="">—</option>${options(GESTES, sel.geste)}</select></label></div>
<div class="grid2"><label>Temps prévu (heures)${avg[sel.geste] ? ` · habituellement ${hoursLabel(avg[sel.geste])}` : ''} <input name="est_hours" inputmode="decimal" value="${sel.est_hours || ''}" placeholder="${avg[sel.geste] ? String(Math.round(avg[sel.geste] * 2) / 2).replace('.', ',') : 'vide = moyenne du geste'}"></label>
<label>Plan <select name="plan_id"><option value="">—</option>${options(plans.map((x) => [x.id, x.version]), sel.plan_id)}</select></label></div>
<label>Message vocal (fichier audio) <input type="file" name="audio" accept="audio/*" capture></label>
${sel.audio ? h`<audio controls src="${fileUrl(sel.audio)}"></audio>` : ''}
</div></details>
<button class="btn">Enregistrer</button>
<p class="mut t12">Rien d'autre à remplir. Un titre, qui, et un mot si besoin.</p>
</form>
${msgs.length || sel.sent ? h`<div class="h3 mt20">Échanges sur cette fiche</div>
${msgs.map((m) => h`<div class="msg${m.prole === 'patron' ? ' me' : ''}"><b>${m.prole === 'patron' ? 'Toi' : m.pname}</b> ${m.body}<span class="mut t12"> · ${rel(m.created_at)}</span></div>`)}
<form method="post" action="/carnets/${p.id}/fiches/${sel.id}/message" class="line mt8"><label class="sr" for="msg">Message</label><input id="msg" class="qin" name="body" required placeholder="Répondre sur l’iPad"><button class="btn alt sm">Envoyer</button></form>` : ''}
</section>` : ''}
</div>`;
  res.send(layout({ title: `Carnet · ${p.name}`, tab: 'projets', sub: '/carnets', body, flash: req.flash }));
});

r.post('/carnets/:id/fiches', loadProject, (req, res) => {
  const ord = (q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', req.project.id).m || 0) + 1;
  const id = q.run("INSERT INTO steps (project_id, ord, title) VALUES (?, ?, 'Nouvelle fiche')", req.project.id, ord).lastInsertRowid;
  res.redirect(`/carnets/${req.project.id}?fiche=${id}`);
});

r.post('/carnets/:id/fiches/:sid', loadProject, upload.single('audio'), (req, res) => {
  const b = req.body;
  const s = q.get('SELECT * FROM steps WHERE id = ? AND project_id = ?', req.params.sid, req.project.id);
  if (!s) return res.redirect(`/carnets/${req.project.id}`);
  const old = Object.fromEntries(JSON.parse(s.checks).map((c) => [c.t, c.done]));
  const checks = str(b.checks).split('\n').map((t) => t.trim()).filter(Boolean).map((t) => ({ t, done: !!old[t] }));
  q.run(`UPDATE steps SET title = ?, piece = ?, who_id = ?, note = ?, checks = ?, phase = ?, geste = ?, est_hours = ?, plan_id = ?, audio = COALESCE(?, audio),
    changed = CASE WHEN sent = 1 THEN 1 ELSE 0 END, seen = CASE WHEN sent = 1 THEN 0 ELSE seen END WHERE id = ?`,
  str(b.title) || 'Fiche', str(b.piece), b.who_id ? Number(b.who_id) : null, str(b.note), JSON.stringify(checks), str(b.phase), str(b.geste),
  num(b.est_hours) || Math.round((auto.averages()[str(b.geste)] || 0) * 2) / 2, b.plan_id ? Number(b.plan_id) : null, req.file ? req.file.filename : null, s.id);
  res.flashTo(`/carnets/${req.project.id}?fiche=${s.id}`, s.sent ? 'Enregistré. Envoie la modification pour qu’elle soit signalée sur l’iPad.' : 'Fiche enregistrée.');
});

r.post('/carnets/:id/fiches/:sid/monter', loadProject, (req, res) => {
  const steps = q.all('SELECT id FROM steps WHERE project_id = ? ORDER BY ord, id', req.project.id).map((s) => s.id);
  const i = steps.indexOf(Number(req.params.sid)); const j = i + Number(req.body.dir);
  if (i >= 0 && j >= 0 && j < steps.length) {
    [steps[i], steps[j]] = [steps[j], steps[i]];
    tx(() => steps.forEach((id, k) => q.run('UPDATE steps SET ord = ? WHERE id = ?', k + 1, id)));
  }
  res.redirect(`/carnets/${req.project.id}?fiche=${req.params.sid}`);
});

r.post('/carnets/:id/fiches/:sid/supprimer', loadProject, (req, res) => {
  q.run('DELETE FROM steps WHERE id = ? AND project_id = ?', req.params.sid, req.project.id);
  res.flashTo(`/carnets/${req.project.id}`, 'Fiche retirée.');
});

r.post('/carnets/:id/fiches/:sid/message', loadProject, (req, res) => {
  const s = q.get('SELECT id FROM steps WHERE id = ? AND project_id = ?', req.params.sid, req.project.id);
  if (s && str(req.body.body)) q.run('INSERT INTO messages (step_id, person_id, body, read_by_patron) VALUES (?, ?, ?, 1)', s.id, L.patron().id, str(req.body.body));
  res.redirect(`/carnets/${req.project.id}?fiche=${req.params.sid}`);
});

// L'assistant transforme une description libre en fiches (brouillons, pas encore envoyées).
r.post('/carnets/:id/ia', loadProject, async (req, res, next) => {
  const p = req.project;
  const text = str(req.body.text).slice(0, 8000);
  if (!text) return res.redirect(`/carnets/${p.id}`);
  try {
    const people = L.people();
    const existing = q.all('SELECT title FROM steps WHERE project_id = ? ORDER BY ord', p.id).map((s) => s.title);
    const out = await ai.carnetFromText({ project: p, text, people, phases: PHASES, gestes: GESTES, averages: auto.averages(), existing });
    const byName = (n) => people.find((x) => x.name.toLowerCase() === String(n).trim().toLowerCase() || (x.role === 'patron' && /^(toi|patron|moi)$/i.test(String(n).trim())));
    let ord = q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', p.id).m || 0;
    let first = null;
    tx(() => out.fiches.slice(0, 40).forEach((f) => {
      const id = q.run('INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks, ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        p.id, ++ord, str(f.titre).slice(0, 120) || 'Fiche', str(f.pieces), byName(f.qui)?.id || null, PHASES.includes(f.etape_frise) ? f.etape_frise : '', GESTES.includes(f.geste) ? f.geste : '',
        Math.max(0, Math.min(200, Number(f.heures) || 0)), str(f.mot_du_patron), JSON.stringify((f.reperes || []).slice(0, 6).map((t) => ({ t: str(t), done: false })))).lastInsertRowid;
      first = first || id;
    }));
    const msg = `${out.fiches.length} fiche(s) proposée(s). Relis-les, ajuste, puis « Envoyer à l’atelier ».${out.remarques ? ` Remarque de l’assistant : ${out.remarques}` : ''}`;
    res.flashTo(`/carnets/${p.id}${first ? `?fiche=${first}` : ''}`, msg);
  } catch (e) {
    if (e instanceof ai.AIError) return res.flashTo(`/carnets/${p.id}`, e.message, 'ko');
    next(e);
  }
});

r.post('/carnets/:id/envoyer', loadProject, (req, res) => {
  tx(() => {
    q.run('UPDATE steps SET sent = 1, changed = 0 WHERE project_id = ? AND (sent = 0 OR changed = 1)', req.project.id);
    q.run("UPDATE projects SET sent_to_atelier_at = datetime('now') WHERE id = ?", req.project.id);
  });
  res.flashTo(`/carnets/${req.project.id}`, 'Envoyé. L’équipe voit ses fiches dans « Mon carnet ». Une modification ensuite leur est signalée.');
});

r.post('/carnets/:id/copier', loadProject, (req, res) => {
  const src = q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, id', req.body.from);
  let ord = q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', req.project.id).m || 0;
  tx(() => src.forEach((s) => q.run('INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.project.id, ++ord, s.title, s.piece, s.who_id, s.phase, s.geste, s.est_hours, s.note, JSON.stringify(JSON.parse(s.checks).map((c) => ({ t: c.t, done: false }))))));
  res.flashTo(`/carnets/${req.project.id}`, `${src.length} fiches copiées. Ajuste-les puis envoie à l’atelier.`);
});

module.exports = r;
