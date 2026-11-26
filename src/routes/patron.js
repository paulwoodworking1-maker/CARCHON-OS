'use strict';
// Patron : Aujourd'hui, recherche, liste des projets et fiche projet.
const express = require('express');
const { q, tx, PHASES, logActivity } = require('../db');
const { icon, h, raw, layout, pill, avatar, postBtn, options, hidden, ddmm, longDate, today, addDays, rel, hoursLabel, dayMonth, hhmm } = require('../html');
const L = require('../logic');
const { upload, fileUrl, isImage } = require('../uploads');
const decideRow = (...a) => require('./decider').row(...a);
const SMS = require('../sms');

const r = express.Router();
const int = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
const str = (v) => String(v ?? '').trim();

const friseBar = (fr) => h`<div class="bar" aria-hidden="true">${fr.map((f) => h`<i class="${f.state}" title="${f.phase} · ${f.label}"></i>`)}</div>`;

function projectCard(p) {
  return h`<a class="proj" href="/projets/${p.id}">
<div class="line"><span class="ref">${p.ref}</span><b class="t16">${p.name}</b>${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}</span>
<span class="mut push">${p.due_date ? `Livraison ${ddmm(p.due_date)} · ` : ''}<b style="color:${p.slack.color}">${p.slack.text}</b></span></div>
${friseBar(p.frise)}
<div class="line"><span class="mut"><b class="ink">${p.cur.phase}</b> · ${p.next}</span><span class="push">${avatar(p.lead, 28)}</span></div></a>`;
}

