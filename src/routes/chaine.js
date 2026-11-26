'use strict';
// Chaîne de production d'un projet, du devis à la pose (une page, six étapes).
const express = require('express');
const { q, tx, logActivity, setSetting, company, PHASES } = require('../db');
const { h, raw, layout, pill, postBtn, options, ddmm, ddmmyyyy, dayMonth, printPage, addDays, parseDate, JOURS_C } = require('../html');
const C = require('../chaine');
const { loadProject } = require('./patron');

const r = express.Router();
const eur = (x, d = 0) => `${Number(x || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} €`;
const n1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const days = (d) => (d === 0.5 ? '½ j' : `${Math.floor(d)}${d % 1 ? ' ½' : ''} j`);
const DAY_OPTS = [['', 'à faire'], ...[0.5, 1, 1.5, 2, 2.5, 3, 4, 5].map((d) => [d, days(d)])];
const STEPS = [['devis', 'Devis'], ['plans', 'Plans'], ['debit', 'Débit'], ['commandes', 'Commandes'], ['planning', 'Planning'], ['etiquettes', 'Étiquettes']];

function ensure(p) {
  let c = C.get(p.id);
  if (!c) { C.save(p.id, C.defaults()); c = C.get(p.id); }
  return c;
}

// Vue de face cotée (SVG).
function faceView(x) {
  const p = x.p, e = x.lines[0]?.ep || 19, W = p.width * p.caissons, H = p.height;
  const s = Math.min(640 / W, 420 / H), ox = 60, oy = 30, w = W * s, hh = H * s;
  const parts = [];
  for (let i = 0; i < p.caissons; i++) {
    const x0 = ox + i * p.width * s;
    parts.push(`<rect x="${x0}" y="${oy}" width="${p.width * s}" height="${hh}" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
    parts.push(`<rect x="${x0 + e * s}" y="${oy + e * s}" width="${(p.width - 2 * e) * s}" height="${(H - 80 - 2 * e) * s}" fill="none" stroke="currentColor" stroke-width=".6"/>`);
    parts.push(`<rect x="${x0 + e * s}" y="${oy + (H - 80) * s}" width="${(p.width - 2 * e) * s}" height="${80 * s - 1}" fill="#EEEBE5" stroke="currentColor" stroke-width=".6"/>`);
    for (let k = 1; k <= p.shelves; k++) {
      const y = oy + e * s + ((H - 80 - 2 * e) * s * k) / (p.shelves + 1);
      parts.push(`<rect x="${x0 + e * s}" y="${y - (e * s) / 2}" width="${(p.width - 2 * e) * s}" height="${Math.max(1.5, e * s)}" fill="#D9D4CC" stroke="currentColor" stroke-width=".4"/>`);
    }
  }
  const cote = (x1, y1, x2, y2, t, vert) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6B635A" stroke-width=".7"/>${vert
    ? `<text x="${x1 - 8}" y="${(y1 + y2) / 2}" transform="rotate(-90 ${x1 - 8} ${(y1 + y2) / 2})" text-anchor="middle" font-size="12" fill="#6B635A">${t}</text>`
    : `<text x="${(x1 + x2) / 2}" y="${y1 - 6}" text-anchor="middle" font-size="12" fill="#6B635A">${t}</text>`}`;
  return raw(`<svg viewBox="0 0 ${w + 100} ${hh + 90}" class="chaine-svg" role="img" aria-label="Vue de face cotée">
${parts.join('')}
${cote(ox, oy - 12, ox + p.width * s, oy - 12, p.width)}${cote(ox - 22, oy, ox - 22, oy + hh, H, true)}${cote(ox, oy + hh + 30, ox + w, oy + hh + 30, W)}
<text x="${ox + w}" y="${oy + hh + 56}" text-anchor="end" font-size="10" letter-spacing="2" fill="#6B635A">VUE DE FACE · COTES EN MM</text></svg>`);
}

// Un panneau du calepinage (SVG).
function panelView(g, pn) {
  const L = g.ref.length || 2500, W = g.ref.width || 1220, s = 700 / L, m = 10 * s;
  const items = pn.items.map((it) => `<g><rect x="${m + it.x * s}" y="${m + it.y * s}" width="${it.len * s}" height="${it.wid * s}" fill="#F2EFEA" stroke="#1A1714" stroke-width=".8"/>
${it.wid * s > 14 ? `<text x="${m + (it.x + it.len / 2) * s}" y="${m + (it.y + it.wid / 2) * s + 4}" text-anchor="middle" font-size="${it.wid * s > 40 ? 12 : 9}" font-weight="700">${it.rep}</text>` : ''}
${it.wid * s > 40 ? `<text x="${m + (it.x + it.len / 2) * s}" y="${m + (it.y + it.wid / 2) * s + 17}" text-anchor="middle" font-size="8" fill="#6B635A">${it.len} × ${it.wid}</text>` : ''}</g>`).join('');
  return raw(`<svg viewBox="0 0 ${L * s + 20} ${W * s + 34}" class="chaine-svg" role="img" aria-label="Calepinage">
<rect x="0" y="0" width="${L * s + 20}" height="${W * s + 20}" fill="none" stroke="#1A1714"/>${items}
<text x="${m}" y="${W * s + 32}" font-size="9" letter-spacing="1.5" fill="#6B635A">${String(g.ref.name).toUpperCase()} ${g.ref.thickness} · ${L} × ${W} · FIL DANS LA LONGUEUR</text></svg>`);
}

// Élévation d'un ensemble dessinée par l'IA (rectangles en mm, origine en bas à gauche).
function ensembleView(e) {
  const W = Math.max(1, e.largeur || Math.max(...(e.vue || []).map((v) => v.x + v.l), 1)), H = Math.max(1, e.hauteur || Math.max(...(e.vue || []).map((v) => v.y + v.h), 1));
  const s = Math.min(520 / W, 320 / H), ox = 40, oy = 24;
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const rects = (e.vue || []).map((v) => { const x = ox + v.x * s, y = oy + (H - v.y - v.h) * s, w = v.l * s, hh = v.h * s;
    return `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="none" stroke="currentColor" stroke-width=".9"/>${w > 40 && hh > 12 && v.label ? `<text x="${x + w / 2}" y="${y + hh / 2 + 4}" text-anchor="middle" font-size="${Math.min(11, Math.max(7, hh / 3))}" fill="#6B635A">${esc(v.label).slice(0, 28)}</text>` : ''}`; }).join('');
  return raw(`<svg viewBox="0 0 ${W * s + 70} ${H * s + 64}" class="chaine-svg" role="img" aria-label="Élévation ${esc(e.nom)}">${rects}
<line x1="${ox}" y1="${oy + H * s + 18}" x2="${ox + W * s}" y2="${oy + H * s + 18}" stroke="#6B635A" stroke-width=".7"/><text x="${ox + (W * s) / 2}" y="${oy + H * s + 34}" text-anchor="middle" font-size="12" fill="#6B635A">${W}</text>
<line x1="${ox - 16}" y1="${oy}" x2="${ox - 16}" y2="${oy + H * s}" stroke="#6B635A" stroke-width=".7"/><text x="${ox - 22}" y="${oy + (H * s) / 2}" transform="rotate(-90 ${ox - 22} ${oy + (H * s) / 2})" text-anchor="middle" font-size="12" fill="#6B635A">${H}</text></svg>`);
}

// La demande du client, étudiée par l'IA : aucun modèle figé, l'étude s'adapte au projet.
function studyBlock(p, c, x, frozen) {
  const ai = require('../ai');
  const st = c.ai_status;
  const brief = c.brief || [p.descr, p.notes, p.wood && `Bois : ${p.wood}`].filter(Boolean).join('\n');
  const client = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  const qs = c.study?.questions_client || [];
  const mailQ = qs.length ? `/mail/nouveau?${new URLSearchParams({ to: client?.email || '', subject: `Votre projet · quelques précisions · ${company().name}`, back: `/projets/${p.id}/chaine#01`, project_id: String(p.id),
    body: `Bonjour,\n\nPour préparer au plus juste votre projet, pourriez-vous nous préciser :\n\n${qs.map((t) => `- ${t}`).join('\n')}\n\nMerci par avance,\n${company().name}` }).toString()}` : '';
  return h`<div class="ch-box">
