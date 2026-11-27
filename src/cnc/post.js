'use strict';
// Sorties : programme G-code (post-processeur réglable, par défaut Weihong NcStudio / NK105 avec changeur),
// DXF du panneau imbriqué (pour un logiciel de FAO) et aperçu SVG des parcours.

const r3 = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return (Object.is(v, -0) ? 0 : v).toFixed(3).replace(/\.?0+$/, '') || '0';
};
// Les commandes numériques lisent mal les accents dans les commentaires.
const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[()]/g, '').replace(/[^\x20-\x7E]/g, '').toUpperCase();

const POST_DEFAULT = {
  name: 'Weihong NcStudio / NK105 · changeur automatique',
  header: '(CARCHON OS - {ref} - {job} - PANNEAU {sheet}/{sheets})\n(MATIERE {material} {thickness} MM - ZERO Z {zero})\nG90 G17 G21\nG54\nG0 Z{safe}',
  toolchange: 'M05\nT{tool} M06\n(OUTIL T{tool} {toolname} D{diameter})\nM03 S{rpm}\nG0 Z{safe}',
  footer: 'G0 Z{safe}\nM05\nG0 X{park_x} Y{park_y}\nM30',
  park_x: 0,
  park_y: 0,
};

const fill = (tpl, v) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));

// sheet : résultat de engine.compute(...).sheets[i]
function gcode(sheet, { job, ref, sheets, cfg, post = POST_DEFAULT, dry = false }) {
  const T = job.thickness;
  const dz = dry ? cfg.dry_offset : 0;
  const Z = (z) => r3((cfg.zero === 'martyr' ? z + T : z) + dz);
  const base = { ref: ascii(ref), job: ascii(job.name), sheet: sheet.index + 1, sheets, material: ascii(job.material), thickness: r3(T), zero: cfg.zero === 'martyr' ? 'DESSUS DU MARTYR' : 'DESSUS DU PANNEAU', safe: Z(cfg.safe), park_x: r3(post.park_x || 0), park_y: r3(post.park_y || 0) };
  const out = [];
  if (dry) out.push(`(ESSAI A VIDE : TOUS LES Z SONT REMONTES DE ${r3(dz)} MM - LA FRAISE NE TOUCHE PAS LE PANNEAU)`);
  out.push(...fill(post.header, base).split('\n'));
  let lastF = null, lastG = null, last = null;
  for (const m of sheet.seq) {
    if (m.change) {
      const f = m.feeds || {};
      out.push(...fill(post.toolchange, { ...base, tool: m.change.num, toolname: ascii(m.change.name), diameter: r3(m.change.diameter), rpm: Math.round(f.rpm || m.change.rpm || 0) }).split('\n'));
      lastF = null; lastG = null; last = null;
      continue;
    }
    // Déplacement sans effet (même point) : on ne l'écrit pas.
    if ((m.g === 0 || m.g === 1) && last && Math.abs(last.x - m.x) < 1e-6 && Math.abs(last.y - m.y) < 1e-6 && Math.abs(last.z - m.z) < 1e-6) continue;
    last = m;
    const parts = [];
    const g = `G${m.g}`;
    parts.push(g);
    parts.push(`X${r3(m.x)}`, `Y${r3(m.y)}`, `Z${Z(m.z)}`);
    if (m.g === 2 || m.g === 3) parts.push(`I${r3(m.i)}`, `J${r3(m.j)}`);
    if (m.g !== 0 && m.f !== lastF) { parts.push(`F${Math.round(m.f)}`); lastF = m.f; }
    out.push(parts.join(' '));
    lastG = g;
  }
  out.push(...fill(post.footer, base).split('\n'));
  return out.filter((l) => l.trim() !== '').join('\r\n') + '\r\n';
}

