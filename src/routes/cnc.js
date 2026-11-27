'use strict';
// CNC : bibliothèque d'outils et réglages machine, travaux CNC d'un projet (pièces → imbrication → parcours → programme),
// programmes enregistrés par version, et programmes faits dans un logiciel de FAO (déposés tels quels).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { q, tx, setting, setSetting, logActivity, UPLOAD_DIR } = require('../db');
const { h, raw, layout, pill, postBtn, options, ddmm, hoursLabel, printPage } = require('../html');
const { upload, fileUrl, filePath } = require('../uploads');
const { loadProject } = require('./patron');
const E = require('../cnc/engine');
const POST = require('../cnc/post');
const ai = require('../ai');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const parse = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const minutesLabel = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`);

// --- Réglages ---
const cfg = () => ({ ...E.DEFAULT_CFG, sheet_l: 2800, sheet_w: 2070, ...parse(setting('cnc_cfg'), {}) });
const post = () => ({ ...POST.POST_DEFAULT, ...parse(setting('cnc_post'), {}) });
const materials = () => parse(setting('cnc_materials'), null) || ['Mélaminé', 'MDF', 'Contreplaqué', 'Panneau plaqué chêne', 'Chêne massif'];
function tools() {
  const list = q.all('SELECT * FROM cnc_tools WHERE active = 1 ORDER BY num');
  const feeds = q.all('SELECT * FROM cnc_feeds');
  return list.map((t) => ({ ...t, feeds: feeds.filter((f) => f.tool_id === t.id) }));
}

// --- Travaux ---
function loadJobRow(id) { return q.get('SELECT * FROM cnc_jobs WHERE id = ?', id); }
function engineJob(row) {
  const parts = parse(row.parts, []).map((p) => {
    const po = E.parseOps(p.ops_text);
    return { name: p.name || 'Pièce', l: Number(p.l) || 0, w: Number(p.w) || 0, qty: Math.max(0, Math.round(Number(p.qty) || 0)), grain: !!p.grain, ops: po.ops, opsErrors: po.errors, ops_text: p.ops_text || '' };
  });
  return { ...row, parts };
}
function computeJob(row) {
  const job = engineJob(row);
  return { job, res: E.compute(job, tools(), cfg()) };
}
const loadJob = (req, res, next) => {
  const row = loadJobRow(req.params.jid);
  if (!row) return res.status(404).send(layout({ title: 'Introuvable', tab: 'projets', body: h`<h1>Travail CNC introuvable</h1>` }));
  req.job = row;
  req.project = q.get('SELECT * FROM projects WHERE id = ?', row.project_id);
  next();
};

// Liste de pièces → un travail par matière et épaisseur (un panneau = une matière, une épaisseur).
function createJobs(projectId, items, source) {
  const c = cfg();
  const groups = new Map();
  for (const it of items) {
    const key = `${it.material || ''}|${it.thickness || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const ids = [];
  tx(() => {
    for (const [key, list] of groups) {
      const [mat, th] = key.split('|');
      const material = matchMaterial(mat);
      const parts = list.map((it) => ({ name: it.name, l: it.l, w: it.w, qty: it.qty || 1, grain: it.grain ?? /chêne|noyer|frêne|plaqu|massif|bois|décor/i.test(mat), ops_text: it.ops_text || '' }));
      ids.push(q.run('INSERT INTO cnc_jobs (project_id, name, material, thickness, sheet_l, sheet_w, parts, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        projectId, `${material} ${th || '?'} mm`, material, Number(th) || 19, c.sheet_l, c.sheet_w, JSON.stringify(parts), source).lastInsertRowid);
    }
  });
  return ids;
}
function matchMaterial(m) {
  const s = String(m || '').toLowerCase();
  return materials().find((x) => x.toLowerCase() === s) || materials().find((x) => s && (s.includes(x.toLowerCase()) || x.toLowerCase().includes(s))) || (m ? String(m).slice(0, 40) : materials()[0]);
}

// Liste de débit d'OpenCutList (SketchUp) ou tout CSV avec Nom / Quantité / Longueur / Largeur / Épaisseur / Matière.
function parseCutList(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { items: [], errors: ['Fichier vide ou sans en-tête.'] };
  const sep = [';', '\t', ','].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const split = (l) => { const out = []; let cur = '', inQ = false; for (const ch of l) { if (ch === '"') inQ = !inQ; else if (ch === sep && !inQ) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0]).map((x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = (...names) => head.findIndex((x) => names.some((n) => x === n || x.startsWith(n)));
  const c = { name: col('nom', 'name', 'designation', 'piece', 'part'), qty: col('quantite', 'qte', 'count', 'nombre', 'qty', 'nb'), l: col('longueur', 'length', 'long'), w: col('largeur', 'width', 'larg'), t: col('epaisseur', 'thickness', 'ep'), m: col('matiere', 'material', 'materiau') };
  if (c.l < 0 || c.w < 0) return { items: [], errors: ['Colonnes « Longueur » et « Largeur » introuvables dans l’en-tête.'] };
  const items = [], errors = [];
  lines.slice(1).forEach((l, i) => {
    const v = split(l);
    const L = num(v[c.l]), W = num(v[c.w]);
    if (!(L > 0 && W > 0)) { if (v.some(Boolean)) errors.push(`Ligne ${i + 2} ignorée (dimensions illisibles).`); return; }
    items.push({ name: (c.name >= 0 && v[c.name]) || `Pièce ${i + 1}`, qty: Math.max(1, Math.round(num(v[c.qty]) || 1)), l: L, w: W, thickness: c.t >= 0 ? num(v[c.t]) : null, material: c.m >= 0 ? v[c.m] : '' });
  });
  return { items, errors };
}

// ============================================================================
// Bloc « Usinage CNC » dans l'onglet Dossier de production
// ============================================================================
function cncSection(p) {
  const jobs = q.all('SELECT * FROM cnc_jobs WHERE project_id = ? ORDER BY id', p.id);
  const progs = q.all("SELECT * FROM cnc_programs WHERE project_id = ? AND kind = 'externe' ORDER BY active DESC, id DESC", p.id);
  const lastRun = q.get('SELECT debit FROM carnet_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
  const hasDebit = lastRun && parse(lastRun.debit, []).length;
  const plans = q.all("SELECT * FROM plans WHERE project_id = ? AND file IS NOT NULL ORDER BY (status = 'validee') DESC, id DESC", p.id);
  const summary = (j) => {
    const { res } = computeJob(j);
    const v = q.get('SELECT MAX(version) v FROM cnc_programs WHERE job_id = ? AND active = 1', j.id)?.v;
    return { res, v };
  };
  return h`<section class="card" id="cnc"><div class="line"><h2>Usinage CNC</h2><a class="mut t13 push" href="/cnc">Outils et réglages de la CNC</a></div>
<p class="mut">Les pièces plates sont imbriquées sur les panneaux, puis Carchon calcule les parcours et le programme de la machine. Pour une pièce 3D ou galbée, fais le parcours dans ton logiciel de FAO et dépose le programme plus bas.</p>
${jobs.map((j, i) => { const s = summary(j); return h`<div class="row${i ? '' : ' f'}"><a class="grow" href="/cnc/travaux/${j.id}"><b>${j.name}</b><span class="mut">${s.res.pieces} pièce${s.res.pieces > 1 ? 's' : ''} · ${s.res.sheets.length} panneau${s.res.sheets.length > 1 ? 'x' : ''} ${j.sheet_l} × ${j.sheet_w} · ${minutesLabel(s.res.minutes)} machine</span></a>
${s.res.errors.length ? pill('ko', `${s.res.errors.length} point${s.res.errors.length > 1 ? 's' : ''} à corriger`) : s.v ? pill('ok', `Programme V${s.v}`) : pill('wa', 'À valider')}<a class="btn alt sm" href="/cnc/travaux/${j.id}">Ouvrir</a></div>`; })}
${jobs.length ? '' : h`<p class="mut mt8">Aucun usinage CNC pour ce projet.</p>`}
<details class="mt12"${jobs.length ? '' : ''}><summary class="btn alt sm">+ Préparer un usinage CNC</summary>
<div class="cnc-new mt12">
${hasDebit ? h`<form method="post" action="/projets/${p.id}/cnc" class="cnc-src"><input type="hidden" name="source" value="debit"><b>Depuis la liste de débit</b><span class="mut t12">Celle lue dans les plans du dossier. Les usinages (trous, rainures) se complètent ensuite.</span><button class="btn alt sm">Reprendre la liste de débit</button></form>` : ''}
<form method="post" action="/projets/${p.id}/cnc/csv" enctype="multipart/form-data" class="cnc-src"><b>Depuis SketchUp (OpenCutList)</b><span class="mut t12">Dans SketchUp : OpenCutList › Fiche de débit › Exporter en CSV. Un travail est créé par matière et épaisseur.</span>
<input type="file" name="file" accept=".csv,text/csv,text/plain" required><button class="btn alt sm">Importer</button></form>
${ai.enabled() ? h`<form method="post" action="/projets/${p.id}/cnc/ia" class="cnc-src" data-busy="Lecture des plans… (1 à 3 minutes)"><b>Lire les plans avec l’assistant</b><span class="mut t12">Il relève les pièces et leurs usinages (perçages, rainures, poches). Il n’écrit jamais le programme : Carchon le calcule et le contrôle.</span>
${plans.map((x) => h`<label class="ck"><input type="checkbox" name="plan_ids" value="${x.id}" ${x.status === 'validee' ? 'checked' : ''}> ${x.version}${x.descr ? ` · ${x.descr}` : ''}</label>`)}
<textarea name="text" rows="2" placeholder="ex. Fonds en 8 mm dans rainure à 10 mm du chant arrière, système 32 sur les joues."></textarea><button class="btn alt sm">Lire les plans</button></form>` : ''}
<form method="post" action="/projets/${p.id}/cnc" class="cnc-src"><input type="hidden" name="source" value="vide"><b>Liste vide</b><span class="mut t12">Tu saisis les pièces à la main.</span>
<label>Matière <select name="material">${options(materials())}</select></label><label>Épaisseur (mm) <input name="thickness" inputmode="decimal" value="19"></label><button class="btn alt sm">Créer</button></form>
</div></details>

<div class="h3 mt20">Programmes faits dans un logiciel de FAO</div>
${progs.map((x) => h`<div class="row"><span class="grow"><b>${x.name}</b> <span class="mut">V${x.version} · ${ddmm(x.created_at)}${x.note ? ` · ${x.note}` : ''}</span></span>${x.active ? pill('ok', 'En service') : pill('no', 'Remplacé')}<a class="btn alt sm" href="${fileUrl(x.file)}" download="${x.name}">Télécharger</a></div>`)}
<form method="post" action="/projets/${p.id}/cnc/programme" enctype="multipart/form-data" class="line mt8 cnc-up"><input type="file" name="file" required accept=".nc,.tap,.cnc,.gcode,.ngc,.txt,.dxf"><input class="qin" name="note" placeholder="ex. Pied galbé, finition 3D"><button class="btn alt sm">Déposer</button></form>
<p class="mut t12">Un programme déposé sous le même nom remplace l’ancien (gardé en version précédente). L’atelier le retrouve sur la fiche « Usinage CNC » de l’iPad.</p>
</section>`;
}

// --- Création de travaux ---
r.post('/projets/:id/cnc', loadProject, (req, res) => {
  const p = req.project;
  let items = [];
  if (req.body.source === 'debit') {
    const run = q.get('SELECT debit FROM carnet_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
    const skipped = [];
    for (const d of parse(run?.debit, [])) {
      const L = num(d.longueur), W = num(d.largeur), T = num(d.epaisseur);
      if (L > 0 && W > 0) items.push({ name: d.piece, qty: Math.max(1, Math.round(num(d.quantite) || 1)), l: L, w: W, thickness: T, material: d.matiere });
      else skipped.push(d.piece);
    }
    if (!items.length) return res.flashTo(`/projets/${p.id}#cnc`, 'La liste de débit n’a pas de pièce avec ses deux dimensions lisibles.', 'ko');
    const ids = createJobs(p.id, items, 'débit du dossier');
    logActivity(p.id, null, `Usinage CNC préparé depuis la liste de débit (${items.length} pièces)`, 'Patron');
    return res.flashTo(`/cnc/travaux/${ids[0]}`, `${items.length} pièce(s) reprise(s)${ids.length > 1 ? ` en ${ids.length} travaux (une matière et une épaisseur chacun)` : ''}.${skipped.length ? ` Sans dimensions, à saisir : ${skipped.join(', ')}.` : ''} Ajoute les usinages, puis vérifie l’aperçu.`);
  }
  const ids = createJobs(p.id, [], 'saisie');
  if (!ids.length) {
    const c = cfg();
    const id = q.run('INSERT INTO cnc_jobs (project_id, name, material, thickness, sheet_l, sheet_w, parts, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, `${str(req.body.material) || materials()[0]} ${num(req.body.thickness) || 19} mm`, str(req.body.material) || materials()[0], num(req.body.thickness) || 19, c.sheet_l, c.sheet_w, '[]', 'saisie').lastInsertRowid;
    return res.redirect(`/cnc/travaux/${id}`);
  }
  res.redirect(`/cnc/travaux/${ids[0]}`);
});

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
r.post('/projets/:id/cnc/csv', loadProject, memUpload.single('file'), (req, res) => {
  const p = req.project;
  if (!req.file) return res.flashTo(`/projets/${p.id}#cnc`, 'Choisis le fichier CSV exporté d’OpenCutList.', 'ko');
  const { items, errors } = parseCutList(req.file.buffer.toString('utf8'));
  if (!items.length) return res.flashTo(`/projets/${p.id}#cnc`, `Rien d’importé. ${errors.join(' ')}`, 'ko');
  const ids = createJobs(p.id, items, 'SketchUp (CSV)');
  logActivity(p.id, null, `Liste de pièces CNC importée de SketchUp (${items.length} lignes)`, 'Patron');
  res.flashTo(`/cnc/travaux/${ids[0]}`, `${items.length} pièce(s) importée(s)${ids.length > 1 ? `, en ${ids.length} travaux (une matière et une épaisseur chacun : voir le dossier)` : ''}.${errors.length ? ` ${errors.slice(0, 3).join(' ')}` : ''}`);
});

r.post('/projets/:id/cnc/ia', loadProject, async (req, res, next) => {
  const p = req.project;
  const ids = [].concat(req.body.plan_ids || []).map(Number).filter(Boolean);
  const plans = ids.length ? q.all(`SELECT * FROM plans WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`, p.id, ...ids) : [];
  try {
    const run = q.get('SELECT debit FROM carnet_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
    const out = await ai.cncFromPlans({ project: p, plans, readFile: (f) => fs.readFileSync(filePath(f)), text: str(req.body.text).slice(0, 6000), debit: parse(run?.debit, []), materials: materials() });
    const fmt = (n) => String(Math.round(n * 100) / 100);
    const items = out.pieces.filter((x) => x.longueur > 0 && x.largeur > 0).map((x) => ({
      name: x.nom, qty: Math.max(1, Math.round(x.quantite || 1)), l: x.longueur, w: x.largeur, thickness: x.epaisseur, material: x.matiere, grain: x.sens_du_fil,
      ops_text: x.usinages.map((u) => {
        const pdep = u.traversant ? 'T' : fmt(u.profondeur);
        if (u.type === 'trou') return `trou x=${fmt(u.x)} y=${fmt(u.y)} d=${fmt(u.diametre)} p=${pdep}`;
        if (u.type === 'rainure') return `rainure x1=${fmt(u.x)} y1=${fmt(u.y)} x2=${fmt(u.x2)} y2=${fmt(u.y2)} l=${fmt(u.largeur)} p=${pdep}`;
        return `poche x=${fmt(u.x)} y=${fmt(u.y)} lo=${fmt(u.longueur)} la=${fmt(u.largeur)} p=${pdep}`;
      }).join('\n'),
    }));
    if (!items.length) return res.flashTo(`/projets/${p.id}#cnc`, `L’assistant n’a trouvé aucune pièce à usiner.${out.questions.length ? ` ${out.questions.join(' ')}` : ''}`, 'ko');
    const jids = createJobs(p.id, items, `plans ${plans.map((x) => x.version).join(', ')}`);
    if (out.questions.length) q.run('UPDATE cnc_jobs SET source = ? WHERE id IN (' + jids.map(() => '?').join(',') + ')', `plans ${plans.map((x) => x.version).join(', ')} · à vérifier : ${out.questions.join(' · ')}`.slice(0, 1500), ...jids);
    logActivity(p.id, null, `Pièces CNC lues dans les plans (${items.length})`, 'Patron');
    res.flashTo(`/cnc/travaux/${jids[0]}`, `${items.length} pièce(s) relevée(s). Vérifie chaque cote et chaque usinage sur l’aperçu avant de valider.${out.skipped.length ? ` Plans non lus : ${out.skipped.join(', ')}.` : ''}`);
  } catch (e) {
    if (e instanceof ai.AIError) return res.flashTo(`/projets/${p.id}#cnc`, e.message, 'ko');
    next(e);
  }
});

// Programme fait ailleurs (FAO) : déposé tel quel, versionné par nom de fichier.
const PROG_EXT = /\.(nc|tap|cnc|gcode|ngc|txt|dxf)$/i;
const progUpload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(file.originalname).toLowerCase().match(PROG_EXT)?.[0] || '.nc')) }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, PROG_EXT.test(file.originalname)),
});
r.post('/projets/:id/cnc/programme', loadProject, progUpload.single('file'), (req, res) => {
  const p = req.project;
  if (!req.file) return res.flashTo(`/projets/${p.id}#cnc`, 'Format refusé : .nc, .tap, .cnc, .gcode, .ngc, .txt ou .dxf.', 'ko');
  const name = path.basename(req.file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 80);
  tx(() => {
    const v = (q.get("SELECT MAX(version) v FROM cnc_programs WHERE project_id = ? AND kind = 'externe' AND name = ?", p.id, name).v || 0) + 1;
    q.run("UPDATE cnc_programs SET active = 0 WHERE project_id = ? AND kind = 'externe' AND name = ?", p.id, name);
    q.run("INSERT INTO cnc_programs (project_id, version, kind, name, file, note) VALUES (?, ?, 'externe', ?, ?, ?)", p.id, v, name, req.file.filename, str(req.body.note));
    ensureStep(p, { title: 'Usinage CNC', note: `Programme ${name}${str(req.body.note) ? ` · ${str(req.body.note)}` : ''}` });
    logActivity(p.id, null, `Programme CNC déposé : ${name} (V${v})`, 'Patron');
  });
  res.flashTo(`/projets/${p.id}#cnc`, 'Programme déposé. Il est sur la fiche « Usinage CNC » du carnet.');
});

// Fiche « Usinage CNC » du carnet : créée une fois, mise à jour à chaque programme.
function ensureStep(p, { stepId, title, hours, piece, note }) {
  let s = stepId ? q.get('SELECT * FROM steps WHERE id = ? AND project_id = ?', stepId, p.id) : q.get("SELECT * FROM steps WHERE project_id = ? AND geste = 'Usinage CNC' AND title = ? ORDER BY id LIMIT 1", p.id, title);
  if (!s) {
    const ord = (q.get("SELECT MIN(ord) m FROM steps WHERE project_id = ? AND phase IN ('Assemblage', 'Finition', 'Contrôle')", p.id)?.m || (q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', p.id).m || 0) + 1);
    q.run('UPDATE steps SET ord = ord + 1 WHERE project_id = ? AND ord >= ?', p.id, ord);
    const id = q.run("INSERT INTO steps (project_id, ord, title, piece, phase, geste, est_hours, note, checks) VALUES (?, ?, ?, ?, 'Débit', 'Usinage CNC', ?, ?, ?)", p.id, ord, title, piece || '', hours || 0, note || '',
      JSON.stringify(['Zéro X/Y au coin avant gauche du panneau', 'Zéro Z vérifié', 'Martyr en bon état, dépression OK'].map((t) => ({ t, done: false })))).lastInsertRowid;
    return id;
  }
  q.run(`UPDATE steps SET est_hours = COALESCE(?, est_hours), piece = COALESCE(?, piece), note = ?, changed = CASE WHEN sent = 1 THEN 1 ELSE 0 END, seen = CASE WHEN sent = 1 THEN 0 ELSE seen END WHERE id = ?`,
    hours ?? null, piece ?? null, note || s.note, s.id);
  return s.id;
}

// ============================================================================
// Page d'un travail CNC
// ============================================================================
r.get('/cnc/travaux/:jid', loadJob, (req, res) => {
  const p = req.project, row = req.job;
  const { job, res: R } = computeJob(row);
  const c = cfg();
  const tl = tools();
  const progs = q.all("SELECT * FROM cnc_programs WHERE job_id = ? AND kind = 'carchon' ORDER BY version DESC, sheet", row.id);
  const lastV = progs.find((x) => x.active)?.version;
  const ok = !R.errors.length && R.sheets.length;
  const checked = setting('cnc_tools_checked') === '1';
  const toolsUsed = [...new Map(R.sheets.flatMap((s) => s.ops.map((o) => [o.tool.id, o.tool]))).values()].sort((a, b) => a.num - b.num);
  const n = job.parts.length;
  const body = h`
<div class="mut"><a href="/projets">Projets</a> › <a href="/projets/${p.id}#cnc">${p.name}</a> › Usinage CNC</div>
<div class="head mt4"><div><div class="ref">Dossier ${p.ref} · CNC</div><h1 class="m0">${row.name}</h1><p class="mut mt4">${row.source ? `Source : ${row.source}` : ''}</p></div>
<div class="push line"><a class="btn alt" href="/cnc/travaux/${row.id}/etiquettes">Étiquettes</a>${ok ? postBtn(`/cnc/travaux/${row.id}/valider`, lastV ? `Enregistrer la V${lastV + 1}` : 'Valider le programme', 'btn', {}, 'Enregistrer ces programmes pour l’atelier ? Ils remplacent la version précédente sur la fiche du carnet.') : ''}</div></div>
${checked ? '' : h`<section class="card warm mt20"><b>Bibliothèque d’outils pas encore vérifiée.</b> <span class="mut">Les vitesses et avances de départ sont prudentes mais génériques. Vérifie numéros d’outils, diamètres et longueurs utiles dans <a href="/cnc">Outils et réglages</a> avant le premier usinage.</span></section>`}

<div class="suivi mt20">
<div class="suivi-t"><span class="h3">Panneaux</span><b>${R.sheets.length} × ${row.sheet_l} × ${row.sheet_w}</b><span class="mut t12">${row.material} ${row.thickness} mm</span></div>
<div class="suivi-t"><span class="h3">Rendement matière</span><b>${Math.round(R.yield * 100)} %</b><span class="mut t12">${R.pieces} pièce${R.pieces > 1 ? 's' : ''} imbriquée${R.pieces > 1 ? 's' : ''}</span></div>
<div class="suivi-t"><span class="h3">Temps machine</span><b>${minutesLabel(R.minutes)}</b><span class="mut t12">chargement des panneaux compris</span></div>
<div class="suivi-t${R.errors.length ? ' ko' : ''}"><span class="h3">Contrôles</span><b>${R.errors.length ? `${R.errors.length} à corriger` : 'Tout est bon'}</b><span class="mut t12">${R.changes} changement${R.changes > 1 ? 's' : ''} d’outil</span></div>
</div>

${R.errors.length ? h`<section class="card danger mt20"><h2>À corriger avant d’usiner</h2><ul class="qlist">${R.errors.map((e) => h`<li>${e}</li>`)}</ul><p class="mut t12 mt8">Tant qu’il reste un point ici, aucun programme ne peut être téléchargé.</p></section>` : ''}
${R.warnings.length ? h`<section class="card warm mt20"><h2>À savoir</h2><ul class="qlist">${R.warnings.map((e) => h`<li>${e}</li>`)}</ul></section>` : ''}

${R.sheets.map((s) => { const v = POST.svg(s, job); return h`<section class="card mt20" id="panneau${s.index + 1}"><div class="line"><h2>Panneau ${s.index + 1} / ${R.sheets.length}</h2><span class="mut t13">${s.placements.length} pièces · ${minutesLabel(s.minutes)} · ${String(Math.round(s.cut_m * 10) / 10).replace('.', ',')} m usinés · ${String(Math.round(s.rapid_m * 10) / 10).replace('.', ',')} m à vide</span>
<span class="push line">${ok ? h`<a class="btn alt sm" href="/cnc/travaux/${row.id}/panneau/${s.index + 1}.nc?vide=1" title="Tous les Z remontés de ${c.dry_offset} mm">Essai à vide</a><a class="btn sm" href="/cnc/travaux/${row.id}/panneau/${s.index + 1}.nc">Programme .nc</a>` : ''}<a class="btn alt sm" href="/cnc/travaux/${row.id}/panneau/${s.index + 1}.dxf">DXF</a></span></div>
<div class="cnc-view mt12">${raw(v.svg)}</div>
<div class="line mt8"><label class="grow cnc-play">Avancement du programme <input type="range" min="0" max="${s.ops.length}" value="${s.ops.length}" data-cnc-slider="#panneau${s.index + 1} .cnc-svg"></label>
<span class="cnc-legend">${toolsUsed.filter((t) => v.colors[t.id]).map((t) => h`<span><i style="background:${v.colors[t.id]}"></i>T${t.num} Ø${t.diameter}</span>`)}<span><i class="dash"></i>à vide</span></span></div>
<details class="mt8"><summary class="mut t13">Ordre des opérations (${s.ops.length})</summary><ol class="cnc-ops">${s.ops.map((o) => h`<li>T${o.tool.num} · ${o.label}</li>`)}</ol></details>
</section>`; })}

<section class="card mt20" id="pieces"><div class="line"><h2>Pièces et usinages</h2><span class="mut t13">Cotes finies en mm. Origine des usinages : coin bas-gauche de la pièce, vue de dessus.</span></div>
<form method="post" action="/cnc/travaux/${row.id}" class="form mt12">
<div class="grid4"><label>Matière <select name="material">${options([...new Set([...materials(), row.material])], row.material)}</select></label><label>Épaisseur (mm) <input name="thickness" inputmode="decimal" value="${row.thickness}"></label>
<label>Panneau, longueur <input name="sheet_l" inputmode="decimal" value="${row.sheet_l}"></label><label>Panneau, largeur <input name="sheet_w" inputmode="decimal" value="${row.sheet_w}"></label></div>
<input type="hidden" name="n" value="${n + 1}">
<div class="tablebox"><table class="tbl cnc-parts"><thead><tr><th>Pièce</th><th class="nr">Long. (X)</th><th class="nr">Larg. (Y)</th><th class="nr">Qté</th><th title="Fil ou décor à respecter : pas de rotation">Fil</th><th>Usinages</th><th></th></tr></thead><tbody>
${[...job.parts, { name: '', l: '', w: '', qty: 1, grain: false, ops_text: '', blank: true }].map((pt, i) => h`<tr${pt.blank ? raw(' class="new"') : ''}><td><input name="name_${i}" value="${pt.name}" placeholder="${pt.blank ? '+ nouvelle pièce' : ''}"></td><td><input name="l_${i}" value="${pt.l}" inputmode="decimal" class="nr"></td><td><input name="w_${i}" value="${pt.w}" inputmode="decimal" class="nr"></td><td><input name="qty_${i}" value="${pt.qty}" inputmode="numeric" class="nr"></td>
<td class="center"><input type="checkbox" name="grain_${i}" value="1" ${pt.grain ? 'checked' : ''} aria-label="Fil à respecter" title="Le fil ou le décor suit la longueur du panneau : la pièce ne sera jamais tournée"></td>
<td><textarea name="ops_${i}" rows="${Math.max(1, Math.min(6, String(pt.ops_text).split('\n').length))}" placeholder="${pt.blank ? 'trou x=37 y=32 d=5 p=13' : 'aucun'}">${pt.ops_text}</textarea>${pt.opsErrors?.length ? h`<div class="red t12">${pt.opsErrors.join(' ')}</div>` : ''}</td>
<td>${pt.blank ? '' : h`<label class="ck t12 nowrap"><input type="checkbox" name="del_${i}" value="1"> Retirer</label>`}</td></tr>`)}
</tbody></table></div>
<details><summary class="mut t13">Écrire les usinages</summary><div class="pre t12 mt8">trou x=37 y=32 d=5 p=13          perçage Ø5, 13 mm de profondeur
trou x=22 y=100 d=35 p=12.5      charnière
trou x=360 y=280 d=8 p=T         traversant
rainure x1=0 y1=10 x2=720 y2=10 l=8 p=8     rainure de fond, de bout en bout
poche x=100 y=50 lo=200 la=80 p=5            poche rectangulaire (coin bas-gauche)</div></details>
<div class="line"><button class="btn">Enregistrer et recalculer</button><span class="mut t12">L’imbrication et les parcours se recalculent à chaque enregistrement.</span></div>
</form></section>

${progs.length ? h`<section class="card mt20"><h2>Programmes enregistrés</h2>${progs.map((x, i) => h`<div class="row${i ? '' : ' f'}"><span class="grow"><b>${x.name}</b> <span class="mut">V${x.version} · ${ddmm(x.created_at)}${x.minutes ? ` · ${minutesLabel(x.minutes)}` : ''}</span></span>${x.active ? pill('ok', 'Sur l’iPad') : pill('no', 'Ancienne version')}<a class="btn alt sm" href="${fileUrl(x.file)}" download="${x.name}">Télécharger</a></div>`)}</section>` : ''}

<section class="card mt20"><h2>Ce travail</h2><div class="line mt8">
${R.sheets.length ? postBtn(`/cnc/travaux/${row.id}/achats`, `Ajouter ${R.sheets.length} panneau${R.sheets.length > 1 ? 'x' : ''} aux achats`, 'btn alt sm') : ''}
${postBtn(`/cnc/travaux/${row.id}/supprimer`, 'Supprimer ce travail', 'btn alt sm', {}, 'Supprimer ce travail CNC ? Les programmes déjà enregistrés restent dans le dossier.')}
<a class="btn alt sm" href="/projets/${p.id}#cnc">Retour au dossier</a></div></section>`;
  res.send(layout({ title: `CNC · ${row.name}`, tab: 'projets', sub: '/projets', body, flash: req.flash }));
});

r.post('/cnc/travaux/:jid', loadJob, (req, res) => {
  const b = req.body, row = req.job;
  const n = Math.min(500, Number(b.n) || 0);
  const parts = [];
  for (let i = 0; i < n; i++) {
    if (b[`del_${i}`]) continue;
    const name = str(b[`name_${i}`]), l = num(b[`l_${i}`]), w = num(b[`w_${i}`]);
    if (!name && !l && !w) continue;
    parts.push({ name: name || `Pièce ${parts.length + 1}`, l: l || 0, w: w || 0, qty: Math.max(0, Math.round(num(b[`qty_${i}`]) ?? 1)), grain: !!b[`grain_${i}`], ops_text: String(b[`ops_${i}`] || '').replace(/\r/g, '').slice(0, 20000) });
  }
  const material = str(b.material) || row.material, thickness = num(b.thickness) || row.thickness;
  q.run("UPDATE cnc_jobs SET material = ?, thickness = ?, sheet_l = ?, sheet_w = ?, parts = ?, name = ?, updated_at = datetime('now') WHERE id = ?",
    material, thickness, num(b.sheet_l) || row.sheet_l, num(b.sheet_w) || row.sheet_w, JSON.stringify(parts), `${material} ${String(thickness).replace('.', ',')} mm`, row.id);
  res.flashTo(`/cnc/travaux/${row.id}`, 'Enregistré et recalculé.');
});

const fname = (p, row, n, ext, dry) => `${POST.ascii(p.ref)}-${POST.ascii(row.material).replace(/\s+/g, '')}${row.thickness}-P${n}${dry ? '-ESSAI' : ''}.${ext}`;
r.get('/cnc/travaux/:jid/panneau/:file', loadJob, (req, res) => {
  const m = req.params.file.match(/^(\d+)\.(nc|dxf)$/);
  if (!m) return res.status(404).send('Introuvable');
  const { job, res: R } = computeJob(req.job);
  const s = R.sheets[Number(m[1]) - 1];
  if (!s) return res.status(404).send('Introuvable');
  if (m[2] === 'dxf') {
    res.set('Content-Disposition', `attachment; filename="${fname(req.project, req.job, m[1], 'dxf')}"`).type('application/dxf');
    return res.send(POST.dxf(s, job));
  }
  if (R.errors.length) return res.status(409).send(layout({ title: 'Programme bloqué', tab: 'projets', body: h`<h1>Programme bloqué</h1><p>Il reste des points à corriger :</p><ul>${R.errors.map((e) => h`<li>${e}</li>`)}</ul><p><a class="btn" href="/cnc/travaux/${req.job.id}">Revenir</a></p>` }));
  const dry = req.query.vide === '1';
  res.set('Content-Disposition', `attachment; filename="${fname(req.project, req.job, m[1], 'nc', dry)}"`).type('text/plain');
  res.send(POST.gcode(s, { job, ref: req.project.ref, sheets: R.sheets.length, cfg: cfg(), post: post(), dry }));
});

// Valider : les programmes sont figés dans le dossier (version), la fiche du carnet est créée ou mise à jour.
r.post('/cnc/travaux/:jid/valider', loadJob, (req, res) => {
  const p = req.project, row = req.job;
  const { job, res: R } = computeJob(row);
  if (R.errors.length || !R.sheets.length) return res.flashTo(`/cnc/travaux/${row.id}`, 'Corrige d’abord les points signalés.', 'ko');
  const v = (q.get('SELECT MAX(version) v FROM cnc_programs WHERE job_id = ?', row.id).v || 0) + 1;
  tx(() => {
    q.run('UPDATE cnc_programs SET active = 0 WHERE job_id = ?', row.id);
    R.sheets.forEach((s) => {
      const file = crypto.randomBytes(12).toString('hex') + '.nc';
      fs.writeFileSync(path.join(UPLOAD_DIR, file), POST.gcode(s, { job, ref: p.ref, sheets: R.sheets.length, cfg: cfg(), post: post() }));
      q.run("INSERT INTO cnc_programs (project_id, job_id, version, sheet, kind, name, file, minutes) VALUES (?, ?, ?, ?, 'carchon', ?, ?, ?)", p.id, row.id, v, s.index + 1, fname(p, row, s.index + 1, 'nc'), file, Math.round(s.minutes * 10) / 10);
    });
    const hours = Math.max(0.5, Math.round((R.minutes / 60) * 2) / 2);
    const stepId = ensureStep(p, { stepId: row.step_id, title: `Usinage CNC · ${row.material} ${row.thickness} mm`, hours, piece: [...new Set(job.parts.map((x) => x.name))].join(', ').slice(0, 200),
      note: `${R.sheets.length} panneau${R.sheets.length > 1 ? 'x' : ''} ${row.sheet_l} × ${row.sheet_w} · programmes V${v} · ${minutesLabel(R.minutes)} machine. Faire l’essai à vide au premier passage.` });
    q.run("UPDATE cnc_jobs SET step_id = ?, validated_at = datetime('now') WHERE id = ?", stepId, row.id);
    logActivity(p.id, null, `Programmes CNC V${v} validés · ${row.name} (${R.sheets.length} panneau${R.sheets.length > 1 ? 'x' : ''}, ${minutesLabel(R.minutes)})`, 'Patron');
  });
  res.flashTo(`/cnc/travaux/${row.id}`, `Programmes V${v} enregistrés. La fiche « Usinage CNC » du carnet est à jour (${minutesLabel(R.minutes)} prévus) : pense à l’envoyer à l’atelier.`);
});

r.post('/cnc/travaux/:jid/achats', loadJob, (req, res) => {
  const p = req.project, row = req.job;
  const { res: R } = computeJob(row);
  if (!R.sheets.length) return res.redirect(`/cnc/travaux/${row.id}`);
  const waitDeposit = p.client_id && p.deposit_needed && !p.deposit_at ? 1 : 0;
  q.run("INSERT INTO needs (text, category, project_id, source, acknowledged, needs_deposit) VALUES (?, 'Matériaux', ?, 'cnc', 1, ?)", `Panneau ${row.material} ${row.thickness} mm ${row.sheet_l} × ${row.sheet_w} × ${R.sheets.length}`, p.id, waitDeposit);
  res.flashTo(`/cnc/travaux/${row.id}`, `${R.sheets.length} panneau${R.sheets.length > 1 ? 'x' : ''} ajouté${R.sheets.length > 1 ? 's' : ''} aux achats${waitDeposit ? ' (en attente de l’acompte)' : ''}.`);
});

r.post('/cnc/travaux/:jid/supprimer', loadJob, (req, res) => {
  q.run('DELETE FROM cnc_jobs WHERE id = ?', req.job.id);
  logActivity(req.project.id, null, `Travail CNC supprimé : ${req.job.name}`, 'Patron');
  res.flashTo(`/projets/${req.project.id}#cnc`, 'Travail CNC supprimé.');
});

// Étiquettes à coller sur chaque pièce en sortie de machine.
r.get('/cnc/travaux/:jid/etiquettes', loadJob, (req, res) => {
  const p = req.project, row = req.job;
  const { job, res: R } = computeJob(row);
  const labels = R.sheets.flatMap((s) => s.placements.map((pl) => ({ s: s.index + 1, part: job.parts[pl.pi], k: pl.k })));
  res.send(printPage('Étiquettes CNC', h`<p class="noprint mut">${labels.length} étiquettes · ${row.name}</p>
<div class="labels">${labels.map((x) => h`<div class="label"><b>${x.part.name}${x.part.qty > 1 ? ` ${x.k + 1}/${x.part.qty}` : ''}</b><span>${x.part.l} × ${x.part.w} × ${row.thickness}</span><span>${p.ref} · ${p.name}</span><span>Panneau ${x.s} · ${row.material}</span></div>`)}</div>`, { ref: p.ref }));
});

// ============================================================================
// Outils et réglages de la CNC
// ============================================================================
r.get('/cnc', (req, res) => {
  const c = cfg(), ps = post(), tl = q.all('SELECT * FROM cnc_tools ORDER BY active DESC, num'), feeds = q.all('SELECT * FROM cnc_feeds');
  const mats = materials();
  const ct = c.contour_tool_id;
  const body = h`<div class="eb">Machines</div><h1>CNC · outils et réglages</h1>
<p class="mut mt8 mw680">Ce que Carchon utilise pour calculer les parcours. Vérifie chaque valeur une fois : numéro de l’outil dans le changeur, diamètre réel, longueur utile.</p>
${setting('cnc_tools_checked') === '1' ? h`<p class="mt8">${pill('ok', 'Bibliothèque vérifiée')}</p>` : h`<section class="card warm mt20"><b>Bibliothèque pas encore vérifiée.</b> <span class="mut">Les valeurs de départ sont prudentes mais génériques.</span><div class="mt12">${postBtn('/cnc/verifie', 'J’ai vérifié les outils et les réglages', 'btn sm')}</div></section>`}

<section class="card mt20"><h2>Outils</h2>
<div class="tablebox mt8"><div class="cnc-toolrow cnc-toolhead"><span>N°</span><span>Outil</span><span>Type</span><span class="nr">Ø</span><span class="nr">Long. utile</span><span class="nr">Tours/min</span><span class="nr">Avance</span><span class="nr">Plongée</span><span class="nr">Passe</span><span></span></div><table class="tbl"><tbody>
${tl.map((t) => h`<tr${t.active ? '' : raw(' class="mut"')}><td colspan="10"><form method="post" action="/cnc/outils/${t.id}" class="cnc-toolrow">
<input name="num" value="${t.num}" inputmode="numeric" class="nr w4" aria-label="Numéro"><input name="name" value="${t.name}" aria-label="Nom"><select name="kind" aria-label="Type">${options([['fraise', 'Fraise'], ['foret', 'Foret / mèche']], t.kind)}</select>
<input name="diameter" value="${t.diameter}" class="nr" aria-label="Diamètre"><input name="max_depth" value="${t.max_depth}" class="nr" aria-label="Longueur utile"><input name="rpm" value="${t.rpm}" class="nr" aria-label="Tours/min"><input name="feed" value="${t.feed}" class="nr" aria-label="Avance"><input name="plunge" value="${t.plunge}" class="nr" aria-label="Plongée"><input name="pass_depth" value="${t.pass_depth}" class="nr" aria-label="Passe">
<span class="line"><button class="btn alt sm">OK</button><button class="btn alt sm" name="toggle" value="1">${t.active ? 'Retirer' : 'Remettre'}</button></span></form>
<details class="cnc-feeds"><summary class="mut t12">Par matière (${feeds.filter((f) => f.tool_id === t.id).length})</summary>
<form method="post" action="/cnc/outils/${t.id}/matieres" class="mt8"><table class="tbl dense"><thead><tr><th>Matière</th><th class="nr">Tours/min</th><th class="nr">Avance</th><th class="nr">Plongée</th><th class="nr">Passe</th></tr></thead><tbody>
${mats.map((m, i) => { const f = feeds.find((x) => x.tool_id === t.id && x.material === m); return h`<tr><td>${m}<input type="hidden" name="m_${i}" value="${m}"></td><td><input name="rpm_${i}" value="${f?.rpm ?? ''}" class="nr" placeholder="${t.rpm}"></td><td><input name="feed_${i}" value="${f?.feed ?? ''}" class="nr" placeholder="${t.feed}"></td><td><input name="plunge_${i}" value="${f?.plunge ?? ''}" class="nr" placeholder="${t.plunge}"></td><td><input name="pass_${i}" value="${f?.pass_depth ?? ''}" class="nr" placeholder="${t.pass_depth}"></td></tr>`; })}
</tbody></table><input type="hidden" name="n" value="${mats.length}"><button class="btn alt sm mt8">Enregistrer</button> <span class="mut t12">Vide = valeurs générales de l’outil.</span></form></details>
</td></tr>`)}
</tbody></table></div>
<p class="mut t12 mt8">Avance et plongée en mm/min, passe = profondeur maximale par passage en mm. Un foret ne fait que des trous de son diamètre ; une fraise fait les trous plus grands en hélice, les rainures, poches et détourages.</p>
<details class="mt12"><summary class="btn alt sm">+ Outil</summary><form method="post" action="/cnc/outils" class="form grid4 mt8">
<label>N° dans le changeur <input name="num" required inputmode="numeric"></label><label>Nom <input name="name" required></label><label>Type <select name="kind">${options([['fraise', 'Fraise'], ['foret', 'Foret / mèche']])}</select></label><label>Ø (mm) <input name="diameter" required inputmode="decimal"></label>
<label>Longueur utile (mm) <input name="max_depth" required inputmode="decimal"></label><label>Tours/min <input name="rpm" value="18000"></label><label>Avance (mm/min) <input name="feed" value="3000"></label><label>Plongée (mm/min) <input name="plunge" value="1000"></label>
<label>Passe (mm) <input name="pass_depth" value="6"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card mt20"><h2>Machine</h2>
<form method="post" action="/cnc/reglages" class="form mt8">
<div class="grid4">
<label>Course X (mm) <input name="table_x" value="${c.table_x}"></label><label>Course Y (mm) <input name="table_y" value="${c.table_y}"></label>
<label>Panneau par défaut, long. <input name="sheet_l" value="${c.sheet_l}"></label><label>Panneau par défaut, larg. <input name="sheet_w" value="${c.sheet_w}"></label>
<label>Zéro Z <select name="zero">${options([['dessus', 'Dessus du panneau'], ['martyr', 'Dessus du martyr (table)']], c.zero)}</select></label>
<label>Z de sécurité (mm) <input name="safe" value="${c.safe}"></label><label>Z de dégagement (mm) <input name="clear" value="${c.clear}"></label>
<label>Fraise de détourage <select name="contour_tool_id"><option value="">La plus grosse fraise</option>${options(tl.filter((t) => t.kind === 'fraise' && t.active).map((t) => [t.id, `T${t.num} Ø${t.diameter}`]), ct)}</select></label>
<label>Dépassement dans le martyr (mm) <input name="martyr_cut" value="${c.martyr_cut}"></label><label>Martyr : maximum autorisé (mm) <input name="martyr_max" value="${c.martyr_max}"></label>
<label>Marge au bord du panneau (mm) <input name="margin" value="${c.margin}"></label><label>Écart en plus entre pièces (mm) <input name="gap_extra" value="${c.gap_extra}"></label>
<label>Petite pièce sous (m²) <input name="small_area" value="${c.small_area}"></label><label>Peau laissée (mm) <input name="skin" value="${c.skin}"></label>
<label>Pièce étroite sous (mm) <input name="min_part" value="${c.min_part}"></label><label>Longueur de rampe (mm) <input name="ramp" value="${c.ramp}"></label>
<label>Vitesse à vide (mm/min) <input name="rapid" value="${c.rapid}"></label><label>Changement d’outil (s) <input name="tool_change_s" value="${c.tool_change_s}"></label>
<label>Chargement d’un panneau (min) <input name="load_min" value="${c.load_min}"></label><label>Essai à vide : Z remonté de (mm) <input name="dry_offset" value="${c.dry_offset}"></label>
<label>Sens de coupe <select name="climb">${options([['1', 'En avalant (compression, mélaminé)'], ['0', 'En opposition']], String(c.climb))}</select></label>
</div>
<label>Matières (une par ligne) <textarea name="materials" rows="5">${mats.join('\n')}</textarea></label>
<div class="line"><button class="btn sm">Enregistrer</button></div></form></section>

<section class="card mt20"><h2>Post-processeur</h2><p class="mut">Le début, le changement d’outil et la fin du programme. Par défaut pour Weihong NcStudio / NK105 avec changeur. Compare avec un programme qui tourne déjà sur ta machine et ajuste si besoin.</p>
<form method="post" action="/cnc/post" class="form mt8">
<label>Début <textarea name="header" rows="5" class="pre">${ps.header}</textarea></label>
<label>Changement d’outil <textarea name="toolchange" rows="5" class="pre">${ps.toolchange}</textarea></label>
<label>Fin <textarea name="footer" rows="4" class="pre">${ps.footer}</textarea></label>
<div class="grid4"><label>Parking X <input name="park_x" value="${ps.park_x}"></label><label>Parking Y <input name="park_y" value="${ps.park_y}"></label></div>
<p class="mut t12">Variables : {ref} {job} {sheet} {sheets} {material} {thickness} {zero} {safe} {tool} {toolname} {diameter} {rpm} {park_x} {park_y}.</p>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="reset" value="1">Revenir au réglage d’origine</button></div></form></section>`;
  res.send(layout({ title: 'CNC', tab: 'machines', sub: '/machines', body, flash: req.flash }));
});

const toolFields = (b) => [Math.round(num(b.num) || 0), str(b.name) || 'Outil', b.kind === 'foret' ? 'foret' : 'fraise', num(b.diameter) || 0, num(b.max_depth) || 0, Math.round(num(b.rpm) || 0), num(b.feed) || 0, num(b.plunge) || 0, num(b.pass_depth) || 0];
r.post('/cnc/outils', (req, res) => {
  const f = toolFields(req.body);
  if (!(f[0] > 0 && f[3] > 0 && f[4] > 0)) return res.flashTo('/cnc', 'Numéro, diamètre et longueur utile sont nécessaires.', 'ko');
  q.run('INSERT INTO cnc_tools (num, name, kind, diameter, max_depth, rpm, feed, plunge, pass_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...f);
  setSetting('cnc_tools_checked', '0');
  res.flashTo('/cnc', 'Outil ajouté.');
});
r.post('/cnc/outils/:id', (req, res) => {
  const t = q.get('SELECT * FROM cnc_tools WHERE id = ?', req.params.id);
  if (!t) return res.redirect('/cnc');
  if (req.body.toggle) q.run('UPDATE cnc_tools SET active = 1 - active WHERE id = ?', t.id);
  else {
    const f = toolFields(req.body);
    if (!(f[0] > 0 && f[3] > 0 && f[4] > 0 && f[6] > 0 && f[7] > 0 && f[8] > 0)) return res.flashTo('/cnc', 'Valeurs manquantes ou nulles pour cet outil.', 'ko');
    q.run('UPDATE cnc_tools SET num = ?, name = ?, kind = ?, diameter = ?, max_depth = ?, rpm = ?, feed = ?, plunge = ?, pass_depth = ? WHERE id = ?', ...f, t.id);
  }
  res.flashTo('/cnc', 'Enregistré.');
});
r.post('/cnc/outils/:id/matieres', (req, res) => {
  const t = q.get('SELECT * FROM cnc_tools WHERE id = ?', req.params.id);
  if (!t) return res.redirect('/cnc');
  const b = req.body;
  tx(() => {
    for (let i = 0; i < Math.min(50, Number(b.n) || 0); i++) {
      const m = str(b[`m_${i}`]);
      if (!m) continue;
      const vals = [num(b[`rpm_${i}`]), num(b[`feed_${i}`]), num(b[`plunge_${i}`]), num(b[`pass_${i}`])];
      if (vals.every((v) => v === null)) { q.run('DELETE FROM cnc_feeds WHERE tool_id = ? AND material = ?', t.id, m); continue; }
      q.run('INSERT INTO cnc_feeds (tool_id, material, rpm, feed, plunge, pass_depth) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tool_id, material) DO UPDATE SET rpm = excluded.rpm, feed = excluded.feed, plunge = excluded.plunge, pass_depth = excluded.pass_depth',
        t.id, m, Math.round(vals[0] || t.rpm), vals[1] || t.feed, vals[2] || t.plunge, vals[3] || t.pass_depth);
    }
  });
  res.flashTo('/cnc', `Réglages par matière enregistrés pour T${t.num}.`);
});
const CFG_NUM = ['table_x', 'table_y', 'sheet_l', 'sheet_w', 'safe', 'clear', 'martyr_cut', 'martyr_max', 'margin', 'gap_extra', 'small_area', 'skin', 'min_part', 'ramp', 'rapid', 'tool_change_s', 'load_min', 'dry_offset', 'climb'];
r.post('/cnc/reglages', (req, res) => {
  const b = req.body, c = cfg();
  for (const k of CFG_NUM) { const v = num(b[k]); if (v !== null && v >= 0) c[k] = v; }
  c.zero = b.zero === 'martyr' ? 'martyr' : 'dessus';
  c.contour_tool_id = b.contour_tool_id ? Number(b.contour_tool_id) : null;
  if (c.safe < 5) c.safe = 5;
  if (c.clear < 2) c.clear = 2;
  if (c.martyr_cut > c.martyr_max) c.martyr_cut = c.martyr_max;
  setSetting('cnc_cfg', JSON.stringify(c));
  const mats = String(b.materials || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30);
  if (mats.length) setSetting('cnc_materials', JSON.stringify(mats));
  setSetting('cnc_tools_checked', '0');
  res.flashTo('/cnc', 'Réglages enregistrés. Revérifie-les puis confirme en haut de la page.');
});
r.post('/cnc/post', (req, res) => {
  if (req.body.reset) setSetting('cnc_post', '{}');
  else setSetting('cnc_post', JSON.stringify({ header: String(req.body.header || '').replace(/\r/g, ''), toolchange: String(req.body.toolchange || '').replace(/\r/g, ''), footer: String(req.body.footer || '').replace(/\r/g, ''), park_x: num(req.body.park_x) || 0, park_y: num(req.body.park_y) || 0 }));
  setSetting('cnc_tools_checked', '0');
  res.flashTo('/cnc', 'Post-processeur enregistré.');
});
r.post('/cnc/verifie', (req, res) => { setSetting('cnc_tools_checked', '1'); res.flashTo('/cnc', 'Bibliothèque marquée comme vérifiée.'); });

module.exports = r;
module.exports.cncSection = cncSection;
module.exports.parseCutList = parseCutList;
module.exports.computeJob = computeJob;