${!ai.enabled() ? h`<p class="flash ko">L’assistant IA n’est pas activé (clé ANTHROPIC_API_KEY chez l’hébergeur) : en attendant, la chaîne calcule des caissons simples.</p>` : ''}
${st === 'running' ? h`<p data-reload="12"><b>L’IA étudie le projet…</b> <span class="mut">Une à cinq minutes selon la taille. La page se met à jour toute seule.</span></p>` : ''}
${st === 'error' ? h`<p class="flash ko">L’étude n’a pas abouti : ${c.ai_error || ''}</p>` : ''}
${c.study ? h`<p><b>${c.study.titre}</b> <span class="mut t12">· étude du ${ddmm(c.ai_at || c.updated_at)}</span></p><p class="mut">${c.study.resume}</p>
<div class="ch-two mt12"><div><div class="eb">Hypothèses de l’IA</div><ul class="t13">${(c.study.hypotheses || []).map((t) => h`<li>${t}</li>`)}</ul></div>
<div><div class="eb">Questions à poser au client</div><ul class="t13">${qs.map((t) => h`<li>${t}</li>`)}</ul>${qs.length ? h`<a class="btn alt sm" href="${mailQ}">Envoyer ces questions au client</a>` : h`<p class="mut t13">Aucune.</p>`}</div></div>` : ''}
${frozen ? h`<p class="mut mt8">Version figée : fais un avenant pour changer l’étude.</p>` : h`
<form method="post" action="/projets/${p.id}/chaine/etude" class="form mt12" data-busy="Envoi à l’IA…">
<label>${c.study ? 'Demande du client (tout ce que tu sais : pièces, cotes, matières, finitions, contraintes du lieu)' : 'Décris la demande du client : tout ce que tu sais (pièces, cotes, matières, finitions, contraintes du lieu). Cuisine, dressing, bureau, massif… ou tout à la fois.'}
<textarea name="brief" rows="${c.study ? 4 : 8}" required placeholder="ex. Cuisine en L 3,20 m + 2,10 m, caissons bas et hauts, façades chêne plaqué vernis mat, plan de travail en chêne massif 40 mm, îlot 180 × 90 avec 4 tiroirs ; dressing 2,40 m sous pente avec penderie et 6 tiroirs ; bureau d’angle mélaminé blanc et chêne…">${brief}</textarea></label>
${c.study ? h`<label>Ajuster l’étude (facultatif) <input name="instruction" placeholder="ex. passe les façades en laque blanche, ajoute 2 tiroirs sous l’évier, plan de travail en 2 morceaux"></label>` : ''}
<div class="line"><button class="btn"${st === 'running' || !ai.enabled() ? ' disabled' : ''}>${c.study ? 'Ajuster / refaire l’étude' : 'Étudier avec l’IA'}</button>
${c.study ? postBtn(`/projets/${p.id}/chaine/etude/oublier`, 'Revenir au calcul simple de caissons', 'linkbtn', {}, 'Oublier l’étude de l’IA ?') : ''}</div></form>`}</div>`;
}

function stepHead(num, title, tag, ia, you, youTitle = 'Vous validez') {
  return h`<div class="ch-step" id="${num}"><div class="line"><span class="eb">Étape ${num}</span><span class="ch-tag push">${tag}</span></div><h2 class="ch-h">${title}</h2>
