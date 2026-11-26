'use strict';
// Chaîne de production d'un OF signé : l'assistant lit le devis, les vues 3D et la nomenclature / le chiffrage,
// puis Carchon OS crée les pièces, les fiches du carnet et la matière à commander.
// Le planning place ensuite la fabrication à partir du jour où toute la matière est là.
const fs = require('node:fs');
const path = require('node:path');
const { q, tx, setting, logActivity, PHASES, GESTES } = require('./db');
const { today, addDays, parseDate, ddmm } = require('./html');
const { filePath } = require('./uploads');

const LEAD_DEFAULT = () => Number(setting('lead_days_default', '10')) || 10;
const KINDS = { modele3d: 'Modèle 3D (STEP, Rhino)', plan3d: 'Vues et plans (PDF, images)', chiffrage: 'Nomenclature et chiffrage' };

// Fichiers du projet : devis accepté + fichiers joints au devis ou déposés sur l'OF.
function filesFor(projectId) {
  const numbers = q.all('SELECT DISTINCT number FROM quotes WHERE project_id = ?', projectId).map((x) => x.number);
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? ORDER BY status = 'accepted' DESC, version DESC LIMIT 1", projectId);
  const qf = numbers.length ? q.all(`SELECT * FROM quote_files WHERE number IN (${numbers.map(() => '?').join(',')}) ORDER BY id`, ...numbers) : [];
  const docs = q.all("SELECT * FROM documents WHERE project_id = ? AND kind IN ('modele3d', 'plan3d', 'chiffrage', 'vue_auto') ORDER BY id", projectId);
  return { quote, files: [...qf.map((f) => ({ kind: f.kind, file: f.file, name: f.name })), ...docs.map((d) => ({ kind: d.kind, file: d.file, name: d.title }))] };
}

// Excel → texte CSV (l'assistant lit le texte, pas le format Excel).
async function xlsxToText(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out = [];
  wb.eachSheet((ws) => {
    out.push(`--- Feuille « ${ws.name} » ---`);
    let n = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (n++ > 400) return;
      out.push(row.values.slice(1).map((v) => {
        const x = v && typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '')) : v;
        return String(x ?? '').replace(/[;\n\r]+/g, ' ');
      }).join(' ; '));
    });
  });
  return out.join('\n').slice(0, 150000);
}

// Chaque fichier devient un bloc lisible par l'assistant.
async function toBlocks(list) {
  const blocks = [], skipped = [];
  for (const f of list) {
    const p = filePath(f.file);
    if (!fs.existsSync(p)) { skipped.push(`${f.name} (introuvable)`); continue; }
    const ext = path.extname(f.file).toLowerCase();
    const size = fs.statSync(p).size;
    const label = f.kind === 'vue_auto' ? `Vue du modèle 3D : ${f.name}` : `${KINDS[f.kind] || 'Devis'} : ${f.name || path.basename(f.file)}`;
    try {
      if (require('./model3d').is3D(f.file)) {
        const M = require('./model3d');
        blocks.push({ type: 'text', text: M.asText(f.name || path.basename(f.file), await M.analyze(p)) });
      } else if (ext === '.pdf') {
        if (size > 30 * 1024 * 1024) { skipped.push(`${f.name} (PDF trop lourd)`); continue; }
        blocks.push({ type: 'text', text: label }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') } });
      } else if (/\.(png|jpe?g|webp|gif)$/.test(ext)) {
        if (size > 5 * 1024 * 1024) { skipped.push(`${f.name} (image trop lourde : exporte-la en PDF ou en JPEG plus léger)`); continue; }
        const mt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
        blocks.push({ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: mt, data: fs.readFileSync(p).toString('base64') } });
      } else if (/\.(csv|txt|tsv)$/.test(ext)) {
        blocks.push({ type: 'text', text: `${label}\n${fs.readFileSync(p, 'utf8').slice(0, 150000)}` });
      } else if (ext === '.xlsx') {
        blocks.push({ type: 'text', text: `${label}\n${await xlsxToText(p)}` });
      } else {
        skipped.push(`${f.name || f.file} (format non lu : exporte la 3D en STEP ou .3dm, les vues en PDF, la nomenclature en CSV ou Excel)`);
      }
    } catch (e) { skipped.push(`${f.name} (illisible : ${e.message})`); }
  }
  return { blocks, skipped };
}

// Quand l'assistant ne choisit personne : celui qui fait le plus souvent ce geste, sinon un compagnon.
function whoFor(geste, people) {
  const best = geste ? q.get("SELECT who_id, COUNT(*) n FROM steps WHERE geste = ? AND who_id IS NOT NULL AND status = 'done' GROUP BY who_id ORDER BY n DESC LIMIT 1", geste) : null;
  if (best && people.some((p) => p.id === best.who_id)) return best.who_id;
  return (people.find((p) => p.role !== 'patron') || people[0] || {}).id || null;
}