// ---------- Aujourd'hui ----------
r.get('/', (req, res) => {
  const t = today();
  const projects = q.all("SELECT * FROM projects WHERE status = 'en_cours' ORDER BY due_date IS NULL, due_date").map(L.projectSummary);
  const decide = L.toDecide();
  const issues = q.all("SELECT issues.*, projects.name pname, people.name who FROM issues LEFT JOIN projects ON projects.id = issues.project_id LEFT JOIN people ON people.id = issues.person_id WHERE issues.status = 'open' ORDER BY issues.created_at DESC");
  const { weeks, rows } = require('./charge').compute();
  const tot = weeks.map((w, i) => rows.reduce((a, x) => ({ h: a.h + x.cells[i].hrs, c: a.c + x.cells[i].cap }), { h: 0, c: 0 }));
  const four = tot.slice(0, 4).reduce((a, x) => ({ h: a.h + x.h, c: a.c + x.c }), { h: 0, c: 0 });
  const worst = rows.flatMap((x) => x.cells.slice(0, 4).map((c, i) => ({ p: x.p, c, i }))).sort((a, b) => b.c.pct - a.c.pct)[0];
  const capMax = Math.max(...tot.map((x) => x.c), 1);
  const scaleMax = Math.max(capMax * 1.35, ...tot.map((x) => x.h), 1);
  const N = 16;
  const monthEnd = t.slice(0, 7) + '-31';
  const toDeliver = q.get("SELECT COUNT(*) n, COALESCE(SUM(qty), 0) pcs FROM projects WHERE status = 'en_cours' AND due_date BETWEEN ? AND ?", t, monthEnd);
  const late = projects.filter((p) => p.slack.text === 'en retard');
  const ready = q.get("SELECT COUNT(*) n, SUM(reserved_for != '') r FROM units WHERE status = 'en_stock'");
  const mach = require('../machines').all();
  const machDue = mach.flatMap((m) => [...(m.down_since ? [{ m, t: { title: 'En panne', st: { label: m.down_note || 'signalée' } }, down: true }] : []), ...m.tasks.filter((x) => x.st.late).map((x) => ({ m, t: x }))]);
  const crew = rows.map((x) => {
    const p = x.p;
    const doing = q.get(`SELECT steps.title, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE who_id = ? AND steps.status = 'doing' ORDER BY started_at DESC LIMIT 1`, p.id);
    const next = doing ? null : L.stepsFor(p.id)[0];
    return { p, line: doing ? doing.pname : next ? next.pname : 'Rien de prévu', sub: doing ? doing.title : next ? `Prochaine fiche : ${next.title}` : '', load: x.cells[0].pct };
  });
  const head = decide[0];
  const grouped = L.groupDecide(decide.slice(1));
  const shown = grouped.slice(0, 8);
  // Les OF les plus urgents d'abord : retard, puis marge la plus faible, puis échéance.
  const urg = (p) => (p.slack.text === 'en retard' ? 0 : p.slack.text === 'tendu' ? 1 : p.due_date ? 2 : 3);
  const urgent = [...projects].sort((a, b) => urg(a) - urg(b) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const ofs = urgent.slice(0, 10).map((p) => {
    const hrs = q.get('SELECT COALESCE(SUM(declared_hours), 0) d, COALESCE(SUM(est_hours), 0) e, SUM(status = \'done\') nd, COUNT(*) n FROM steps WHERE project_id = ?', p.id);
    const pctv = hrs.n ? Math.round((hrs.nd || 0) / hrs.n * 100) : 0;
    return { p, hrs, pct: pctv };
  });
  const body = h`
<section class="band" style="padding-top:0;margin-top:-8px"><h2>Ton point du matin</h2><span class="count">${decide.length}</span><span class="count">${longDate(t)} · ${decide.length} décision${decide.length > 1 ? 's' : ''} · ${issues.length} problème${issues.length > 1 ? 's' : ''} signalé${issues.length > 1 ? 's' : ''} · ${machDue.length} alerte${machDue.length > 1 ? 's' : ''} machine</span></section>
${head ? h`<section class="row f" style="padding:22px 0;border-bottom:1px solid var(--line)"><span class="kind">${pill(head.kind, head.tag)}</span><div class="grow"><b class="t16">${head.title}</b><span class="mut">${head.text}</span></div>
${head.href2 ? h`<a class="btn" href="${head.href2}">${head.cta2}</a>` : ''}${head.ack ? postBtn(`/achats/besoin/${head.ack}/valider`, 'Valider', 'btn') : h`<a class="btn" href="${head.href}">${head.cta}</a>`}</section>` : ''}
<section class="kpis">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('load', 15)}Charge</span>${worst && worst.c.pct > 100 ? pill('ko', `${worst.p.role === 'patron' ? 'Toi' : worst.p.name} ${worst.c.pct} %`) : pill('ok', 'ça passe')}</div><div class="big">${four.c ? Math.round(four.h / four.c * 100) : 0} %</div><div class="sub2">des heures disponibles, 4 semaines</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('truck', 15)}À livrer</span>${pill('no', 'ce mois')}</div><div class="big">${toDeliver.n}</div><div class="sub2">OF · ${toDeliver.pcs} pièce${toDeliver.pcs > 1 ? 's' : ''}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('cal', 15)}En retard</span>${pill(late.length ? 'ko' : 'ok', late.length ? 'prévu' : 'aucun')}</div><div class="big">${late.length}</div><div class="sub2">${late.map((p) => p.name).slice(0, 2).join(', ') || 'OF dans les temps'}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('box', 15)}Prêtes</span>${pill('wa', `${ready.r || 0} réservée${(ready.r || 0) > 1 ? 's' : ''}`)}</div><div class="big">${ready.n}</div><div class="sub2">pièces contrôlées en stock</div></div>
</section>
<div class="split">
<section style="flex:2 1 560px"><div class="line"><h2 class="h-light">Charge de l'atelier</h2><a class="btn sm push" href="/charge">12 semaines</a></div>
<div class="big">${Math.round(four.h)} h</div><div class="sub2">prévues sur 4 semaines, pour ${Math.round(four.c)} h disponibles</div>
<div role="img" aria-label="Heures prévues par semaine face à la capacité" style="display:grid;grid-template-columns:repeat(${weeks.length},minmax(0,1fr));gap:6px;margin-top:26px;align-items:end">
${tot.map((x) => { const f = Math.round(x.h / scaleMax * N), cs = Math.round(x.c / scaleMax * N); return h`<div class="segcol">${Array.from({ length: N }, (_, i) => h`<i class="${i < Math.min(f, cs) ? 'f' : i < f ? 'o' : ''}"></i>`)}</div>`; })}</div>
<div style="display:grid;grid-template-columns:repeat(${weeks.length},minmax(0,1fr));gap:6px;margin-top:10px">${weeks.map((w) => h`<div class="mut t13" style="text-align:center">${ddmm(w)}</div>`)}</div>
<div class="legend"><span><i class="c" style="background:var(--sand);min-width:14px"></i>Prévu</span><span><i class="c" style="background:var(--overload);min-width:14px"></i>Au-delà de la capacité</span><span><i class="c" style="background:var(--line2);min-width:14px"></i>Disponible</span></div>
</section>
<section style="flex:1 1 340px"><div class="line"><h2 class="h-light">L'atelier aujourd'hui</h2><span class="count push">${crew.length} personne${crew.length > 1 ? 's' : ''}</span></div>
<div class="big" style="font-size:32px">${projects.length} OF en cours</div>
${crew.map((c, i) => h`<div class="who${i ? '' : ' f'}" style="margin-top:${i ? 0 : 10}px"><span class="ini">${c.p.ini}</span><div class="grow"><b class="t15">${c.p.role === 'patron' ? 'Toi' : c.p.name} · ${c.line}</b><span class="mut t13">${c.sub}</span></div><b class="t14" style="color:${c.load > 100 ? 'var(--red)' : 'var(--ink)'}">${c.load} %</b></div>`)}
${issues.map((s) => h`<div class="who">${pill('ko', 'Signalé')}<div class="grow"><b class="t14">${s.body}</b><span class="mut t12">${s.pname || ''} · ${s.who || ''} · ${rel(s.created_at)}</span></div><a class="btn alt sm" href="/projets/${s.project_id}#probleme">Traiter</a></div>`)}
${machDue.slice(0, 3).map((x) => h`<div class="who">${pill(x.down ? 'ko' : 'wa', x.down ? 'Panne' : 'Entretien')}<div class="grow"><b class="t14">${x.m.name} : ${x.t.title}</b><span class="mut t12">${x.t.st.label}</span></div><a class="btn alt sm" href="/machines?m=${x.m.id}">Voir</a></div>`)}
</section></div>
<section class="card" id="decider"><div class="line"><h2>À décider</h2>${pill(decide.length ? 'ko' : 'ok', decide.length)}<span class="mut push">Le plus urgent en haut</span>${decide.length ? h`<a class="btn alt sm" href="/decider">Tout voir</a>` : ''}</div>
${shown.length ? shown.map((d, i) => decideRow(d, i, { back: '/' })) : h`<p class="mut">Rien n'attend ta réponse.</p>`}
${grouped.length > shown.length ? h`<div class="line mt12"><a class="btn alt sm" href="/decider">${grouped.length - shown.length} autre${grouped.length - shown.length > 1 ? 's' : ''} sujet${grouped.length - shown.length > 1 ? 's' : ''} · tout voir</a></div>` : ''}
</section>
<section class="band" style="border-bottom:0"><h2>Ordres de fabrication</h2><span class="count">${projects.length}</span><span class="count">${projects.length > ofs.length ? `les ${ofs.length} plus urgents` : 'sur-mesure, boutique, revendeurs et salons'}</span>
<span class="line push"><a class="btn" href="/projets">Voir tous les OF</a><a class="btn dark" href="/catalogue">+ Lancer un OF</a></span></section>
<div class="tablebox"><table class="tbl dense" style="min-width:960px"><thead><tr><th>OF</th><th>Pièce</th><th>Canal et étape</th><th>Responsable</th><th class="num">Heures</th><th>Avancement</th><th>Fin prévue</th></tr></thead><tbody>
${ofs.map(({ p, hrs, pct: pc }) => h`<tr><td class="ref">${p.ref}</td><td><a class="b" href="/projets/${p.id}">${p.name}</a><div class="mut t12">${p.client ? p.client.name : p.for_whom || 'atelier'}</div></td>
<td>${pill('no', p.canal)} ${pill(p.cur.state === 'p' ? 'ko' : 'wa', p.cur.phase)}</td><td>${p.lead ? h`<span class="line" style="gap:8px"><span class="ini" style="width:26px;height:26px">${p.lead.ini}</span><b class="t14">${p.lead.role === 'patron' ? 'Toi' : p.lead.name}</b></span>` : '—'}</td>
<td class="num">${String(Math.round(hrs.d)).replace('.', ',')} / ${Math.round(hrs.e)} h</td>
<td><span class="line" style="gap:10px"><span class="segbar">${Array.from({ length: 20 }, (_, i) => h`<i class="${i < Math.round(pc / 5) ? (p.slack.text === 'en retard' ? 'o' : 'f') : ''}"></i>`)}</span><span class="t14">${pc} %</span></span></td>
<td class="b" style="color:${p.slack.text === 'en retard' ? 'var(--red)' : 'var(--ink)'}">${p.due_date ? ddmm(p.due_date) : 'à fixer'}<div class="t12" style="font-weight:400;color:${p.slack.color}">${p.slack.text}</div></td></tr>`)}
${ofs.length ? '' : h`<tr><td colspan="7" class="mut">Aucun OF en cours. Lance un lot depuis le catalogue, ou crée un OF sur-mesure.</td></tr>`}</tbody></table></div>`;
  res.send(layout({ title: 'Tableau de bord', tab: 'aujourdhui', sub: '/', body, flash: req.flash }));
});

// ---------- Recherche ----------
r.get('/recherche', (req, res) => {
  const s = str(req.query.q);
  const like = `%${s}%`;
  const projects = s ? q.all('SELECT projects.*, clients.name cname FROM projects LEFT JOIN clients ON clients.id = projects.client_id WHERE projects.name LIKE ? OR clients.name LIKE ? OR projects.notes LIKE ? LIMIT 30', like, like, like) : [];
  const steps = s ? q.all('SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.title LIKE ? OR steps.note LIKE ? LIMIT 30', like, like) : [];
  const stock = s ? q.all('SELECT * FROM stock_items WHERE name LIKE ? LIMIT 20', like) : [];
  const sup = s ? q.all('SELECT * FROM suppliers WHERE name LIKE ? OR note LIKE ? LIMIT 20', like, like) : [];
  const body = h`<h1>Rechercher</h1>
<form class="line mt12" method="get"><label class="sr" for="q2">Recherche</label><input id="q2" class="qin" name="q" value="${s}" autofocus><button class="btn">Chercher</button></form>
${s ? h`<div class="stack12 mt20">
<section class="card"><h2>Projets</h2>${projects.map((p) => h`<div class="row"><a class="grow b" href="/projets/${p.id}">${p.name}</a><span class="mut">${p.cname || ''}</span></div>`)}${projects.length ? '' : h`<p class="mut">Aucun.</p>`}</section>
<section class="card"><h2>Fiches de fabrication</h2>${steps.map((x) => h`<div class="row"><a class="grow b" href="/carnets/${x.project_id}?fiche=${x.id}">${x.title}</a><span class="mut">${x.pname}</span></div>`)}${steps.length ? '' : h`<p class="mut">Aucune.</p>`}</section>
<section class="card"><h2>Stock et fournisseurs</h2>${stock.map((x) => h`<div class="row"><a class="grow" href="/stock">${x.name}</a><span class="mut">${x.category}</span></div>`)}${sup.map((x) => h`<div class="row"><a class="grow" href="/fournisseurs">${x.name}</a><span class="mut">${x.note}</span></div>`)}${stock.length + sup.length ? '' : h`<p class="mut">Rien.</p>`}</section>
</div>` : ''}`;
  res.send(layout({ title: 'Rechercher', tab: '', body }));
});

// ---------- Projets ----------
const CELL = { d: 'd', c: 'cc', p: 'p', w: 'w', n: 'n' };
r.get('/projets', (req, res) => {
  const done = req.query.vue === 'termines';
  const frise = req.query.vue === 'frise';
  const t = today(), week = addDays(t, 7), monthEnd = t.slice(0, 7) + '-31';
  const all = q.all(`SELECT * FROM projects WHERE status = ? ORDER BY ${done ? 'finished_at DESC' : 'due_date IS NULL, due_date'}`, done ? 'termine' : 'en_cours').map(L.projectSummary);
  // Avancement de tous les OF en une seule requête.
  const prog = Object.fromEntries(q.all("SELECT project_id, COUNT(*) n, SUM(status = 'done') d, SUM(sent = 0 OR changed = 1) unsent FROM steps GROUP BY project_id").map((x) => [x.project_id, x]));
  const FILTERS = {
    all: ['Tous', () => true],
    retard: ['En retard', (p) => p.slack.text === 'en retard'],
    tendu: ['Tendus', (p) => p.slack.text === 'tendu'],
    semaine: ['À livrer sous 7 j', (p) => p.due_date && p.due_date <= week],
    livrer: ['Ce mois', (p) => p.due_date && p.due_date <= monthEnd],
    bloque: ['À débloquer', (p) => p.frise.some((f) => f.state === 'p')],
    acompte: ['Acompte attendu', (p) => p.client_id && p.deposit_needed && !p.deposit_at],
    envoyer: ['Carnet à envoyer', (p) => (prog[p.id] || {}).unsent > 0],
    sansdate: ['Sans échéance', (p) => !p.due_date],
  };
  const f = done ? 'all' : (FILTERS[req.query.f] ? req.query.f : 'all');
  const canal = String(req.query.canal || '');
  const resp = String(req.query.resp || '');
  const rows = all.filter(FILTERS[f][1]).filter((p) => !canal || p.canal === canal).filter((p) => !resp || String(p.lead_id) === resp);
  const qs = (o) => { const x = { f, canal, resp, vue: req.query.vue || '', ...o }; return '/projets?' + Object.entries(x).filter(([, v]) => v && v !== 'all').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); };
  const here = qs({});
  const ppl = L.people();
  const body = h`
<div class="head"><div><div class="eb">Fabriquer</div><h1>${done ? 'OF terminés' : 'Ordres de fabrication'}</h1></div>
<span class="line push"><a class="btn alt" href="/catalogue">Lancer depuis le catalogue</a><a class="btn" href="/projets/nouveau">+ OF sur-mesure</a></span></div>
${done ? '' : h`<div class="chips mt12" role="group" aria-label="Filtrer">${Object.entries(FILTERS).map(([k, [l, fn]]) => { const n = all.filter(fn).length; return k !== 'all' && !n ? '' : h`<a class="chip${f === k ? ' on' : ''}${k === 'retard' && n ? ' hot' : ''}" href="${qs({ f: k })}">${l} · ${n}</a>`; })}</div>`}
<div class="line mt12 tools">
<label class="sr" for="flt">Filtrer la liste</label><input id="flt" class="qin" type="search" placeholder="Filtrer : nom, client, réf…  (touche /)" data-filter="#oftable" autocomplete="off">
<form method="get" action="/projets" class="line">${done ? h`<input type="hidden" name="vue" value="termines">` : h`<input type="hidden" name="f" value="${f === 'all' ? '' : f}">`}${frise ? h`<input type="hidden" name="vue" value="frise">` : ''}
<label class="sr" for="fresp">Responsable</label><select id="fresp" name="resp" data-auto><option value="">Tous les responsables</option>${options(ppl.map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]), resp)}</select>
<label class="sr" for="fcanal">Canal</label><select id="fcanal" name="canal" data-auto><option value="">Tous les canaux</option>${options([...new Set(all.map((p) => p.canal).filter(Boolean))], canal)}</select></form>
${done ? '' : h`<span class="push seg"><a class="chip${frise ? '' : ' on'}" href="${qs({ vue: '' })}">Liste</a><a class="chip${frise ? ' on' : ''}" href="${qs({ vue: 'frise' })}">Frise</a></span>`}
</div>
${done ? '' : h`<form method="post" action="/projets/lot" id="lot" class="lotbar" data-lot hidden>
<input type="hidden" name="back" value="${here}"><b data-lot-count>0 sélectionné</b>
<span class="line"><label class="sr" for="ldays">Décaler de</label><select id="ldays" name="days">${options([[7, '+ 1 semaine'], [14, '+ 2 semaines'], [3, '+ 3 jours'], [-7, '− 1 semaine']], 7)}</select><button class="btn alt sm" name="act" value="decaler">Décaler l'échéance</button></span>
<span class="line"><label class="sr" for="llead">Responsable</label><select id="llead" name="lead_id">${options(ppl.map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select><button class="btn alt sm" name="act" value="resp">Attribuer</button></span>
<button class="btn alt sm" name="act" value="envoyer">Envoyer les carnets</button>
<button class="btn alt sm" name="act" value="acompte">Acompte reçu aujourd'hui</button>
<button class="btn alt sm" name="act" value="terminer" data-confirm-btn="Marquer ces OF comme terminés ?">Terminer</button>
<button type="button" class="btn ghost sm push" data-lot-clear>Désélectionner</button></form>`}
${frise ? h`<div class="tablebox mt12"><table class="frise" id="oftable">
<thead><tr><th class="pcol">OF · prochaine action</th>${PHASES.map((p) => h`<th>${p}</th>`)}<th>Échéance</th></tr></thead>
<tbody>${rows.map((p) => h`<tr data-q="${[p.ref, p.name, p.client ? p.client.name : '', p.for_whom].join(' ').toLowerCase()}"><td class="pcol"><span class="ref">${p.ref}</span> <a href="/projets/${p.id}" class="b">${p.name}</a><div class="mut">${p.client ? p.client.name : p.for_whom || 'atelier'} → ${p.next}</div></td>
${p.frise.map((c) => h`<td><span class="c ${CELL[c.state]}">${c.label}</span></td>`)}
<td class="due"><b>${p.due_date ? ddmm(p.due_date) : 'à fixer'}</b><div style="color:${p.slack.color}" class="t12 b">${p.slack.text}</div></td></tr>`)}</tbody></table></div>
<div class="legend"><span><i class="c d"></i>Fait</span><span><i class="c cc"></i>En cours</span><span><i class="c p"></i>Bloque · à traiter</span><span><i class="c w"></i>À venir</span><span><i class="c n"></i>Sans objet</span></div>`
  : h`<div class="tablebox mt12"><table class="tbl dense" id="oftable">
<thead><tr>${done ? '' : h`<th class="ck"><input type="checkbox" data-lot-all aria-label="Tout sélectionner"></th>`}<th data-sort>Réf.</th><th data-sort>OF</th><th data-sort>Canal</th><th data-sort>Étape</th><th data-sort class="num">Avancement</th><th data-sort>Resp.</th><th data-sort>Échéance</th><th data-sort>Marge</th></tr></thead>
<tbody>${rows.map((p) => { const g = prog[p.id] || { n: 0, d: 0 }; const pc = g.n ? Math.round(g.d / g.n * 100) : 0; const urgv = p.slack.text === 'en retard' ? -1000 : p.slack.text === 'tendu' ? -500 : parseInt(p.slack.text, 10) || 9999;
    return h`<tr data-q="${[p.ref, p.name, p.client ? p.client.name : '', p.for_whom, p.canal, p.cur.phase].join(' ').toLowerCase()}">
${done ? '' : h`<td class="ck"><input type="checkbox" name="ids" value="${p.id}" form="lot" aria-label="Sélectionner ${p.name}"></td>`}
<td class="ref" data-v="${p.ref}">${p.ref}</td>
<td class="ofname" data-v="${p.name}"><a class="b" href="/projets/${p.id}">${p.name}</a> <span class="mut">${p.client ? p.client.name : p.for_whom || ''}</span>${(g.unsent || 0) > 0 && !done ? h` <span class="dot-wa" title="Carnet à envoyer à l’atelier">à envoyer</span>` : ''}</td>
<td data-v="${p.canal}">${p.canal}</td>
<td data-v="${PHASES.indexOf(p.cur.phase)}">${pill(p.cur.state === 'p' ? 'ko' : 'no', p.cur.phase)}</td>
<td class="num" data-v="${pc}"><span class="mini"><i style="width:${pc}%"></i></span> ${pc} %</td>
<td data-v="${p.lead ? p.lead.name : ''}">${p.lead ? h`<span class="ini sm" title="${p.lead.role === 'patron' ? 'Toi' : p.lead.name}">${p.lead.ini}</span>` : '—'}</td>
<td data-v="${p.due_date || '9999'}" class="b">${p.due_date ? ddmm(p.due_date) : 'à fixer'}</td>
<td data-v="${done ? p.finished_at || '' : urgv}" class="t13 b" style="color:${p.slack.color}">${done ? (p.finished_at ? `terminé ${ddmm(p.finished_at)}` : '') : p.slack.text}</td></tr>`; })}
${rows.length ? '' : h`<tr><td colspan="9" class="mut">Aucun OF dans ce filtre.</td></tr>`}</tbody></table></div>
<p class="mut mt8" data-filter-count>${rows.length} OF affiché${rows.length > 1 ? 's' : ''}. Clique sur un titre de colonne pour trier. Coche plusieurs OF pour agir sur tous d'un coup.</p>`}`;
  res.send(layout({ title: done ? 'OF terminés' : 'Ordres de fabrication', tab: 'projets', sub: done ? '/projets?vue=termines' : '/projets', body, flash: req.flash }));
});

// Actions sur plusieurs OF d'un coup.
r.post('/projets/lot', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const back = String(req.body.back || '/projets').startsWith('/projets') ? String(req.body.back) : '/projets';
  if (!ids.length) return res.flashTo(back, 'Coche au moins un OF.', 'ko');
  const list = ids.map((id) => q.get('SELECT * FROM projects WHERE id = ?', id)).filter(Boolean);
  const act = req.body.act;
  let msg = '';
  tx(() => {
    for (const p of list) {
      if (act === 'decaler') {
        const days = Math.max(-60, Math.min(120, Number(req.body.days) || 7));
        if (!p.due_date) continue;
        const nd = addDays(p.due_date, days);
        q.run('UPDATE projects SET due_date = ? WHERE id = ?', nd, p.id);
        logActivity(p.id, null, `Date de livraison : ${ddmm(nd)} (au lieu du ${ddmm(p.due_date)})`, 'Patron');
        msg = `Échéance décalée de ${days} jour${Math.abs(days) > 1 ? 's' : ''}.`;
      } else if (act === 'resp') {
        const lead = int(req.body.lead_id);
        q.run('UPDATE projects SET lead_id = ? WHERE id = ?', lead, p.id);
        logActivity(p.id, null, `Responsable : ${L.personName(q.get('SELECT * FROM people WHERE id = ?', lead))}`, 'Patron');
        msg = 'Responsable attribué.';
      } else if (act === 'envoyer') {
        const n = q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ? AND (sent = 0 OR changed = 1)', p.id).n;
        if (!n) continue;
        q.run('UPDATE steps SET sent = 1, changed = 0 WHERE project_id = ? AND (sent = 0 OR changed = 1)', p.id);
        q.run("UPDATE projects SET sent_to_atelier_at = datetime('now') WHERE id = ?", p.id);
        logActivity(p.id, null, `Carnet envoyé à l’atelier (${n} fiche${n > 1 ? 's' : ''})`, 'Patron');
        msg = 'Carnets envoyés à l’atelier.';
      } else if (act === 'acompte') {
        if (!p.client_id || p.deposit_at) continue;
        q.run("UPDATE projects SET deposit_at = date('now', 'localtime') WHERE id = ?", p.id);
        q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
        logActivity(p.id, null, `Acompte reçu le ${ddmm(today())}`, 'Patron');
        SMS.notify('acompte', { projectId: p.id });
        msg = 'Acomptes notés. Les achats bloqués sont débloqués.';
      } else if (act === 'terminer') {
        q.run("UPDATE projects SET status = 'termine', finished_at = datetime('now') WHERE id = ?", p.id);
        logActivity(p.id, null, 'Projet terminé', 'Patron');
        msg = 'OF terminés.';
      }
    }
  });
  res.flashTo(back, msg ? `${msg} (${list.length} OF)` : 'Rien à changer sur ces OF.', msg ? 'ok' : 'ko');
});

r.get('/projets/nouveau', (req, res) => {
  const body = h`<div class="eb"><a href="/projets">Projets</a></div><h1>Nouveau projet</h1>
<form method="post" action="/projets/nouveau" class="card form mt20" style="max-width:640px">
<label>Nom du projet <input name="name" required placeholder="ex. Maggio, Série de tabourets…"></label>
<p class="mut">Pour une pièce du catalogue, lance plutôt un lot depuis le <a href="/catalogue">catalogue</a> : nomenclature, carnet et numéros sont repris.</p>
<div class="grid2"><label>Canal <select name="canal">${options(['Sur-mesure', 'Boutique', 'Revendeur', 'Salon', 'Stock'], 'Sur-mesure')}</select></label>
<label>Type <select name="kind">${options(['Particulier', 'Architecte', 'Professionnel', 'Atelier', 'Reprise'], 'Particulier')}</select></label></div>
<label>Pour (client, revendeur, salon…) <input name="for_whom"></label>
<label>Client existant (facultatif) <select name="client_id"><option value="">—</option>${options(q.all('SELECT id, name FROM clients ORDER BY name').map((c) => [c.id, c.name]))}</select></label>
<div class="grid2"><label>Ou nouveau client : nom <input name="client_name" placeholder="ex. M. et Mme Martin"></label><label>Son e-mail <input type="email" name="client_email"></label></div>
<label>Son portable (SMS de suivi, facultatif) <input type="tel" name="client_phone" placeholder="06 12 34 56 78"></label>
<label>Échéance <input type="date" name="due_date"></label>
<label>Responsable <select name="lead_id">${options(L.people().map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select></label>
<button class="btn">Créer le projet</button></form>`;
  res.send(layout({ title: 'Nouveau projet', tab: 'projets', sub: '/projets', body }));
});
// Client choisi, ou créé à la volée (nom + e-mail).
function clientFrom(b) {
  if (str(b.client_name)) {
    const ex = str(b.client_email) ? q.get('SELECT id FROM clients WHERE lower(email) = lower(?)', str(b.client_email)) : null;
    return ex ? ex.id : Number(q.run('INSERT INTO clients (name, email, phone, kind) VALUES (?, ?, ?, ?)', str(b.client_name), str(b.client_email), str(b.client_phone), str(b.kind) || 'Particulier').lastInsertRowid);
  }
  return int(b.client_id);
}
r.post('/projets/nouveau', (req, res) => {
  const b = { ...req.body, client_id: clientFrom(req.body) };
  const id = q.run('INSERT INTO projects (name, kind, canal, for_whom, client_id, due_date, lead_id, deposit_needed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    str(b.name), str(b.kind), str(b.canal) || 'Sur-mesure', str(b.for_whom), int(b.client_id), str(b.due_date) || null, int(b.lead_id), b.client_id ? 1 : 0).lastInsertRowid;
  logActivity(Number(id), null, 'Projet créé', 'Patron');
  res.flashTo(`/projets/${id}`, 'Projet créé. Prépare son carnet de fabrication quand tu es prêt.');
});

// ---------- Chaîne de production (devis + 3D + chiffrage → carnet, matière, planning) ----------
function chainCard(p) {
  const C = require('../chain');
  const { files } = C.filesFor(p.id);
  const m = C.material(p.id);
  const nSteps = q.get('SELECT COUNT(*) n, SUM(sent = 0) unsent FROM steps WHERE project_id = ?', p.id);
  const ai = require('../ai').enabled();
  const st = p.prod_status;
  if (!st && !files.length && !m.items.length && nSteps.n) return '';
  return h`<section class="card mt20" id="chaine"><div class="line"><h2>Chaîne de production</h2>
${pill(st === 'pret' ? 'ok' : st === 'erreur' ? 'ko' : st === 'en_cours' ? 'wa' : 'no', st === 'pret' ? `Générée ${rel(p.prod_at)}` : st === 'erreur' ? 'Non générée' : st === 'en_cours' ? 'L’assistant prépare…' : 'Pas encore générée')}
<span class="push line">${st === 'pret' && nSteps.unsent ? h`<a class="btn sm" href="/carnets/${p.id}">Vérifier et envoyer le carnet (${nSteps.unsent} fiches)</a>` : ''}
${ai && st !== 'en_cours' ? postBtn(`/projets/${p.id}/chaine`, st === 'pret' ? 'Regénérer' : 'Générer avec l’assistant', st === 'pret' ? 'btn ghost sm' : 'btn sm', {}, st === 'pret' ? 'Regénérer ajoute de nouvelles fiches et de nouveaux achats à côté des existants. Continuer ?' : '') : ''}</span></div>
${st === 'en_cours' ? h`<p class="mut mt8">L’assistant lit le devis, les vues 3D et le chiffrage : compte une à trois minutes. Recharge la page.</p>` : ''}
${st === 'erreur' ? h`<p class="flash ko mt8">${p.prod_error}</p>` : ''}
${p.prod_note ? h`<p class="mt8"><span class="mut">Remarques de l’assistant :</span> ${p.prod_note}</p>` : ''}
${!ai ? h`<p class="mut mt8">L’assistant n’est pas activé (clé ANTHROPIC_API_KEY) : la chaîne ne peut pas être générée automatiquement.</p>` : ''}
<div class="h3 mt12">Fichiers lus par l’assistant</div>
${files.length ? h`<div class="mt4">${files.map((f) => h`<div class="who"><span class="grow">${f.name || f.file}</span><span class="mut t12">${require('../chain').KINDS[f.kind] || ''}</span><a class="btn ghost sm" href="${fileUrl(f.file)}" target="_blank">Ouvrir</a></div>`)}</div>` : h`<p class="mut">Devis seul. Ajoute les vues 3D (PDF, images) et la nomenclature ou le chiffrage (CSV, Excel, PDF) pour une chaîne précise.</p>`}
<form method="post" action="/projets/${p.id}/fichiers-prod" enctype="multipart/form-data" class="line mt8"><select name="kind" aria-label="Type" style="width:auto">${options(Object.entries(require('../chain').KINDS))}</select><input type="file" name="files" multiple required aria-label="Fichiers"><button class="btn alt sm">Ajouter</button></form>
<div class="h3 mt20">Matière avant fabrication</div>
${(() => { const lots = q.all('SELECT * FROM wood_lots WHERE project_id = ?', p.id); return lots.length ? h`<p class="mt4">Bois réservé dans le stock : ${lots.map((l) => `lot ${l.code} · ${l.essence} ${l.thickness} · ${String(l.volume).replace('.', ',')} m³`).join(' ; ')}.</p>` : ''; })()}
${m.items.length ? h`<p class="mt4">${m.date ? h`Fabrication possible à partir du <b>${ddmm(m.date)}</b>${m.estimated ? ' (estimation : délais habituels des fournisseurs, en attendant les dates de commande)' : ''}.` : h`<b>Toute la matière est là.</b>`} <a href="/achats">Voir les achats</a></p>
<div class="tablebox mt8"><table class="tbl dense"><thead><tr><th>Article</th><th>Fournisseur</th><th>Où en est-on</th><th>Arrivée</th></tr></thead><tbody>
${m.items.map((i) => h`<tr><td>${i.text}</td><td>${i.sname || '—'}</td><td>${pill(i.how === 'reçu' ? 'ok' : i.how === 'en retard' ? 'ko' : 'wa', i.how)}</td><td>${ddmm(i.when)}</td></tr>`)}</tbody></table></div>` : h`<p class="mut">Pas encore de matière liée. Elle apparaît ici quand la chaîne est générée.</p>`}
</section>`;
}
r.post('/projets/:id/chaine', loadProject, (req, res) => {
  if (!require('../ai').enabled()) return res.flashTo(`/projets/${req.project.id}#chaine`, 'L’assistant n’est pas activé.', 'ko');
  require('../chain').start(req.project.id);
  res.flashTo(`/projets/${req.project.id}#chaine`, 'L’assistant prépare la chaîne de production (une à trois minutes). Recharge la page dans un instant.');
});
r.post('/projets/:id/fichiers-prod', loadProject, require('../uploads').uploadDocs.array('files', 12), (req, res) => {
  const kind = ['plan3d', 'chiffrage'].includes(req.body.kind) ? req.body.kind : 'plan3d';
  for (const f of req.files || []) q.run('INSERT INTO documents (project_id, title, file, visible_client, kind) VALUES (?, ?, ?, 0, ?)', req.project.id, f.originalname, f.filename, kind);
  res.flashTo(`/projets/${req.project.id}#chaine`, `${(req.files || []).length} fichier(s) ajouté(s). Clique « Générer » pour que l’assistant les lise.`);
});
r.post('/projets/:id/facture', loadProject, upload.single('pdf'), (req, res) => {
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo(`/projets/${req.project.id}#facture`, 'Il faut le PDF de la facture.', 'ko');
  require('../cockpit').addInvoice(req.project.id, { file: req.file.filename, type: 'acompte', number: str(req.body.numero), source: 'Patron' });
  res.flashTo(`/projets/${req.project.id}#facture`, 'Facture d’acompte publiée sur le portail du client.');
});

// ---------- Fiche projet ----------
function loadProject(req, res, next) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.status(404).send(layout({ title: 'Introuvable', tab: 'projets', body: h`<h1>Projet introuvable</h1>` }));
  req.project = p; next();
}