<div class="ch-two"><div><div class="eb">L’IA prépare</div><p>${ia}</p></div><div><div class="eb">${youTitle}</div><p>${you}</p></div></div></div>`;
}
const frozenBox = (c) => (c.frozen_at ? h`<div class="ch-frozen"><span class="eb">Fabrication</span> <b>Indice ${c.indice}</b> · version figée le ${ddmmyyyy(c.frozen_at)}, fait foi pour l’atelier.</div>` : '');

r.get('/projets/:id/chaine', loadProject, (req, res) => {
  const p = req.project;
  const c = ensure(p);
  const x = C.compute(p.id, c.params, c.study);
  const P = x.p, frozen = !!c.frozen_at;
  const refs = C.refs().filter((r0) => r0.kind === 'Panneau');
  const client = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  const dis = frozen ? raw(' disabled') : '';
  const fld = (name, label, val, type = 'number', extra = '') => h`<label class="ch-f"><span>${label}</span><input type="${type}" name="${name}" value="${val}" inputmode="decimal"${dis}${raw(extra)}></label>`;
  const sel = (name, label, list, val) => h`<label class="ch-f"><span>${label}</span><select name="${name}"${dis}>${options(list, val)}</select></label>`;
  const sups = Object.fromEntries(q.all('SELECT * FROM suppliers').map((s) => [s.id, s]));
  const panelLines = x.cal.map((g) => ({ name: `${g.ref.name} ${g.ref.thickness} mm, ${g.ref.length || 2500} × ${g.ref.width || 1220}${g.refId ? '' : ' (hors stock)'}`, qty: g.panels.length, unit: g.panels.length > 1 ? 'panneaux' : 'panneau', pu: (((g.ref.length || 2500) * (g.ref.width || 1220)) / 1e6) * (g.ref.price_m2 || 0), sup: sups[g.ref.supplier_id] }));
  for (const m of x.massif) panelLines.push({ name: `${m.ref.name} · ${m.name} ${m.len} × ${m.wid} × ${m.ep} (brut +35 %)`, qty: Math.round(m.volBrut * 1000) / 1000, unit: 'm³', pu: m.ref.price_m3 || 0, sup: sups[m.ref.supplier_id] });
  if (x.edgeM) panelLines.push({ name: 'Chant assorti encollé', qty: Math.ceil((x.edgeM * 1.15) / 25) * 25, unit: 'm', pu: x.b.chant_m });
  const groups = [
    { k: 'panneaux', title: 'Négoce panneaux', lines: panelLines, delay: 'Livraison sous 3 j ouvrés', sup: panelLines[0]?.sup },
    { k: 'quinc', title: 'Quincaillerie', lines: x.hw.map((l) => ({ ...l, unit: '' })), delay: 'Livraison sous 2 j ouvrés' },
    ...(x.fin.length ? [{ k: 'fin', title: 'Finitions', lines: x.fin, delay: 'Livraison sous 1 j ouvré' }] : []),
  ];
  const mailFor = (g) => {
    const co = company();
    return { subject: `Commande ${co.name} · projet ${p.ref}`, body: `Bonjour,\n\nPouvez-vous nous confirmer la disponibilité et le délai pour la commande suivante :\n\n${g.lines.map((l) => `- ${l.qty}${l.unit ? ` ${l.unit}` : ''} ${l.name}`).join('\n')}\n\nLivraison à l'atelier${co.address ? ` (${co.address})` : ''}, du lundi au vendredi, 8 h - 17 h.\nRéférence à rappeler sur le bon de livraison : ${p.ref}.\n\nMerci par avance,\n${co.name}` };
  };
  const plan = x.plan;
  // Colonnes du planning : jours ouvrés de la première à la dernière demi-journée.
  const cols = []; for (let d = plan.start; d <= plan.rows[plan.rows.length - 1].end; d = addDays(d, 1)) if (C.isWork(d)) cols.push(d);
  const kpi = (big, sub) => h`<div class="ch-kpi"><div class="ch-big">${big}</div><div class="mut">${sub}</div></div>`;
  const frise = [
    ['Conception', `plans ${c.indice ? `indice ${c.indice}` : 'V1'}`, true], ['Accord', frozen ? `figé, indice ${c.indice}` : `prévu ${ddmm(P.accord)}`, frozen],
    ['Bois', `livré ${ddmm(plan.rows[1].end)}`, false], ...['Débit', 'Assemblage', 'Finition', 'Contrôle'].map((ph) => [ph, plan.byPhase(ph) ? ddmm(plan.byPhase(ph).start) : 'sans objet', ph === 'Débit' && !!c.consumed_at]),
    ['Livraison', ddmm(plan.poseDate), false], ['Réception', 'PV à signer', false],
  ];
  const body = h`
<div class="mut"><a href="/projets/${p.id}">‹ ${p.name}</a></div>
<nav class="ch-nav" aria-label="Étapes">${STEPS.map(([k, l], i) => h`<a href="#${String(i + 1).padStart(2, '0')}"><span>${String(i + 1).padStart(2, '0')}</span> ${l}</a>`)}</nav>
<header class="ch-top"><img class="logo ch-logo" src="/static/logo.png" alt="Carchon"><div class="push ch-ref"><div class="eb">Chaîne de production</div><div class="mut">Projet ${p.ref} · ${client ? client.name : p.for_whom || 'atelier'}</div></div></header>
<div class="ch-hero"><div class="eb mt20">Du devis à la pose</div>
<h1 class="ch-title">${p.descr || x.title || p.name}</h1>
<p class="ch-lead">Une seule saisie : la demande du client, telle qu’elle est, en haut de l’étape 01. L’IA en fait l’étude, sans modèle figé. Tout le reste en découle et se recalcule : prix, plans, débit, calepinage, commandes, quincaillerie, planning et pose. L’atelier valide.</p></div>
<div class="ch-kpis">${kpi(eur(x.ht), 'prix de vente HT')}${kpi(`${Math.round(x.marge * 100)} %`, 'marge sur prix de revient')}${kpi(x.pieces, `pièces · ${x.panelsCount} panneaux`)}${kpi(`${Math.round(x.hours)} h`, 'heures d’atelier et de pose')}${kpi(ddmm(plan.poseDate), 'pose au plus tôt')}</div>
<div class="ch-frise">${frise.map(([ph, l, d]) => h`<div class="${d ? 'd' : ''}"><b>${ph}</b><span>${l}</span></div>`)}</div>
<div class="ch-box mt20"><div class="seg2"><span class="${frozen ? '' : 'on'}">1 · Chiffrage</span><span class="${frozen ? 'on' : ''}">2 · Fabrication</span></div>
${frozen ? h`<p class="mt12"><b>Devis accepté, indice ${c.indice} figé le ${ddmmyyyy(c.frozen_at)}.</b> Débit, commandes, étiquettes, montage et pose partent de cette version. Les cotes sont verrouillées.</p>
<div class="line mt12">${postBtn(`/projets/${p.id}/chaine/avenant`, `Modifier : avenant ${String.fromCharCode((c.indice || 'A').charCodeAt(0) + 1)}`, 'btn alt', {}, 'Rouvrir le chiffrage pour un avenant ?')}${c.consumed_at ? pill('ok', `Débit fait le ${ddmm(c.consumed_at)}`) : postBtn(`/projets/${p.id}/chaine/debit`, 'Débit fait : sortir les panneaux du stock', 'btn', {}, 'Les panneaux sortent du stock et les chutes utiles entrent dans le stock de chutes. Continuer ?')}</div>`
    : h`<p class="mt12">Chiffrage en cours. Quand le client accepte le devis, fige la version : elle fait foi pour l’atelier, et les panneaux sont réservés dans le stock.</p><div class="line mt12">${postBtn(`/projets/${p.id}/chaine/figer`, `Devis accepté : figer l’indice ${c.indice ? String.fromCharCode(c.indice.charCodeAt(0) + 1) : 'A'}`, 'btn')}</div>`}</div>

${stepHead('01', 'La demande et le devis', 'Chiffrage automatique', 'Nomenclature, matière, quincaillerie, heures par poste, prix de revient et descriptif du devis, à partir de la demande du client, quelle qu’elle soit.', 'Le coefficient, le prix final et la formulation, puis l’envoi au client depuis son portail : il y signe le devis et règle l’acompte.')}
<h3 class="ch-h3">La demande du client</h3>
${studyBlock(p, c, x, frozen)}
<h3 class="ch-h3 mt20">Pose et vente</h3>
<form method="post" action="/projets/${p.id}/chaine" class="ch-grid">
${c.study ? '' : h`${fld('width', 'Largeur d’un caisson (mm)', P.width)}${fld('caissons', 'Nombre de caissons', P.caissons)}
${fld('height', 'Hauteur (mm)', P.height)}${fld('shelves', 'Étagères par caisson', P.shelves)}
${fld('depth', 'Profondeur (mm)', P.depth)}${sel('ref_id', 'Matière', refs.map((r0) => [r0.id, `${r0.name} ${r0.thickness} mm`]), P.ref_id)}
${sel('finition', 'Finition', C.FINITIONS, P.finition)}${fld('couches', 'Couches de finition', P.couches)}
${sel('back_id', 'Fonds', refs.map((r0) => [r0.id, `${r0.name} ${r0.thickness} mm`]), P.back_id)}`}
${sel('mur', 'Mur du client', C.MURS, P.mur)}${fld('km', 'Distance de l’atelier (km)', P.km)}${fld('etage', 'Étage, sans ascenseur', P.etage)}
${fld('accord', 'Accord du client prévu le', P.accord, 'date')}${fld('coef', 'Coefficient de vente', P.coef, 'text')}
${fld('start', 'Début de fabrication', P.start, 'date')}
${frozen ? '' : h`<div class="ch-f"><button class="btn">Recalculer</button></div>`}</form>
${c.study ? '' : h`<p class="mut t12 mt8">Sans étude de l’IA, la chaîne calcule un ensemble de caissons simple à partir des cotes ci-dessus.</p>`}
${x.missing.length ? h`<p class="flash ko mt12">Matière hors stock : ${[...new Set(x.missing.map((l) => l.ref.name))].join(', ')}. Ajoute la référence et son prix dans <a href="/bois">Panneaux et bois</a>, puis « Ajuster » l’étude pour qu’elle l’utilise.</p>` : ''}

<div class="line mt20"><h3 class="ch-h3 m0">Quantitatif par poste · renvoyé par la chaîne</h3><span class="ch-tag push">Quantités et heures, sans prix</span></div>
<div class="tablebox"><table class="tbl ch-tbl"><thead><tr><th>Poste</th><th>Quantités</th><th class="num">Heures</th></tr></thead><tbody>
<tr><td>Matière</td><td class="mut">${x.cal.map((g) => `${g.panels.length} × ${g.ref.name} ${g.ref.thickness}`).join(' · ')}${x.massif.length ? ` · ${x.massif.reduce((a, m) => a + m.volBrut, 0).toFixed(2).replace('.', ',')} m³ de massif` : ''} · ${Math.round(x.edgeM)} m de chant</td><td class="num">—</td></tr>
${x.postes.map((po) => h`<tr><td>${po.name}</td><td class="mut">${po.qty}</td><td class="num">${C.hh(po.h)}</td></tr>`)}
<tr><td>Quincaillerie</td><td class="mut">${x.hw.length} références · ${x.hw.reduce((a, l) => a + l.qty, 0)} articles</td><td class="num">—</td></tr>
<tr class="b"><td>Total</td><td></td><td class="num">${C.hh(x.hours)}</td></tr></tbody></table></div>

<div class="line mt20"><h3 class="ch-h3 m0">Prix de revient · calculé dans Carchon OS</h3><span class="ch-tag push">Taux, prix fournisseurs, coefficient</span></div>
<div class="tablebox"><table class="tbl ch-tbl"><thead><tr><th>Poste</th><th>Base de calcul</th><th class="num">Revient HT</th></tr></thead><tbody>
${x.cost.map((l) => h`<tr><td>${l.name}</td><td class="mut">${l.base}</td><td class="num">${eur(l.v)}</td></tr>`)}
<tr class="b"><td>Prix de revient</td><td></td><td class="num">${eur(x.revient)}</td></tr></tbody></table></div>
${x.cost.find((l) => l.k === 'panneaux' && !l.v) ? h`<p class="flash ko mt8">Le prix au m² de la matière est à 0 : renseigne-le dans <a href="/bois">Panneaux et bois</a>.</p>` : ''}

<details class="mt20"><summary class="ch-h3 linkish">▸ Barème de l’atelier (à recaler sur vos projets passés)</summary>
<form method="post" action="/projets/${p.id}/chaine/bareme" class="ch-grid mt12">${Object.entries(C.BAREME_LABELS).map(([k, l]) => h`<label class="ch-f"><span>${l}</span><input name="${k}" value="${String(x.b[k]).replace('.', ',')}" inputmode="decimal"></label>`)}
<div class="ch-f"><button class="btn alt">Enregistrer le barème</button></div></form></details>

<div class="ch-devis mt20"><div class="line"><img class="logo ch-logo" src="/static/logo.png" alt="Carchon"><div class="push" style="text-align:right"><div class="eb">Devis</div><div class="mut">n° ${p.ref.replace('P', '')} · ${ddmmyyyy(P.accord)}</div></div></div>
<p class="mt20"><b>${client ? client.name : '[Nom du client]'}</b><br><span class="mut">${client?.address || '[Adresse du chantier]'}</span></p>
<h3 class="mt12">${p.descr || x.title}</h3><p class="mut">${x.dims}</p>
${x.quote.map((l) => h`<div class="ch-ql"><div class="grow"><b>${l.name}</b><p class="mut">${l.text}</p></div><b>${eur(l.v)}</b></div>`)}
<div class="ch-total"><span class="mut">Total HT</span><div class="ch-big b">${eur(x.ht)}</div><span class="mut">TVA 20 % · ${eur(x.ttc)} TTC</span></div>
<p class="mut mt12">Acompte de 30 % à la commande, soit ${eur(x.ttc * 0.3)} TTC. Solde à la réception. Devis valable un mois. Délai indicatif : pose au plus tôt le ${JOURS_C[parseDate(plan.poseDate).getDay()].toLowerCase()}. ${ddmm(plan.poseDate)}.</p>
<div class="line mt12"><a class="btn alt sm" href="/projets/${p.id}/chaine/devis">Imprimer / PDF</a><a class="btn alt sm" href="/portails/envoyer">Envoyer le devis au client</a></div></div>

${stepHead('02', 'Plans', 'Générés depuis les cotes', 'Vue de face cotée, à partir des cotes saisies.', 'La même vue, ouverte sur l’étape en cours du carnet sur l’iPad de l’atelier.', 'Sur l’iPad de production')}
${c.study ? h`<div class="ch-panels">${(c.study.ensembles || []).map((e) => h`<figure class="ch-box"><figcaption><b>${e.nom}</b> <span class="mut t12">${e.largeur} × ${e.hauteur} × ${e.profondeur} · ${e.description}</span></figcaption>${ensembleView(e)}</figure>`)}</div>` : h`<div class="ch-box">${faceView(x)}</div>`}
<table class="tbl mt12"><tbody><tr><td class="mut">Projet</td><td class="num b">${p.ref}</td></tr><tr><td class="mut">Ensemble</td><td class="num">${x.dims}</td></tr>
<tr><td class="mut">Matière</td><td class="num">${[...new Set(x.lines.map((l) => `${l.ref.name} ${l.ref.thickness}`))].join(' · ')}</td></tr><tr><td class="mut">Finition</td><td class="num">${x.finition}${x.couches ? `, ${x.couches} couches` : ''}</td></tr><tr><td class="mut">Indice</td><td class="num">${c.indice ? `${c.indice}${frozen ? ' · fait foi' : ''}` : 'chiffrage'}</td></tr></tbody></table>

${stepHead('03', 'Nomenclature, débit et calepinage', 'Calepinage automatique', 'Les repères, le sens du fil, les chants à plaquer, le placement sur panneaux sans rotation des pièces plaquées.', 'Le calepinage et l’appairage des veinages sur les faces vues.')}
${frozenBox(c)}
<div class="tablebox mt12"><table class="tbl ch-tbl"><thead><tr><th>Repère</th><th>Ensemble</th><th>Désignation</th><th class="num">Long. (fil)</th><th class="num">Larg.</th><th class="num">Ép.</th><th class="num">Qté</th><th>Chants</th><th>Usinage CNC</th></tr></thead><tbody>
${x.lines.map((l) => h`<tr><td class="b">${l.label}</td><td class="mut">${l.ensemble}</td><td>${l.name}</td><td class="num">${l.len}</td><td class="num">${l.wid}</td><td class="num">${l.ep}</td><td class="num">${l.qty}</td><td>${l.edgesLabel}</td><td class="mut">${l.cnc}</td></tr>`)}</tbody></table></div>
${x.cal.map((g) => h`<h3 class="ch-h3 mt20">${g.ref.name} ${g.ref.thickness} mm · ${g.panels.length} panneau${g.panels.length > 1 ? 'x' : ''} · ${Math.round(g.usage * 1000) / 10} % de matière utilisée · ${n1(g.m2)} m²</h3>
${g.tooBig.length ? h`<p class="flash ko">Trop grand pour le panneau : ${g.tooBig.map((t) => t.rep).join(', ')}</p>` : ''}
<div class="ch-panels">${g.panels.map((pn, i) => h`<figure class="ch-box"><figcaption class="mut t12">Panneau ${i + 1} · ${pn.items.length} pièces${pn.offcuts.length ? ` · chutes : ${pn.offcuts.map((o) => `${o.len} × ${o.wid}`).join(', ')}` : ''}</figcaption>${panelView(g, pn)}</figure>`)}</div>`)}

${stepHead('04', 'Commandes fournisseurs et quincaillerie', 'Bons prêts', 'Les quantités, un bon de commande par fournisseur et le mail qui l’accompagne.', 'Le fournisseur, les références, puis l’envoi depuis ta boîte Gmail. La commande passe alors dans « Commandes en cours ».')}
${frozenBox(c)}
${groups.map((g) => { const tot = g.lines.reduce((a, l) => a + l.qty * l.pu, 0); const m = mailFor(g); const sup = g.sup; return h`
<div class="line mt20"><h3 class="ch-h3 m0">${g.title} · ${sup ? sup.name : '[fournisseur à choisir]'}</h3>
<span class="push line">${postBtn(`/projets/${p.id}/chaine/commande`, g.k === 'panneaux' ? 'Créer le bon de commande bois' : 'Passer en « À commander »', 'btn alt sm', { k: g.k })}
<a class="btn sm" href="/mail/nouveau?${new URLSearchParams({ to: sup?.email || '', subject: m.subject, body: m.body, back: `/projets/${p.id}/chaine#04`, project_id: String(p.id) }).toString()}">Envoyer par e-mail</a></span></div>
<div class="tablebox"><table class="tbl ch-tbl"><thead><tr><th>Référence</th><th class="num">Qté</th><th class="num">PU HT</th><th class="num">Total HT</th></tr></thead><tbody>
${g.lines.map((l) => h`<tr><td>${l.name}</td><td class="num">${l.qty}${l.unit ? ` ${l.unit}` : ''}</td><td class="num">${eur(l.pu, 2)}</td><td class="num">${eur(l.qty * l.pu, 2)}</td></tr>`)}
<tr class="b"><td>${g.delay}</td><td></td><td></td><td class="num">${eur(tot, 2)}</td></tr></tbody></table></div>`; })}

${stepHead('05', 'Planning de fabrication', 'Recalculé à chaque changement', 'Un poste terminé : « Fait », puis « Ça t’a pris combien ? » en demi-journées. Deux touches, rien d’autre.', 'Se recale tout seul sur ce temps réel : les postes suivants glissent et la date de pose se met à jour. Envoyé au carnet, il entre dans le planning de l’atelier.', 'Le planning')}
<p class="mut">Ici, la colonne « Fait en » joue le rôle de l’iPad : choisis la durée réelle d’un poste terminé.</p>
<div class="tablebox mt12"><table class="ch-gantt"><thead><tr><th class="pc">Poste</th>${cols.map((d) => h`<th>${JOURS_C[parseDate(d).getDay()].slice(0, 2).toLowerCase()}<br>${parseDate(d).getDate()}</th>`)}</tr></thead><tbody>
${plan.rows.map((r0) => h`<tr><td class="pc"><b>${r0.name}</b> <span class="mut">· prévu ${days(r0.d)}</span><div class="mut t12">${r0.who}${r0.dry ? '' : h` · fait en <form method="post" action="/projets/${p.id}/chaine/fait" class="inline"><input type="hidden" name="k" value="${r0.k}"><select name="v" data-auto class="ch-mini">${options(DAY_OPTS, r0.real ?? '')}</select></form>`}</div></td>
${cols.map((d) => { const inR = d >= r0.start && d <= r0.end; if (!inR) return h`<td></td>`; const a = d === r0.start ? r0.startHalf : 0, b2 = d === r0.end ? r0.endHalf : 1; return h`<td><span class="ch-cell ${r0.real !== undefined ? 'done' : r0.dry ? 'dry' : r0.wait ? 'wait' : ''}" style="margin-left:${a * 50}%;width:${(b2 - a + 1) * 50}%"></span></td>`; })}</tr>`)}
</tbody></table></div>
<p class="mt12"><b>${plan.nDone} poste${plan.nDone > 1 ? 's' : ''} fait${plan.nDone > 1 ? 's' : ''}${plan.nDone ? ', temps réel saisi' : ''}.</b> Pose désormais prévue le ${JOURS_C[parseDate(plan.poseDate).getDay()].toLowerCase()}. ${ddmm(plan.poseDate)}${plan.late > 0 ? ` : retard de ${days(plan.late)} sur le prévu` : plan.late < 0 ? ` : avance de ${days(-plan.late)}` : ''}.</p>
<div class="legend"><span><i class="ch-cell done"></i>fait, temps réel</span><span><i class="ch-cell"></i>prévu</span><span><i class="ch-cell dry"></i>séchage</span><span><i class="ch-cell wait"></i>attente fournisseur</span></div>
<div class="line mt12">${postBtn(`/projets/${p.id}/chaine/carnet`, c.steps_at ? 'Mettre à jour le carnet et le planning' : 'Envoyer au carnet et au planning', 'btn')}
${postBtn(`/projets/${p.id}/chaine/pose`, 'Mettre la pose dans les livraisons du projet', 'btn alt')}
${Object.keys(c.done).length ? postBtn(`/projets/${p.id}/chaine/fait`, 'Effacer les temps réels', 'btn alt', { clear: '1' }) : ''}
<span class="mut t12">${x.b.jour_h} h par jour d’atelier.</span></div>

${stepHead('06', 'Étiquettes des pièces', 'À la sortie de la machine', 'Une étiquette par pièce : repère, désignation, dimensions, chant et sens du fil, projet et panneau.', 'L’impression, puis le collage sur chaque pièce à la sortie du débit.')}
<div class="ch-labels">${x.cal.flatMap((g) => g.panels.flatMap((pn, i) => pn.items.slice(0, 6).map((it) => ({ it, i, g })))).slice(0, 6).map(({ it, i }) => h`<div class="ch-label"><div class="ch-big b">${it.rep}</div><b>${it.name}</b><div class="mut">${it.len} × ${it.wid}</div><div class="eb mt8">${p.ref} · panneau ${i + 1}</div></div>`)}</div>
<div class="line mt12"><a class="btn" href="/projets/${p.id}/chaine/etiquettes">Imprimer toutes les étiquettes (${x.pieces})</a></div>`;
  res.send(layout({ title: `Chaîne · ${p.name}`, heading: 'Chaîne de production', tab: 'projets', sub: '/projets', body, flash: req.flash }));
});