const running = new Set();
// Lance la génération en arrière-plan (ne bloque pas la page du client qui vient de signer).
function start(projectId) {
  if (running.has(projectId)) return false;
  running.add(projectId);
  q.run("UPDATE projects SET prod_status = 'en_cours', prod_error = NULL WHERE id = ?", projectId);
  setImmediate(() => run(projectId).catch((e) => console.error('[chaîne]', e)).finally(() => running.delete(projectId)));
  return true;
}

async function run(projectId, { ai = require('./ai') } = {}) {
  const project = q.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) return;
  const fail = (msg) => { q.run("UPDATE projects SET prod_status = 'erreur', prod_error = ? WHERE id = ?", msg, projectId); logActivity(projectId, null, `Chaîne de production non générée : ${msg}`, 'Assistant'); };
  if (!ai.enabled()) return fail('l’assistant n’est pas activé (clé ANTHROPIC_API_KEY).');
  const { quote, files } = filesFor(projectId);
  const list = [...(quote ? [{ kind: 'devis', file: quote.pdf, name: `Devis n° ${quote.number} v${quote.version}` }] : []), ...files];
  const { blocks, skipped } = await toBlocks(list);
  if (!blocks.length) return fail('aucun document lisible (devis, vues 3D ou nomenclature).');
  const people = q.all('SELECT * FROM people WHERE active = 1 ORDER BY id');
  const auto = require('./automations');
  let out;
  try {
    out = await ai.productionChain({
      project, files: blocks, people, phases: PHASES, gestes: GESTES, averages: auto.averages(),
      suppliers: q.all('SELECT name FROM suppliers ORDER BY name').map((s) => s.name),
      machines: q.all("SELECT name FROM machines ORDER BY name").map((m) => m.name),
      stock: [...q.all("SELECT name FROM stock_items WHERE state = 0 ORDER BY name LIMIT 150").map((s) => s.name),
        ...q.all('SELECT essence, thickness, volume FROM wood_lots WHERE project_id IS NULL AND volume > 0').map((w) => `${w.essence} ${w.thickness} ${w.volume} m³ (lot libre)`)],
    });
  } catch (e) { return fail(e.message || 'erreur de l’assistant'); }
  apply(project, out, people, skipped);
}