r.get('/projets/:id', loadProject, (req, res) => {
  const p = L.projectSummary(req.project);
  const pm = L.peopleMap();
  const pieces = q.all('SELECT * FROM pieces WHERE project_id = ? ORDER BY id', p.id);
  const plans = q.all('SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC', p.id);
  const photos = q.all('SELECT * FROM photos WHERE project_id = ? ORDER BY created_at DESC', p.id);
  const issues = q.all("SELECT * FROM issues WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC", p.id);
  const docs = q.all('SELECT * FROM documents WHERE project_id = ? ORDER BY id DESC', p.id);
  const history = q.all('SELECT * FROM activity WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 40', p.id);
  const time = q.all("SELECT COALESCE(NULLIF(geste,''), title) g, SUM(declared_hours) h, COUNT(*) n, SUM(status = 'doing') doing FROM steps WHERE project_id = ? AND (declared_hours IS NOT NULL OR status = 'doing') GROUP BY g", p.id);
  const total = time.reduce((a, t) => a + (t.h || 0), 0);
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
  const shared = photos.filter((x) => x.shared_client).length;
  const units = q.all('SELECT * FROM units WHERE project_id = ? ORDER BY serial', p.id);
  const lots = q.all('SELECT * FROM wood_lots WHERE project_id = ? ORDER BY code', p.id);
  const pneeds = q.all("SELECT * FROM needs WHERE project_id = ? AND status != 'arrived' ORDER BY id", p.id);
  const model = p.model_id ? q.get('SELECT * FROM models WHERE id = ?', p.model_id) : null;
  const ustate = { a_faire: '', en_stock: 'done', expediee: 'done', livree: 'done' };
  const ulabel = { a_faire: 'À contrôler', en_stock: 'En stock', expediee: 'Expédiée', livree: 'Livrée' };
  const people = L.people();
  const body = h`
<div class="mut"><a href="/projets">Projets</a> › ${p.name}</div>
<div class="head mt4"><div><div class="ref">Dossier ${p.ref}</div><h1 class="m0">${p.name}</h1>
<div class="line mt8">${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}${p.due_date ? ` · Livraison ${ddmm(p.due_date)}` : ''}</span><b style="color:${p.slack.color}" class="t13">${p.slack.text}</b>${p.portal_state === 'open' ? pill('ok', 'Visible sur le portail client') : ''}${p.status === 'termine' ? pill('no', 'Terminé') : ''}</div></div>
<div class="push line"><a class="btn alt" href="#photos">Ajouter une photo</a><a class="btn alt" href="/carnets/${p.id}/imprimer">Imprimer le carnet</a><a class="btn" href="/carnets/${p.id}">Ouvrir le carnet</a></div></div>

<section class="card mt20" aria-label="Avancement">
<div class="frise-big">${p.frise.map((f) => h`<details class="fz ${f.state}"><summary><span class="fz-dot"></span><b>${f.phase}</b><span class="mut t12">${f.label}</span></summary>
<form method="post" action="/projets/${p.id}/phase" class="pop"><input type="hidden" name="phase" value="${f.phase}">
<label>État <select name="state">${options([['auto', 'Automatique'], ['d', 'Fait'], ['c', 'En cours'], ['p', 'Bloque'], ['w', 'À venir'], ['n', 'Sans objet']], 'auto')}</select></label>
<label>Texte <input name="label" placeholder="${f.label}"></label><button class="btn sm">OK</button></form></details>`)}</div>
<p class="mut t12 mt8">La frise se calcule toute seule depuis les fiches du carnet, les plans, l’acompte et les poses. Clique une étape pour la forcer à la main.</p>
</section>

${issues.map((s) => {
    const ph = s.photo_id ? q.get('SELECT file FROM photos WHERE id = ?', s.photo_id) : null;
    return h`<section class="card danger mt20" id="probleme"><div class="line">${ph ? h`<a href="${fileUrl(ph.file)}"><img class="thumb" src="${fileUrl(ph.file)}" alt="Photo jointe"></a>` : ''}<div class="grow"><b>Problème signalé · ${s.body}</b><div class="mut">${pm[s.person_id]?.name || ''} · ${rel(s.created_at)}${ph ? ' · photo jointe' : ''}</div></div></div>
<form method="post" action="/projets/${p.id}/probleme/${s.id}" class="line mt12"><label class="sr" for="rep${s.id}">Réponse</label><input id="rep${s.id}" class="qin" name="reply" placeholder="Ta réponse, elle s’affiche sur l’iPad" value="${s.reply}"><button class="btn alt" name="act" value="reply">Répondre</button><button class="btn" name="act" value="close">Marquer traité</button></form></section>`;
  })}

${chainCard(p)}

<section class="card mt20"><div class="line"><h2>Pièces et matière</h2>${pill('no', p.canal)}${model ? h`<a class="mut" href="/catalogue?m=${model.id}">modèle ${model.name}</a>` : ''}${p.for_whom ? h`<span class="mut">pour ${p.for_whom}</span>` : ''}
<span class="push line">${units.some((u) => u.status === 'a_faire') || !units.length ? postBtn(`/projets/${p.id}/controle`, units.length > 1 ? 'Contrôler la pièce suivante' : 'Contrôle final', 'btn sm') : ''}<a class="btn alt sm" href="/carnets/${p.id}/imprimer">Imprimer le carnet</a></span></div>
${units.length ? h`<div class="h3 mt12">Pièces · ${units.filter((u) => u.status !== 'a_faire').length} contrôlée(s) sur ${units.length}</div><div class="unitgrid">${units.map((u) => h`<a class="unit ${ustate[u.status]}" href="/unites/${u.id}"><b>${u.serial}</b>${ulabel[u.status]}</a>`)}</div>` : h`<p class="mut mt8">La pièce reçoit son numéro (${p.ref}) au contrôle final.</p>`}
<div class="line" style="align-items:flex-start;gap:40px;margin-top:12px"><div style="flex:1 1 340px;min-width:0"><div class="h3">Bois réservé</div>${lots.map((l) => h`<div class="row"><b>${l.code}</b><span class="grow">${l.essence} ${l.thickness}</span><span>${String(l.volume).replace('.', ',')} m³</span></div>`)}${lots.length ? '' : h`<p class="mut">Aucun lot réservé. <a href="/bois">Réserver un lot</a></p>`}</div>
<div style="flex:1 1 340px;min-width:0"><div class="h3">Achats liés</div>${pneeds.map((n) => h`<div class="row"><span class="grow">${n.text}</span>${pill(n.status === 'ordered' ? 'wa' : n.needs_deposit && !n.force ? 'ko' : 'no', n.status === 'ordered' ? 'Commandé' : n.needs_deposit && !n.force ? 'Attend l’acompte' : 'À commander')}</div>`)}${pneeds.length ? '' : h`<p class="mut">Rien à acheter.</p>`}</div></div>
</section>

<div class="cols mt20">
<div class="main-col">
<section class="card"><div class="line"><h2>Pièces du projet</h2></div>
${pieces.map((x, i) => h`<details class="row${i ? '' : ' f'}"><summary class="line grow"><div class="grow"><b>${x.name}</b><span class="mut">${x.descr}</span></div>${x.status ? pill('no', x.status) : ''}${avatar(pm[x.who_id], 28)}</summary>
<form method="post" action="/projets/${p.id}/pieces/${x.id}" class="form grid2 mt8"><label>Nom <input name="name" value="${x.name}"></label><label>Description <input name="descr" value="${x.descr}"></label>
<label>État <input name="status" value="${x.status}" placeholder="ex. Finition 2/3"></label><label>Qui <select name="who_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.name]), x.who_id)}</select></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Retirer</button></div></form></details>`)}
<details class="mt12"><summary class="btn alt sm">+ Pièce</summary><form method="post" action="/projets/${p.id}/pieces" class="form grid2 mt8"><label>Nom <input name="name" required></label><label>Description <input name="descr"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card"><div class="line"><h2>Plans</h2></div>
${plans.map((x, i) => h`<div class="row${i ? '' : ' f'}"><div class="grow"><b>${x.version}${x.descr ? ` · ${x.descr}` : ''}</b><span class="mut">${x.status === 'validee' ? `Validée${x.validated_at ? ` le ${ddmm(x.validated_at)}` : ''} · fait foi pour l'atelier` : x.status === 'archivee' ? `${ddmm(x.created_at)} · remplacée` : `${ddmm(x.created_at)} · à valider`}</span></div>
${pill(x.status === 'validee' ? 'ok' : 'no', x.status === 'validee' ? 'Validée' : x.status === 'archivee' ? 'Archivée' : 'Brouillon')}
${x.file ? h`<a class="btn alt sm" href="${fileUrl(x.file)}" target="_blank">Ouvrir</a>` : ''}
${x.status === 'brouillon' ? postBtn(`/projets/${p.id}/plans/${x.id}/valider`, 'Valider', 'btn sm') : ''}</div>`)}
<details class="mt12"><summary class="btn alt sm">+ Nouvelle version</summary>
<form method="post" action="/projets/${p.id}/plans" enctype="multipart/form-data" class="form grid2 mt8"><label>Version <input name="version" value="V${plans.length + 1}" required></label><label>Ce qui change <input name="descr"></label><label>Fichier (PDF ou image) <input type="file" name="file" accept="application/pdf,image/*"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<section class="card" id="photos"><h2>Journal de fabrication</h2><p class="mut">Tu choisis ce que le client voit sur son portail, et ce que tu peux publier.</p>
<form method="post" action="/projets/${p.id}/photos" enctype="multipart/form-data" class="line mt12"><label class="sr" for="ph">Photo</label><input id="ph" type="file" name="photo" accept="image/*" required><input class="qin" name="title" placeholder="Légende"><button class="btn sm">Ajouter</button></form>
<div class="photos mt12">${photos.map((x) => h`<figure class="ph">${isImage(x.file) ? h`<a href="${fileUrl(x.file)}" target="_blank"><img src="${fileUrl(x.file)}" alt="${x.title}" loading="lazy"></a>` : h`<a href="${fileUrl(x.file)}">Fichier</a>`}
<figcaption><b>${x.title || 'Photo'}</b><span class="mut t12">${ddmm(x.created_at)} · ${pm[x.person_id]?.name || ''}</span>
<form method="post" action="/projets/${p.id}/photos/${x.id}" class="ckrow"><label><input type="checkbox" name="shared_client" value="1" ${x.shared_client ? 'checked' : ''} data-auto> Partagée au client</label><label><input type="checkbox" name="publishable" value="1" ${x.publishable ? 'checked' : ''} data-auto> Publiable</label></form></figcaption></figure>`)}
${photos.length ? '' : h`<p class="mut">Pas encore de photo. L’atelier en ajoute depuis l’iPad.</p>`}</div>
</section>
</div>

<aside class="side-col">
<section class="card"><h2>Temps passé</h2><p class="mut">Déclaré en un tap quand une fiche est finie.</p>
${time.map((t, i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${t.g}</span><b>${t.h ? hoursLabel(t.h) : 'en cours'}</b></div>`)}
<div class="who"><b class="grow">Total à ce jour</b><b>${hoursLabel(total)}</b></div></section>

<section class="card" id="acompte"><h2>Projet</h2>
<form method="post" action="/projets/${p.id}/infos" class="form">
<label>Nom <input name="name" value="${p.name}"></label>
<label>Échéance (livraison) <input type="date" name="due_date" value="${p.due_date || ''}"></label>
<label>Responsable <select name="lead_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.role === 'patron' ? 'Toi' : pp.name]), p.lead_id)}</select></label>
<label>Prochaine action (vide = automatique) <input name="next_action" value="${p.next_action}"></label>
${p.client_id ? h`<label class="ck"><input type="checkbox" name="deposit_needed" value="1" ${p.deposit_needed ? 'checked' : ''}> Acompte demandé</label>
<label>Acompte reçu le <input type="date" name="deposit_at" value="${p.deposit_at ? p.deposit_at.slice(0, 10) : ''}"></label>` : ''}
<label>Bois <textarea name="wood" rows="2">${p.wood}</textarea></label>
<label>Notes <textarea name="notes" rows="4">${p.notes}</textarea></label>
<button class="btn sm">Enregistrer</button></form>
<div class="line mt12">${p.status === 'en_cours' ? postBtn(`/projets/${p.id}/statut`, 'Marquer terminé', 'btn alt sm', { status: 'termine' }, 'Marquer ce projet comme terminé ?') : postBtn(`/projets/${p.id}/statut`, 'Reprendre', 'btn alt sm', { status: 'en_cours' })}</div>
</section>

${p.client_id ? h`<section class="card"><div class="line"><h2>Portail client</h2>${pill(p.portal_state === 'open' ? 'ok' : 'no', p.portal_state === 'open' ? 'Ouvert' : p.portal_state === 'cut' ? 'Accès coupé' : 'Pas ouvert')}</div>
<p class="mut">Ce que ${p.client.name} voit dans son espace. Tout part tout seul, sauf la date de pose.</p>
<div class="who f"><span class="grow">Devis</span><b>${quote ? `Accepté le ${ddmm(quote.accepted_at)}` : '—'}</b></div>
<div class="who"><span class="grow">Acompte</span><b>${p.deposit_at ? `Reçu le ${ddmm(p.deposit_at)}` : 'Attendu'}</b></div>
${(() => { const inv = q.get("SELECT * FROM documents WHERE project_id = ? AND kind = 'facture_acompte' ORDER BY id DESC LIMIT 1", p.id);
    return inv ? h`<div class="who" id="facture"><span class="grow">Facture d’acompte</span><a class="b" href="${fileUrl(inv.file)}" target="_blank">${inv.number ? `n° ${inv.number}` : 'publiée'}</a></div>`
      : p.deposit_needed && !p.deposit_at ? h`<form method="post" action="/projets/${p.id}/facture" enctype="multipart/form-data" class="who" id="facture"><span class="grow">Facture d’acompte<span class="mut t12" style="display:block">${require('../cockpit').configured() ? 'attendue de Cockpit · ou dépose-la ici' : 'dépose le PDF : il part sur le portail'}</span></span>
<input type="file" name="pdf" accept="application/pdf" required aria-label="Facture d’acompte (PDF)" style="max-width:190px"><input name="numero" placeholder="N°" aria-label="Numéro de facture" style="max-width:90px"><button class="btn alt sm">Publier</button></form>` : ''; })()}
<form method="post" action="/projets/${p.id}/infos" class="who"><label class="grow" for="rd">Prête à poser vers le</label><input id="rd" type="date" name="ready_date" value="${p.ready_date || ''}" data-auto><input type="hidden" name="only" value="ready_date"></form>
<div class="who"><span class="grow">Photos partagées</span><b>${shared} sur ${photos.length}</b></div>
<div class="line mt12"><a class="btn alt sm" href="/portails#p${p.id}">Gérer le portail</a><a class="btn alt sm" href="/projets/${p.id}/nouvelles">Donner des nouvelles</a></div>
${p.portal_state !== 'open' ? postBtn(`/portails/espace/${p.id}/ouvrir`, 'Ouvrir l’espace client', 'btn sm mt12') : ''}</section>`
    : h`<section class="card" id="client"><h2>Client et portail</h2><p class="mut">Rattache un client à cet OF pour lui ouvrir un espace de suivi (avancement, photos partagées, documents, date de pose).</p>
<form method="post" action="/projets/${p.id}/client" class="form mt12">
<label>Client existant <select name="client_id"><option value="">—</option>${options(q.all('SELECT id, name FROM clients ORDER BY name').map((c) => [c.id, c.name]))}</select></label>
<label>Ou nouveau client : nom <input name="client_name"></label><label>Son e-mail <input type="email" name="client_email"></label><label>Téléphone <input name="client_phone"></label>
<button class="btn sm">Rattacher le client</button></form></section>`}

<section class="card" id="historique"><h2>Historique</h2><p class="mut">Tout ce qui s’est passé sur ce dossier, daté.</p>
<ol class="timeline mt8">${history.map((a) => h`<li><time datetime="${a.created_at}">${ddmm(a.created_at)} · ${hhmm(a.created_at)}</time><span>${a.text}${a.who ? h` <span class="mut">· ${a.who}</span>` : ''}</span></li>`)}</ol>
${history.length ? '' : h`<p class="mut">Rien encore.</p>`}</section>

<section class="card"><h2>Documents</h2><p class="mut">Devis accepté, PV, facture… Cochés « client », ils s’affichent dans son espace.</p>
${docs.map((d) => h`<div class="row"><a class="grow" href="${fileUrl(d.file)}" target="_blank">${d.title}</a>
<form method="post" action="/projets/${p.id}/documents/${d.id}" class="ckrow"><label><input type="checkbox" name="visible_client" value="1" ${d.visible_client ? 'checked' : ''} data-auto> Client</label></form></div>`)}
<form method="post" action="/projets/${p.id}/documents" enctype="multipart/form-data" class="form mt12"><label>Titre <input name="title" required placeholder="ex. Facture de solde"></label><input type="file" name="file" required accept="application/pdf,image/*"><label class="ck"><input type="checkbox" name="visible_client" value="1"> Visible par le client</label><button class="btn alt sm">Ajouter</button></form>
</section>
</aside></div>`;
  res.send(layout({ title: p.name, tab: 'projets', sub: '/projets', body, flash: req.flash }));
});

r.post('/projets/:id/phase', loadProject, (req, res) => {
  const { phase, state, label } = req.body;
  if (!PHASES.includes(phase)) return res.redirect(`/projets/${req.project.id}`);
  if (state === 'auto') q.run('DELETE FROM phase_overrides WHERE project_id = ? AND phase = ?', req.project.id, phase);
  else q.run('INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, ?, ?, ?)', req.project.id, phase, state, str(label));
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/projets/:id/client', loadProject, (req, res) => {
  const cid = clientFrom(req.body);
  if (!cid) return res.flashTo(`/projets/${req.project.id}#client`, 'Choisis un client ou indique son nom.', 'ko');
  q.run('UPDATE projects SET client_id = ?, for_whom = COALESCE(NULLIF(for_whom, \'\'), (SELECT name FROM clients WHERE id = ?)) WHERE id = ?', cid, cid, req.project.id);
  logActivity(req.project.id, null, 'Client rattaché', 'Patron');
  res.flashTo(`/projets/${req.project.id}`, 'Client rattaché. Tu peux maintenant lui ouvrir son espace (bloc « Portail client »).');
});
r.post('/projets/:id/infos', loadProject, (req, res) => {
  const b = req.body, p = req.project;
  if (b.only === 'ready_date') {
    q.run('UPDATE projects SET ready_date = ? WHERE id = ?', str(b.ready_date) || null, p.id);
    return res.flashTo(`/projets/${p.id}`, 'Date « prête à poser » mise à jour sur le portail.');
  }
  const depositAt = str(b.deposit_at) || null;
  tx(() => {
    q.run('UPDATE projects SET name = ?, due_date = ?, lead_id = ?, next_action = ?, wood = ?, notes = ?, deposit_needed = ?, deposit_at = ? WHERE id = ?',
      str(b.name) || p.name, str(b.due_date) || null, int(b.lead_id), str(b.next_action), str(b.wood), str(b.notes), p.client_id ? (b.deposit_needed ? 1 : 0) : 0, depositAt, p.id);
    // Acompte reçu : les achats qui l'attendaient se débloquent.
    if (depositAt && !p.deposit_at) { q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id); logActivity(p.id, null, `Acompte reçu le ${ddmm(depositAt)}`, 'Patron'); SMS.notify('acompte', { projectId: p.id }); }
    if (str(b.due_date) && str(b.due_date) !== (p.due_date || '')) logActivity(p.id, null, `Date de livraison : ${ddmm(str(b.due_date))}${p.due_date ? ` (au lieu du ${ddmm(p.due_date)})` : ''}`, 'Patron');
  });
  res.flashTo(`/projets/${p.id}`, depositAt && !p.deposit_at ? 'Acompte noté. Les achats bloqués sont débloqués.' : 'Enregistré.');
});