const back = (p, a = '') => `/projets/${p.id}/chaine${a}`;
r.post('/projets/:id/chaine', loadProject, (req, res) => {
  const c = ensure(req.project);
  if (c.frozen_at) return res.flashTo(back(req.project), 'Version figée : fais un avenant pour changer les cotes.', 'ko');
  C.save(req.project.id, C.cleanParams(req.body, c.params));
  res.flashTo(back(req.project, '#01'), 'Recalculé : prix, plans, débit, commandes et planning sont à jour.');
});
r.post('/projets/:id/chaine/etude', loadProject, (req, res) => {
  const c = ensure(req.project);
  if (c.frozen_at) return res.flashTo(back(req.project, '#01'), 'Version figée : fais un avenant pour changer l’étude.', 'ko');
  const brief = String(req.body.brief || '').trim();
  if (!brief) return res.flashTo(back(req.project, '#01'), 'Décris la demande du client.', 'ko');
  if (!require('../ai').enabled()) return res.flashTo(back(req.project, '#01'), 'L’assistant IA n’est pas activé (clé ANTHROPIC_API_KEY).', 'ko');
  const instruction = String(req.body.instruction || '').trim();
  const started = C.startStudy(req.project, { brief, instruction: c.study ? (instruction || 'Refais l’étude complète à partir de la demande, qui a pu changer.') : '' });
  res.flashTo(back(req.project, '#01'), started ? 'L’IA étudie le projet : la page se met à jour toute seule.' : 'Une étude est déjà en cours.');
});
r.post('/projets/:id/chaine/etude/oublier', loadProject, (req, res) => {
  q.run("UPDATE chains SET ai = NULL, ai_status = NULL WHERE project_id = ? AND frozen_at IS NULL", req.project.id);
  res.flashTo(back(req.project, '#01'), 'Étude oubliée : retour au calcul simple de caissons.');
});
r.post('/projets/:id/chaine/bareme', loadProject, (req, res) => {
  const o = {};
  for (const k of Object.keys(C.BAREME_DEF)) { const v = parseFloat(String(req.body[k] ?? '').replace(',', '.')); if (Number.isFinite(v) && v >= 0) o[k] = v; }
  setSetting('chaine_bareme', JSON.stringify(o));
  res.flashTo(back(req.project, '#01'), 'Barème enregistré pour tous les projets.');
});
r.post('/projets/:id/chaine/figer', loadProject, (req, res) => {
  const c = ensure(req.project);
  const ind = c.indice ? String.fromCharCode(c.indice.charCodeAt(0) + 1) : 'A';
  q.run("UPDATE chains SET frozen_at = datetime('now'), indice = ? WHERE project_id = ?", ind, req.project.id);
  logActivity(req.project.id, null, `Chaîne de production : indice ${ind} figé (fait foi pour l’atelier)`, 'Patron');
  res.flashTo(back(req.project), `Indice ${ind} figé. Les panneaux sont réservés dans le stock.`);
});
r.post('/projets/:id/chaine/avenant', loadProject, (req, res) => {
  q.run('UPDATE chains SET frozen_at = NULL WHERE project_id = ?', req.project.id);
  logActivity(req.project.id, null, 'Chaîne de production rouverte pour un avenant', 'Patron');
  res.flashTo(back(req.project, '#01'), 'Chiffrage rouvert : modifie les cotes puis fige le nouvel indice.');
});
r.post('/projets/:id/chaine/fait', loadProject, (req, res) => {
  const c = ensure(req.project);
  const done = req.body.clear ? {} : { ...c.done };
  if (!req.body.clear) { const v = parseFloat(req.body.v); if (Number.isFinite(v) && v > 0) done[String(req.body.k)] = v; else delete done[String(req.body.k)]; }
  q.run('UPDATE chains SET done = ? WHERE project_id = ?', JSON.stringify(done), req.project.id);
  res.redirect(back(req.project, '#05'));
});
r.post('/projets/:id/chaine/debit', loadProject, (req, res) => {
  const n = tx(() => C.consume(req.project.id));
  if (n === null) return res.redirect(back(req.project));
  logActivity(req.project.id, null, `Débit fait : panneaux sortis du stock, ${n} chute(s) gardée(s)`, 'Patron');
  res.flashTo(back(req.project), `Panneaux sortis du stock. ${n} chute(s) utile(s) ajoutée(s) au stock de chutes.`);
});