// --- DXF R12 : géométrie des pièces et des usinages, un calque par opération ---
function dxf(sheet, job) {
  const e = [];
  const line = (L, x1, y1, x2, y2) => e.push('0', 'LINE', '8', L, '10', r3(x1), '20', r3(y1), '30', '0', '11', r3(x2), '21', r3(y2), '31', '0');
  const rect = (L, x0, y0, x1, y1) => { line(L, x0, y0, x1, y0); line(L, x1, y0, x1, y1); line(L, x1, y1, x0, y1); line(L, x0, y1, x0, y0); };
  const circle = (L, x, y, r) => e.push('0', 'CIRCLE', '8', L, '10', r3(x), '20', r3(y), '30', '0', '40', r3(r));
  const text = (L, x, y, hgt, s) => e.push('0', 'TEXT', '8', L, '10', r3(x), '20', r3(y), '30', '0', '40', r3(hgt), '1', ascii(s));
  const depth = (p) => (p === 'T' ? 'T' : r3(p).replace('.', '_'));
  rect('PANNEAU', 0, 0, job.sheet_l, job.sheet_w);
  for (const pl of sheet.placements) {
    const part = job.parts[pl.pi];
    const at = (px, py) => (pl.rot ? { x: pl.x + (part.w - py), y: pl.y + px } : { x: pl.x + px, y: pl.y + py });
    rect('DECOUPE_TRAVERSANT', pl.x, pl.y, pl.x + pl.lx, pl.y + pl.ly);
    text('ETIQUETTES', pl.x + 10, pl.y + 10, Math.min(30, pl.ly / 6), `${part.name}${part.qty > 1 ? ` ${pl.k + 1}` : ''}`);
    for (const o of part.ops || []) {
      if (o.type === 'trou') { const c = at(o.x, o.y); circle(`PERCAGE_D${r3(o.d).replace('.', '_')}_P${depth(o.p)}`, c.x, c.y, o.d / 2); }
      else if (o.type === 'rainure') {
        const horiz = Math.abs(o.y1 - o.y2) < 1e-3;
        const a = horiz ? at(Math.min(o.x1, o.x2), o.y1 - o.l / 2) : at(o.x1 - o.l / 2, Math.min(o.y1, o.y2));
        const b = horiz ? at(Math.max(o.x1, o.x2), o.y1 + o.l / 2) : at(o.x1 + o.l / 2, Math.max(o.y1, o.y2));
        rect(`RAINURE_L${r3(o.l).replace('.', '_')}_P${depth(o.p)}`, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
      } else if (o.type === 'poche') {
        const a = at(o.x, o.y), b = at(o.x + o.lo, o.y + o.la);
        rect(`POCHE_P${depth(o.p)}`, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
      }
    }
  }
  return ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...e, '0', 'ENDSEC', '0', 'EOF'].join('\r\n') + '\r\n';
}

// --- Aperçu SVG : panneau, pièces, parcours (une couleur par outil), trajets à vide en pointillés ---
const COLORS = ['#A20212', '#1F5FA8', '#2E7D4F', '#B26B00', '#6B3FA0', '#0E7C86', '#8A2B1E'];
function svg(sheet, job) {
  const W = job.sheet_l, H = job.sheet_w;
  const Y = (y) => H - y;
  const toolColor = new Map();
  // Couleur fixe par numéro d'outil : la même d'un panneau à l'autre.
  const col = (t) => { if (!toolColor.has(t.id)) toolColor.set(t.id, COLORS[(Math.abs(t.num) + COLORS.length - 1) % COLORS.length]); return toolColor.get(t.id); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const parts = sheet.placements.map((pl) => {
    const part = job.parts[pl.pi];
    const fs = Math.max(14, Math.min(42, Math.min(pl.lx, pl.ly) / 6));
    return `<rect x="${r3(pl.x)}" y="${r3(Y(pl.y + pl.ly))}" width="${r3(pl.lx)}" height="${r3(pl.ly)}" class="cnc-part"/><text x="${r3(pl.x + pl.lx / 2)}" y="${r3(Y(pl.y + pl.ly / 2))}" font-size="${r3(fs)}" class="cnc-lbl">${esc(part.name)}${part.qty > 1 ? ` ${pl.k + 1}` : ''}${pl.rot ? ' ↻' : ''}</text>`;
  }).join('');
  let p = { x: 0, y: 0 };
  const ops = sheet.ops.map((o, i) => {
    const c = col(o.tool);
    let d = `M${r3(o.start.x)} ${r3(Y(o.start.y))}`;
    const rapid = `<path d="M${r3(p.x)} ${r3(Y(p.y))}L${r3(o.start.x)} ${r3(Y(o.start.y))}" class="cnc-rapid"/>`;
    const circles = [];
    for (const m of o.moves) {
      if (m.g === 2 || m.g === 3) circles.push(`<circle cx="${r3(m.x + m.i)}" cy="${r3(Y(m.y + m.j))}" r="${r3(Math.hypot(m.i, m.j))}" fill="none" stroke="${c}"/>`);
      else d += `L${r3(m.x)} ${r3(Y(m.y))}`;
    }
    const last = o.moves[o.moves.length - 1];
    p = { x: last.x, y: last.y };
    const dot = o.kind === 'trou' && !circles.length ? `<circle cx="${r3(o.start.x)}" cy="${r3(Y(o.start.y))}" r="${r3(Math.max(3, o.tool.diameter / 2))}" fill="${c}"/>` : '';
    return `<g class="cnc-op" data-i="${i}" data-tool="${o.tool.num}">${rapid}<path d="${d}" fill="none" stroke="${c}" class="cnc-cut"/>${circles.join('')}${dot}<title>${i + 1}. ${esc(o.label)} · T${o.tool.num}</title></g>`;
  }).join('');
  const legend = [...toolColor.keys()].length;
  return { svg: `<svg viewBox="-20 -20 ${W + 40} ${H + 40}" class="cnc-svg" role="img" aria-label="Panneau ${sheet.index + 1}"><rect x="0" y="0" width="${W}" height="${H}" class="cnc-sheet"/>${parts}${ops}<circle cx="0" cy="${H}" r="12" class="cnc-origin"/></svg>`, colors: Object.fromEntries([...toolColor.entries()]), legend };
}

module.exports = { gcode, dxf, svg, POST_DEFAULT, ascii, COLORS };