// Acompte reçu en un clic (depuis À décider).
r.post('/projets/:id/acompte', loadProject, (req, res) => {
  const p = req.project;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : `/projets/${p.id}`;
  if (!p.deposit_at) {
    tx(() => {
      q.run("UPDATE projects SET deposit_at = date('now', 'localtime') WHERE id = ?", p.id);
      q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
      logActivity(p.id, null, `Acompte reçu le ${ddmm(today())}`, 'Patron');
    });
    SMS.notify('acompte', { projectId: p.id });
  }
  res.flashTo(back, `Acompte noté pour ${p.name}. Les achats bloqués sont débloqués.`);
});

r.post('/projets/:id/statut', loadProject, (req, res) => {
  const st = req.body.status === 'termine' ? 'termine' : 'en_cours';
  q.run("UPDATE projects SET status = ?, finished_at = CASE WHEN ? = 'termine' THEN datetime('now') ELSE NULL END WHERE id = ?", st, st, req.project.id);
  logActivity(req.project.id, null, st === 'termine' ? 'Projet terminé' : 'Projet repris', 'Patron');
  res.flashTo(`/projets/${req.project.id}`, st === 'termine' ? 'Projet terminé.' : 'Projet repris.');
});

r.post('/projets/:id/probleme/:iid', loadProject, (req, res) => {
  if (req.body.act === 'close') { q.run("UPDATE issues SET status = 'closed', reply = ? WHERE id = ? AND project_id = ?", str(req.body.reply), req.params.iid, req.project.id); logActivity(req.project.id, null, `Problème traité${str(req.body.reply) ? ` : ${str(req.body.reply)}` : ''}`, 'Patron'); }
  else q.run('UPDATE issues SET reply = ? WHERE id = ? AND project_id = ?', str(req.body.reply), req.params.iid, req.project.id);
  res.flashTo(`/projets/${req.project.id}`, req.body.act === 'close' ? 'Problème traité.' : 'Réponse envoyée sur l’iPad.');
});