// Commandes : bon de commande bois (Matière › Panneaux et bois) ou besoins dans Achats.
r.post('/projets/:id/chaine/commande', loadProject, (req, res) => {
  const p = req.project, c = ensure(p), x = C.compute(p.id, c.params, c.study);
  const k = req.body.k;
  if (k === 'panneaux') {
    const bySup = {};
    for (const g of x.cal) if (g.refId) (bySup[g.ref.supplier_id || 0] = bySup[g.ref.supplier_id || 0] || []).push({ ref_id: g.refId, name: `${g.ref.name} ${g.ref.thickness} mm, ${g.ref.length} × ${g.ref.width}`, panels: g.panels.length, m2: Math.round(g.m2 * 100) / 100, price_m2: g.ref.price_m2 });
    let last;
    tx(() => { for (const [sid, lines] of Object.entries(bySup)) last = q.run('INSERT INTO wood_orders (supplier_id, project_id, lines) VALUES (?, ?, ?)', Number(sid) || null, p.id, JSON.stringify(lines)).lastInsertRowid; });
    logActivity(p.id, null, 'Bon de commande bois préparé depuis la chaîne de production', 'Patron');
    return res.flashTo(`/bois/commandes/${last}`, 'Bon de commande bois prêt : vérifie, puis envoie-le au fournisseur.');
  }
  const lines = k === 'fin' ? x.fin : x.hw;
  tx(() => { for (const l of lines) q.run("INSERT INTO needs (text, category, project_id, source, needs_deposit) VALUES (?, ?, ?, 'chaine', ?)", `${l.qty}${l.unit ? ` ${l.unit}` : ' ×'} ${l.name}`, k === 'fin' ? 'Droguerie' : 'Quincaillerie', p.id, p.client_id && p.deposit_needed && !p.deposit_at ? 1 : 0); });
  logActivity(p.id, null, `${lines.length} article(s) ${k === 'fin' ? 'de finition' : 'de quincaillerie'} ajouté(s) aux achats`, 'Patron');
  res.flashTo(back(p, '#04'), '', 'ok', { html: `${lines.length} article(s) dans <a href="/achats">Achats › À commander</a>.` });
});

