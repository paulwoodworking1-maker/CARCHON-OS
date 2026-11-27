'use strict';
// Catalogues fournisseurs : import (CSV ou Excel), recherche de l'article, choix du moins cher.
// Chaque besoin d'achat est rangé dans une catégorie du stock et rapproché des catalogues :
// référence exacte si le texte la contient, sinon les mots de la désignation.
const { q, tx, db, STOCK_CATS } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS supplier_catalog (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  ref TEXT NOT NULL DEFAULT '', designation TEXT NOT NULL, unit TEXT DEFAULT '', price REAL NOT NULL, pack TEXT DEFAULT '',
  category TEXT DEFAULT '', words TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS supplier_catalog_sup ON supplier_catalog(supplier_id);
CREATE INDEX IF NOT EXISTS supplier_catalog_ref ON supplier_catalog(ref);`);

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'a', 'pour', 'avec', 'x', 'mm', 'cm', 'm', 'l', 'kg', 'pce', 'pcs', 'piece', 'pieces', 'lot', 'boite', 'un', 'une']);
const words = (s) => [...new Set(plain(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w)))];

// Catégorie du stock d'après les mots de l'article.
const CAT_WORDS = {
  Quincaillerie: 'charniere charnieres vis spax coulisse coulisses poignee poignees taquet taquets equerre equerres cheville chevilles boulon ecrou rondelle aimant serrure verrou pied pieds roulette verin tourillon lamello clou clous agrafe agrafes quincaillerie',
  Droguerie: 'vernis huile cire colle teinte lasure laque peinture primaire fond durcisseur solvant diluant acetone epoxy mastic silicone droguerie finition',
  Matériaux: 'chene noyer frene hetre erable merisier bois massif panneau panneaux mdf medium contreplaque cp agglo agglomere melamine stratifie placage chant chants plateau plateaux latte osb materiaux',
  Consommables: 'abrasif abrasifs papier disque disques bande bandes fraise fraises foret forets meche meches lame lames chiffon chiffons masque cartouche gant gants scotch adhesif ruban sac sacs film carton consommables',
};
const CAT_SETS = Object.fromEntries(Object.entries(CAT_WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
const ALIAS = { 'bois massif': 'Matériaux', bois: 'Matériaux', panneaux: 'Matériaux', finition: 'Droguerie', materiaux: 'Matériaux', 'quincaillerie': 'Quincaillerie', droguerie: 'Droguerie', consommables: 'Consommables' };
function categoryOf(text, given = '') {
  if (STOCK_CATS.includes(given)) return given;
  if (ALIAS[plain(given)]) return ALIAS[plain(given)];
  const ws = words(text);
  let best = '', n = 0;
  for (const [cat, set] of Object.entries(CAT_SETS)) { const k = ws.filter((w) => set.has(w) || set.has(w.replace(/s$/, ''))).length; if (k > n) { n = k; best = cat; } }
  return best || 'Autres';
}

// Prix « 12,50 € » -> 12.5
const num = (v) => { if (typeof v === 'number') return v; const x = Number(String(v ?? '').replace(/[\s  €]/g, '').replace(',', '.')); return Number.isFinite(x) ? x : NaN; };

// Lit un catalogue : la ligne d'en-têtes est repérée toute seule (référence, désignation, prix, unité, conditionnement).
async function readRows(file, name) {
  let rows = [];
  if (/\.(xlsx|xlsm)$/i.test(name)) {
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    wb.worksheets[0].eachRow((r) => rows.push(r.values.slice(1).map((c) => (c && typeof c === 'object' ? c.result ?? c.text ?? '' : c ?? ''))));
  } else {
    const txt = require('node:fs').readFileSync(file, 'utf8').replace(/^﻿/, '');
    const sep = (txt.split('\n')[0].match(/;/g) || []).length >= (txt.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    rows = txt.split(/\r?\n/).filter((l) => l.trim()).map((l) => { const out = []; let cur = '', inq = false;
      for (const ch of l) { if (ch === '"') inq = !inq; else if (ch === sep && !inq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); });
  }
  const find = (hdr, re) => hdr.findIndex((h) => re.test(plain(h)));
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const hdr = rows[i].map((x) => String(x));
    const c = { ref: find(hdr, /^(ref|reference|code|article|sku)/), des: find(hdr, /(designation|libelle|description|produit|nom)/), price: find(hdr, /(prix|tarif|price|pu ht|p\.u)/), unit: find(hdr, /^(unite|unit|u\b)/), pack: find(hdr, /(condition|colisage|pack)/), cat: find(hdr, /(categorie|famille|rayon)/) };
    if (c.des >= 0 && c.price >= 0) {
      return rows.slice(i + 1).map((r) => ({ ref: c.ref >= 0 ? String(r[c.ref] ?? '').trim() : '', designation: String(r[c.des] ?? '').trim(), price: num(r[c.price]),
        unit: c.unit >= 0 ? String(r[c.unit] ?? '').trim() : '', pack: c.pack >= 0 ? String(r[c.pack] ?? '').trim() : '', category: c.cat >= 0 ? String(r[c.cat] ?? '').trim() : '' }))
        .filter((x) => x.designation && Number.isFinite(x.price) && x.price > 0);
    }
  }
  throw new Error('Colonnes introuvables : il faut au moins une colonne « Désignation » et une colonne « Prix ».');
}

db.exec(`CREATE TABLE IF NOT EXISTS catalog_imports (
  id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE, file TEXT, name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'en_cours', pages_done INTEGER DEFAULT 0, pages_total INTEGER DEFAULT 0, count INTEGER DEFAULT 0, error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), finished_at TEXT
);`);
function saveRows(supplierId, rows, replace) {
  tx(() => {
    if (replace) q.run('DELETE FROM supplier_catalog WHERE supplier_id = ?', supplierId);
    for (const r of rows) q.run('INSERT INTO supplier_catalog (supplier_id, ref, designation, unit, price, pack, category, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      supplierId, r.ref, r.designation, r.unit, r.price, r.pack, categoryOf(r.designation, r.category), ' ' + words(`${r.designation} ${r.ref}`).join(' ') + ' ');
  });
}
// Import d'un fichier : Excel ou CSV tout de suite ; PDF lu par l'assistant, 10 pages à la fois, en arrière-plan.
function startImport(supplierId, file, name, { replace = true } = {}) {
  const id = Number(q.run('INSERT INTO catalog_imports (supplier_id, file, name) VALUES (?, ?, ?)', supplierId, require('node:path').basename(file), name).lastInsertRowid);
  const done = (count, err) => q.run("UPDATE catalog_imports SET status = ?, count = ?, error = ?, finished_at = datetime('now') WHERE id = ?", err ? 'erreur' : 'fait', count, err || '', id);
  const run = async () => {
    try {
      if (!/\.pdf$/i.test(name)) { const rows = await readRows(file, name); saveRows(supplierId, rows, replace); return done(rows.length); }
      const ai = require('./ai');
      if (!ai.enabled()) return done(0, 'Pour lire un PDF, l’assistant doit être activé (clé ANTHROPIC_API_KEY). En attendant, importe le tarif en Excel ou CSV.');
      const buf = require('node:fs').readFileSync(file); const all = []; let from = 1, total = 10;
      while (from <= total && from <= 400) {
        const out = await ai.readCatalogPdf(buf, { from, to: from + 9 });
        total = Math.max(1, Math.round(out.pages_total || total));
        for (const a of out.articles || []) if (a.designation && a.prix_ht > 0) all.push({ ref: a.reference || '', designation: a.designation, unit: a.unite || '', price: Math.round(a.prix_ht * 100) / 100, pack: a.conditionnement || '', category: a.categorie || '' });
        from += 10;
        q.run('UPDATE catalog_imports SET pages_done = ?, pages_total = ?, count = ? WHERE id = ?', Math.min(from - 1, total), total, all.length, id);
      }
      if (!all.length) return done(0, 'Aucun article avec un prix n’a été trouvé dans ce PDF.');
      saveRows(supplierId, all, replace); return done(all.length);
    } catch (e) { return done(0, e.message); }
  };
  const p = run();
  return { id, promise: p };
}

async function importCatalog(supplierId, file, name, { replace = true } = {}) {
  const rows = await readRows(file, name);
  tx(() => {
    if (replace) q.run('DELETE FROM supplier_catalog WHERE supplier_id = ?', supplierId);
    for (const r of rows) q.run('INSERT INTO supplier_catalog (supplier_id, ref, designation, unit, price, pack, category, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      supplierId, r.ref, r.designation, r.unit, r.price, r.pack, categoryOf(r.designation, r.category), ' ' + words(`${r.designation} ${r.ref}`).join(' ') + ' ');
  });
  return rows.length;
}

// Offres pour un article, de la moins chère à la plus chère (une par fournisseur, la plus proche).
function offers(text) {
  const t = String(text || '');
  const ws = words(t);
  if (!ws.length) return [];
  // 1. Une référence citée telle quelle dans le texte.
  const byRef = q.all("SELECT c.*, s.name sname FROM supplier_catalog c JOIN suppliers s ON s.id = c.supplier_id WHERE c.ref != '' AND length(c.ref) >= 4 AND instr(lower(?), lower(c.ref)) > 0", t);
  // 2. Les mots de la désignation (au moins la moitié des mots du besoin).
  const cand = byRef.length ? byRef : q.all(`SELECT c.*, s.name sname FROM supplier_catalog c JOIN suppliers s ON s.id = c.supplier_id WHERE ${ws.map(() => 'c.words LIKE ?').join(' OR ')} LIMIT 400`, ...ws.map((w) => `% ${w} %`));
  const scored = cand.map((c) => { const cw = new Set(c.words.trim().split(' ')); const hit = ws.filter((w) => cw.has(w)).length; return { ...c, score: byRef.length ? 1 : hit / ws.length }; })
    .filter((c) => c.score >= 0.5);
  const bySup = new Map();
  for (const c of scored.sort((a, b) => b.score - a.score || a.price - b.price)) if (!bySup.has(c.supplier_id)) bySup.set(c.supplier_id, c);
  return [...bySup.values()].sort((a, b) => a.price - b.price);
}

// Besoins d'un projet, rangés par catégorie du stock, avec la meilleure offre.
function projectNeeds(projectId) {
  const needs = q.all("SELECT needs.*, suppliers.name sname FROM needs LEFT JOIN suppliers ON suppliers.id = needs.supplier_id WHERE project_id = ? AND status != 'arrived' ORDER BY id", projectId);
  const groups = {};
  for (const n of needs) {
    const cat = categoryOf(n.text, n.category);
    const off = offers(n.text);
    const qty = n.qty || 1;
    (groups[cat] = groups[cat] || []).push({ ...n, cat, offers: off, best: off[0] || null, qty, total: off[0] ? off[0].price * qty : null, saving: off.length > 1 ? (off[off.length - 1].price - off[0].price) * qty : 0 });
  }
  const order = [...STOCK_CATS, 'Autres'];
  return order.filter((c) => groups[c]).map((c) => ({ cat: c, items: groups[c], total: groups[c].reduce((a, x) => a + (x.total || 0), 0) }));
}

// Commandes de la semaine : tous les besoins prêts (acompte reçu ou sans objet), tous chantiers confondus,
// au fournisseur le moins cher des catalogues (sinon celui noté sur la ligne), regroupés en un bon par fournisseur.
function weekly() {
  const rows = q.all(`SELECT n.*, p.name pname, p.ref pref FROM needs n LEFT JOIN projects p ON p.id = n.project_id
    WHERE n.status = 'todo' AND (n.needs_deposit = 0 OR n.force = 1) ORDER BY n.created_at`);
  const sups = Object.fromEntries(q.all('SELECT * FROM suppliers').map((x) => [x.id, x]));
  const bySup = new Map(); const none = [];
  for (const n of rows) {
    const off = offers(n.text);
    const best = off[0] || null;
    const sid = best ? best.supplier_id : n.supplier_id;
    const qty = n.qty || 1;
    const line = { ...n, cat: categoryOf(n.text, n.category), best, qty, total: best ? best.price * qty : null, saving: off.length > 1 ? (off[off.length - 1].price - off[0].price) * qty : 0, moved: best && n.supplier_id && n.supplier_id !== best.supplier_id };
    if (!sid || !sups[sid]) { none.push(line); continue; }
    if (!bySup.has(sid)) bySup.set(sid, { s: sups[sid], lines: [] });
    bySup.get(sid).lines.push(line);
  }
  const groups = [...bySup.values()].map((g) => ({ ...g, total: g.lines.reduce((a, l) => a + (l.total || 0), 0), saving: g.lines.reduce((a, l) => a + l.saving, 0), projects: [...new Set(g.lines.map((l) => l.pname).filter(Boolean))] }))
    .sort((a, b) => b.total - a.total || b.lines.length - a.lines.length);
  return { groups, none, total: groups.reduce((a, g) => a + g.total, 0), saving: groups.reduce((a, g) => a + g.saving, 0), count: rows.length };
}
const lineText = (l) => `- ${l.best?.ref ? `[${l.best.ref}] ` : ''}${l.best?.designation || l.text} × ${String(l.qty).replace('.', ',')}${l.unit ? ` ${l.unit}` : l.best?.unit ? ` ${l.best.unit}` : ''}${l.pref ? ` (projet ${l.pref})` : ''}`;

const catalogs = () => q.all('SELECT s.id, s.name, COUNT(c.id) n, MAX(c.updated_at) at FROM suppliers s LEFT JOIN supplier_catalog c ON c.supplier_id = s.id GROUP BY s.id ORDER BY n DESC, s.name');

module.exports = { startImport, saveRows, weekly, lineText, importCatalog, readRows, offers, projectNeeds, categoryOf, catalogs, words };