r.post('/projets/:id/pieces', loadProject, (req, res) => {
  q.run('INSERT INTO pieces (project_id, name, descr) VALUES (?, ?, ?)', req.project.id, str(req.body.name), str(req.body.descr));
  res.redirect(`/projets/${req.project.id}`);
});
r.post('/projets/:id/pieces/:pid', loadProject, (req, res) => {
  const b = req.body;
  if (b.del) q.run('DELETE FROM pieces WHERE id = ? AND project_id = ?', req.params.pid, req.project.id);
  else q.run('UPDATE pieces SET name = ?, descr = ?, status = ?, who_id = ? WHERE id = ? AND project_id = ?', str(b.name), str(b.descr), str(b.status), int(b.who_id), req.params.pid, req.project.id);
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/projets/:id/plans', loadProject, upload.single('file'), (req, res) => {
  q.run('INSERT INTO plans (project_id, version, descr, file) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.version), str(req.body.descr), req.file ? req.file.filename : null);
  res.flashTo(`/projets/${req.project.id}`, 'Plan ajouté. Valide-le quand il fait foi pour l’atelier.');
});
r.post('/projets/:id/plans/:pid/valider', loadProject, (req, res) => {
  tx(() => {
    q.run("UPDATE plans SET status = 'archivee' WHERE project_id = ? AND status = 'validee'", req.project.id);
    q.run("UPDATE plans SET status = 'validee', validated_at = datetime('now') WHERE id = ? AND project_id = ?", req.params.pid, req.project.id);
    logActivity(req.project.id, null, `Plan ${q.get('SELECT version FROM plans WHERE id = ?', req.params.pid)?.version || ''} validé`, 'Patron');
    q.run("DELETE FROM phase_overrides WHERE project_id = ? AND phase = 'Conception'", req.project.id);
  });
  res.flashTo(`/projets/${req.project.id}`, 'Plan validé : c’est lui qui fait foi pour l’atelier.');
});

r.post('/projets/:id/photos', loadProject, upload.single('photo'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}#photos`, 'Format de fichier non reconnu.', 'ko');
  const me = L.patron();
  q.run('INSERT INTO photos (project_id, file, title, person_id) VALUES (?, ?, ?, ?)', req.project.id, req.file.filename, str(req.body.title), me.id);
  res.flashTo(`/projets/${req.project.id}#photos`, 'Photo ajoutée au journal.');
});
r.post('/projets/:id/photos/:pid', loadProject, (req, res) => {
  const was = q.get('SELECT shared_client FROM photos WHERE id = ?', req.params.pid);
  q.run('UPDATE photos SET shared_client = ?, publishable = ? WHERE id = ? AND project_id = ?', req.body.shared_client ? 1 : 0, req.body.publishable ? 1 : 0, req.params.pid, req.project.id);
  if (req.body.shared_client && was && !was.shared_client) SMS.notify('maj', { projectId: req.project.id, quoi: 'nouvelle photo' });
  res.redirect(`/projets/${req.project.id}#photos`);
});