// Écrit le résultat dans l'OF (aussi utilisé par les tests).
function apply(project, out, people, skipped = []) {
  const byName = Object.fromEntries(people.map((p) => [p.name.toLowerCase(), p.id]));
  const counts = { pieces: 0, fiches: 0, matiere: 0, reserve: 0, debit: 0 };
  tx(() => {
    const knownPieces = new Set(q.all('SELECT lower(name) n FROM pieces WHERE project_id = ?', project.id).map((x) => x.n));
    for (const pc of out.pieces || []) {
      if (!pc.nom || knownPieces.has(pc.nom.toLowerCase())) continue;
      q.run('INSERT INTO pieces (project_id, name, descr) VALUES (?, ?, ?)', project.id, pc.nom, pc.description || ''); counts.pieces++;
    }
    // Fiche de débit : remplacée à chaque génération.
    if ((out.debit || []).length) {
      q.run('DELETE FROM cut_list WHERE project_id = ?', project.id);
      (out.debit || []).forEach((d, i) => q.run('INSERT INTO cut_list (project_id, ord, ensemble, piece, qty, material, l, w, t, bl, bw, bt, grain, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        project.id, i + 1, d.ensemble || '', d.piece || '?', Number(d.quantite) || 1, d.materiau || '', d.longueur_mm || null, d.largeur_mm || null, d.epaisseur_mm || null,
        d.brut_longueur_mm || null, d.brut_largeur_mm || null, d.brut_epaisseur_mm || null, d.sens_du_fil || '', d.note || ''));
      counts.debit = out.debit.length;
    }
    let ord = q.get('SELECT COALESCE(MAX(ord), 0) m FROM steps WHERE project_id = ?', project.id).m;
    for (const f of out.fiches || []) {
      if (['Conception', 'Accord'].includes(f.etape_frise)) continue; // la conception est faite avant le chiffrage
      const phase = PHASES.includes(f.etape_frise) ? f.etape_frise : 'Assemblage';
      const geste = GESTES.includes(f.geste) ? f.geste : 'Autre';
      const who = byName[String(f.qui || '').toLowerCase()] || whoFor(geste, people);
      q.run(`INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks, ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        project.id, ++ord, f.titre, f.pieces || '', who, phase, geste, Math.max(0.5, Math.round((Number(f.heures) || 4) * 2) / 2), [f.machine ? `Machine : ${f.machine}.` : '', f.mot_du_patron || '', phase === 'Débit' && counts.debit ? 'Cotes : voir la fiche de débit.' : ''].filter(Boolean).join(' '),
        JSON.stringify((f.reperes || []).slice(0, 6).map((t) => ({ t, done: false }))));
      counts.fiches++;
    }
    const needDeposit = project.deposit_needed && !project.deposit_at ? 1 : 0;
    for (const m of out.matiere || []) {
      if (!m.designation || !(Number(m.quantite) > 0)) continue;
      // Bois : un lot libre qui suffit est réservé tout de suite.
      if (m.categorie === 'Bois massif' && m.essence) {
        const lot = q.get("SELECT * FROM wood_lots WHERE project_id IS NULL AND lower(essence) = lower(?) AND (? = '' OR thickness = ?) AND volume >= ? ORDER BY volume LIMIT 1", m.essence, m.epaisseur || '', m.epaisseur || '', Number(m.quantite));
        if (lot) { q.run('UPDATE wood_lots SET project_id = ? WHERE id = ?', project.id, lot.id); counts.reserve++; continue; }
      }
      const sup = m.fournisseur ? q.get('SELECT id FROM suppliers WHERE lower(name) = lower(?) OR lower(name) LIKE lower(?)', m.fournisseur, `%${m.fournisseur}%`) : null;
      const unit = m.unite || '';
      q.run(`INSERT INTO needs (text, category, supplier_id, project_id, source, acknowledged, needs_deposit, qty, unit, for_chain) VALUES (?, ?, ?, ?, 'chaine', 1, ?, ?, ?, ?)`,
        `${m.designation}${m.essence && !m.designation.toLowerCase().includes(m.essence.toLowerCase()) ? ` · ${m.essence}` : ''}${m.epaisseur && !m.designation.includes(m.epaisseur) ? ` ${m.epaisseur}` : ''} · ${String(Number(m.quantite)).replace('.', ',')} ${unit}`.trim(),
        m.categorie === 'Bois massif' || m.categorie === 'Panneaux' ? 'Matériaux' : m.categorie, sup ? sup.id : null, project.id, needDeposit, Number(m.quantite), unit, m.avant_fabrication ? 1 : 0);
      counts.matiere++;
    }
    const note = [out.remarques, skipped.length ? `Non lus : ${skipped.join(' ; ')}.` : ''].filter(Boolean).join(' ');
    q.run("UPDATE projects SET prod_status = 'pret', prod_error = NULL, prod_note = ?, prod_analysis = ?, prod_at = datetime('now') WHERE id = ?", note, out.analyse || '', project.id);
    logActivity(project.id, null, `Chaîne de production générée : ${counts.fiches} fiches, ${counts.debit} lignes de débit, ${counts.pieces} pièces, ${counts.matiere} achats${counts.reserve ? `, ${counts.reserve} lot(s) de bois réservé(s)` : ''}`, 'Assistant');
  });
  require('./automations').changed();
  return counts;
}

// --- Date à laquelle toute la matière nécessaire sera là ---
function addWorkdays(d, n) { let x = d, k = 0; while (k < n) { x = addDays(x, 1); const w = parseDate(x).getDay(); if (w !== 0 && w !== 6) k++; } return x; }
function material(projectId) {
  const t = today();
  const rows = q.all(`SELECT needs.*, orders.expected_at, orders.arrived_at, suppliers.lead_days, suppliers.name sname FROM needs
    LEFT JOIN orders ON orders.id = needs.order_id LEFT JOIN suppliers ON suppliers.id = needs.supplier_id
    WHERE needs.project_id = ? AND needs.for_chain = 1`, projectId);
  const items = rows.map((n) => {
    if (n.status === 'arrived' || n.arrived_at) return { ...n, when: n.arrived_at || t, how: 'reçu' };
    if (n.order_id && n.expected_at) return { ...n, when: n.expected_at < t ? t : n.expected_at, how: n.expected_at < t ? 'en retard' : 'commandé' };
    if (n.order_id) return { ...n, when: addWorkdays(t, n.lead_days || LEAD_DEFAULT()), how: 'commandé, date à confirmer' };
    return { ...n, when: addWorkdays(t, n.lead_days || LEAD_DEFAULT()), how: n.needs_deposit ? 'à commander (après l’acompte)' : 'à commander' };
  });
  const waiting = items.filter((i) => i.how !== 'reçu');
  const date = waiting.length ? waiting.reduce((m, i) => (i.when > m ? i.when : m), t) : null;
  // Une journée pour réceptionner et contrôler avant de lancer le débit.
  return { date: date ? addWorkdays(date, 1) : null, items, waiting: waiting.length, estimated: waiting.some((i) => !i.expected_at) };
}

module.exports = { start, run, apply, filesFor, toBlocks, material, addWorkdays, KINDS, running, LEAD_DEFAULT };
void ddmm;