// Le planning de la chaîne devient les fiches du carnet (et donc le planning de l'atelier).
r.post('/projets/:id/chaine/carnet', loadProject, (req, res) => {
  const p = req.project, c = ensure(p), x = C.compute(p.id, c.params, c.study);
  const lead = p.lead_id || require('../logic').patron().id;
  tx(() => {
    q.run("DELETE FROM steps WHERE project_id = ? AND note LIKE '[chaîne]%' AND status = 'todo'", p.id);
    const kept = new Set(q.all("SELECT title FROM steps WHERE project_id = ? AND note LIKE '[chaîne]%'", p.id).map((s) => s.title));
    let ord = (q.get('SELECT MAX(ord) m FROM steps WHERE project_id = ?', p.id).m || 0) + 1;
    for (const po of x.postes) {
      if (!po.h || kept.has(po.name)) continue;
      q.run('INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.id, ord++, po.name, p.descr || '', lead, PHASES.includes(po.phase) ? po.phase : '', po.geste, Math.round(po.h * 4) / 4, `[chaîne] ${po.qty}`, '[]');
    }
    q.run("UPDATE chains SET steps_at = datetime('now') WHERE project_id = ?", p.id);
  });
  logActivity(p.id, null, 'Carnet mis à jour depuis la chaîne de production', 'Patron');
  res.flashTo(`/carnets/${p.id}`, 'Fiches créées depuis la chaîne : attribue-les puis envoie le carnet. Le planning se recalcule tout seul.');
});
// La pose calculée devient une date de livraison du projet.
r.post('/projets/:id/chaine/pose', loadProject, (req, res) => {
  const p = req.project, c = ensure(p), x = C.compute(p.id, c.params, c.study);
  require('../livraisons').addTrip(p, { date: x.plan.poseDate, kind: 'Livraison et pose', hours: Math.round(x.poseHours * 10) / 10 });
  res.flashTo(`/projets/${p.id}#livraisons`, `Pose ajoutée le ${dayMonth(x.plan.poseDate)} : elle est dans le planning.`);
});

r.get('/projets/:id/chaine/devis', loadProject, (req, res) => {
  const p = req.project, c = ensure(p), x = C.compute(p.id, c.params, c.study);
  const client = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  res.send(printPage('Devis', h`<p><b>${client ? client.name : ''}</b><br>${client?.address || ''}</p>
<h2>${p.descr || x.title || p.name}</h2><p>${x.dims}</p>
<table><thead><tr><th>Désignation</th><th style="text-align:right">Montant HT</th></tr></thead><tbody>${x.quote.map((l) => h`<tr><td><b>${l.name}</b><br>${l.text}</td><td style="text-align:right">${eur(l.v)}</td></tr>`)}
<tr><td><b>Total HT</b></td><td style="text-align:right"><b>${eur(x.ht)}</b></td></tr><tr><td>TVA 20 %</td><td style="text-align:right">${eur(x.ttc - x.ht)}</td></tr><tr><td><b>Total TTC</b></td><td style="text-align:right"><b>${eur(x.ttc)}</b></td></tr></tbody></table>
<p>Acompte de 30 % à la commande, soit ${eur(x.ttc * 0.3)} TTC. Solde à la réception. Devis valable un mois. Pose au plus tôt le ${ddmmyyyy(x.plan.poseDate)}.</p>
<div class="sign"><div>Bon pour accord · date et signature</div><div></div></div>`, { ref: p.ref.replace('P', ''), date: ddmmyyyy(x.p.accord) }));
});
r.get('/projets/:id/chaine/etiquettes', loadProject, (req, res) => {
  const p = req.project, c = ensure(p), x = C.compute(p.id, c.params, c.study);
  const all = x.cal.flatMap((g) => g.panels.flatMap((pn, i) => pn.items.map((it) => ({ ...it, panel: i + 1, edges: x.lines.find((l) => it.rep.startsWith(l.rep) && /^\d+$/.test(it.rep.slice(l.rep.length)))?.edgeM }))));
  res.send(printPage('Étiquettes des pièces', h`<div class="ch-labels print">${all.map((it) => h`<div class="ch-label"><div class="ch-big b">${it.rep}</div><b>${it.name}</b><div>${it.len} × ${it.wid}</div><div>${it.edges ? 'Chant avant' : 'Sans chant'} · fil ↕ longueur</div><div class="eb mt8">${p.ref} · panneau ${it.panel}</div></div>`)}</div>`, { ref: p.ref }));
});

module.exports = r;