r.post('/projets/:id/documents', loadProject, upload.single('file'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}`, 'Fichier refusé (PDF ou image).', 'ko');
  q.run('INSERT INTO documents (project_id, title, file, visible_client) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.title), req.file.filename, req.body.visible_client ? 1 : 0);
  if (req.body.visible_client) SMS.notify('maj', { projectId: req.project.id, quoi: `nouveau document : ${str(req.body.title).toLowerCase()}` });
  res.flashTo(`/projets/${req.project.id}`, 'Document ajouté.');
});
r.post('/projets/:id/documents/:did', loadProject, (req, res) => {
  const wasDoc = q.get('SELECT visible_client, title FROM documents WHERE id = ?', req.params.did);
  q.run('UPDATE documents SET visible_client = ? WHERE id = ? AND project_id = ?', req.body.visible_client ? 1 : 0, req.params.did, req.project.id);
  if (req.body.visible_client && wasDoc && !wasDoc.visible_client) SMS.notify('maj', { projectId: req.project.id, quoi: `nouveau document : ${String(wasDoc.title).toLowerCase()}` });
  res.redirect(`/projets/${req.project.id}`);
});

// Message d'avancement pour le client : rédigé par l'assistant si activé, sinon modèle prêt à adapter.
r.get('/projets/:id/nouvelles', loadProject, async (req, res, next) => {
  const p = L.projectSummary(req.project);
  if (!p.client) return res.redirect(`/projets/${p.id}`);
  const ai = require('../ai');
  const done = q.all("SELECT title FROM steps WHERE project_id = ? AND status = 'done' AND done_at >= datetime('now', '-14 days') ORDER BY done_at", p.id).map((s) => s.title);
  const doing = q.all("SELECT title FROM steps WHERE project_id = ? AND status = 'doing'", p.id).map((s) => s.title);
  const trip = q.get('SELECT * FROM trips WHERE project_id = ? AND done_at IS NULL ORDER BY date LIMIT 1', p.id);
  const nPhotos = q.get('SELECT COUNT(*) n FROM photos WHERE project_id = ? AND shared_client = 1', p.id).n;
  const facts = [
    `Étape actuelle : ${p.cur.phase.toLowerCase()}`,
    done.length ? `Fait ces deux dernières semaines : ${done.join(', ')}` : null,
    doing.length ? `En cours à l'atelier : ${doing.join(', ')}` : null,
    p.ready_date ? `Prêt à poser vers le ${dayMonth(p.ready_date)}` : null,
    trip ? `Livraison / pose prévue le ${longDate(trip.date)}` : null,
    nPhotos && p.portal_state === 'open' ? `${nPhotos} photo${nPhotos > 1 ? 's' : ''} de l'atelier dans votre espace en ligne` : null,
  ].filter(Boolean);
  let subject = `Des nouvelles de votre projet · ${p.name}`;
  let text = `Bonjour,\n\nVoici où en est votre projet « ${p.name} » :\n${facts.map((f) => `- ${f}`).join('\n')}\n\nN'hésitez pas à nous écrire si vous avez une question.\n\nBien cordialement,\nL'équipe Carchon`;
  let note = ai.enabled() ? '' : 'Modèle simple : active l’assistant IA (Pilotage › Automatisations) pour un message rédigé.';
  if (ai.enabled() && req.query.modele !== '1') {
    try { const m = await ai.clientUpdate({ project: p, clientName: p.client.name, facts }); subject = m.objet; text = m.message; note = 'Rédigé par l’assistant à partir de l’avancement réel. Relis avant d’envoyer.'; }
    catch (e) { if (!(e instanceof ai.AIError)) return next(e); note = `${e.message} Voici un modèle simple.`; }
  }
  const mail = `mailto:${encodeURIComponent(p.client.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  const body = h`<div class="mut"><a href="/projets/${p.id}">${p.name}</a></div><h1>Donner des nouvelles à ${p.client.name}</h1>
<section class="card mt20 mw680 form"><p class="mut">${note}</p>
<label>Objet <input value="${subject}" readonly></label><label>Message <textarea id="newsmsg" rows="12">${text}</textarea></label>
<div class="line"><a class="btn" href="${mail}">Ouvrir dans ma messagerie</a><button type="button" class="btn alt" data-copy="#newsmsg">Copier</button></div>
<p class="mut t12">Faits utilisés : ${facts.join(' · ')}</p></section>`;
  res.send(layout({ title: 'Nouvelles', tab: 'projets', sub: '/projets', body }));
});

module.exports = r;
module.exports.loadProject = loadProject;
module.exports.friseBar = friseBar;
