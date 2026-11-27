'use strict';
// Page « Analyse » : statistiques de toute la base, objectifs de la stratégie, diagnostic.
const express = require('express');
const { setSetting } = require('../db');
const { h, raw, esc, layout, pill, ddmm, MOIS_C, parseDate } = require('../html');
const A = require('../analyse');

const r = express.Router();

const eur = (x) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${Math.round(x).toLocaleString('fr-FR')} €`);
const pc = (x) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${Math.round(x * 100)} %`);
const hr = (x) => (x === null || x === undefined ? '—' : `${Math.round(x).toLocaleString('fr-FR')} h`);
const n1 = (x) => (x === null || x === undefined ? '—' : String(Math.round(x * 10) / 10).replace('.', ','));
const LEVEL = { ko: ['ko', 'Bloquant'], wa: ['wa', 'À surveiller'], idea: ['no', 'Piste'], ok: ['ok', 'Ça marche'] };

// Barres horizontales : [{label, value, text, bad, href}], avec un trait d'objectif facultatif.
function hbars(rows, { max, target, targetLabel = 'objectif' } = {}) {
  if (!rows.length) return h`<p class="mut">Pas encore de données.</p>`;
  const m = Math.max(max || 0, target || 0, ...rows.map((x) => x.value || 0)) || 1;
  return h`<div class="an-bars">${rows.map((x) => h`<div class="an-bar" title="${x.label} : ${x.text}">
<span class="an-bl">${x.href ? h`<a href="${x.href}">${x.label}</a>` : x.label}</span>
<span class="an-bt"><i class="${x.bad ? 'bad' : ''}" style="width:${Math.max(0.5, (x.value || 0) / m * 100)}%"></i>${target ? h`<b class="an-tg" style="left:${target / m * 100}%" aria-hidden="true"></b>` : ''}</span>
<span class="an-bv">${x.text}</span></div>`)}
${target ? h`<div class="legend"><span><i class="an-lg"></i>Trait : ${targetLabel}</span><span><i class="c" style="background:var(--red)"></i>En dessous / au-delà du seuil</span></div>` : ''}</div>`;
}

// Colonnes verticales (mois, semaines) avec ligne d'objectif.
function columns(items, { target, fmt, unit = '' } = {}) {
  const W = 720, H = 200, pad = 28, gap = 6;
  const max = Math.max(target || 0, ...items.map((x) => x.v)) * 1.1 || 1;
  const bw = (W - gap * (items.length - 1)) / items.length;
  const y = (v) => H - pad - (v / max) * (H - pad - 12);
  const lastIdx = items.length - 1;
  return raw(`<svg class="an-cols" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(items.map((x) => `${x.l} ${fmt(x.v)}`).join(', '))}">
<line x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}" stroke="#D9D4CC"/>
${items.map((x, i) => {
    const bx = i * (bw + gap), by = y(x.v), bh = Math.max(0, H - pad - by);
    const bad = target && x.v < target && x.bad !== false;
    return `<g><title>${esc(x.l)} : ${esc(fmt(x.v))}${x.n !== undefined ? ` · ${x.n} affaire(s)` : ''}</title>
<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3" fill="${x.over ? '#A20212' : bad ? '#6B635A' : '#1A1714'}"/>
<rect x="${bx}" y="0" width="${bw}" height="${H}" fill="transparent"/>
<text x="${bx + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#6B635A">${esc(x.l)}</text>
${i === lastIdx || x.v === Math.max(...items.map((z) => z.v)) ? `<text x="${bx + bw / 2}" y="${Math.max(12, by - 5)}" text-anchor="middle" font-size="11" font-weight="700" fill="#1A1714">${esc(fmt(x.v))}</text>` : ''}</g>`;
  }).join('')}
${target ? `<line x1="0" y1="${y(target)}" x2="${W}" y2="${y(target)}" stroke="#A20212" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W}" y="${y(target) - 5}" text-anchor="end" font-size="11" fill="#A20212">objectif ${esc(fmt(target))}${unit}</text>` : ''}
</svg>`);
}

const state = (ok, warn) => (ok === null ? pill('no', 'Pas de données') : ok ? pill('ok', 'Atteint') : warn ? pill('wa', 'Proche') : pill('ko', 'Pas atteint'));

r.get('/analyse', (req, res) => {
  const per = ['90', '182', '365', '0'].includes(String(req.query.periode)) ? Number(req.query.periode) : 365;
  const R = A.compute(per);
  const O = R.O;
  const F = R.findings;
  const S = R.sales, P = R.profit, E = R.estim, D = R.delays, C = R.capacity, Q = R.quality, AP = R.supply, M = R.machines, K = R.market;
  const perLabel = A.PERIODS.find(([v]) => Number(v) === per)[1].toLowerCase();

  // Tableau des objectifs de la stratégie.
  const goals = [
    ['Taux horaire réel', `${O.rate} € / h ou plus`, P.rate === null ? '—' : `${eur(P.rate)} / h`, P.rate === null ? null : P.rate >= O.rate, P.rate >= O.rate * 0.9, '#rentabilite'],
    ['CA signé par mois (moy. 3 mois)', eur(O.ca_month), eur(R.ca.avg3), R.ca.avg3 ? R.ca.avg3 >= O.ca_month : null, R.ca.avg3 >= O.ca_month * 0.8, '#ca'],
    ['Signature sur devis tranchés', `${O.sign} % ou plus`, pc(S.signRate), S.signRate === null ? null : S.signRate * 100 >= O.sign, S.signRate * 100 >= O.sign - 10, '#ventes'],
    ['Écart heures prévues / réelles', `moins de ${O.gap} %`, E.gap === null ? '—' : `${E.gap > 0 ? '+' : ''}${pc(E.gap)}`, E.gap === null ? null : Math.abs(E.gap) * 100 <= O.gap, Math.abs(E.gap) * 100 <= O.gap * 2, '#chiffrage'],
    ['Charge planifiée (4 semaines)', `${O.load} % au plus`, pc(C.load4), C.load4 === null ? null : C.load4 * 100 <= O.load && C.load4 >= 0.5, C.load4 * 100 <= 100, '#capacite'],
    ['Carnet de commandes', `${O.backlog_min} à ${O.backlog_max} mois`, C.backlogMonths === null ? '—' : `${n1(C.backlogMonths)} mois`, C.backlogMonths === null || !C.leftTotal ? null : C.backlogMonths >= O.backlog_min && C.backlogMonths <= O.backlog_max, C.backlogMonths >= O.backlog_min * 0.66, '#capacite'],
    ['Affaires via le réseau', `${O.network} % ou plus`, pc(K.network), K.network === null ? null : K.network * 100 >= O.network, K.network * 100 >= O.network - 15, '#marche'],
    ['Livraisons à la date promise', '90 % ou plus', pc(D.onTime), D.onTime === null ? null : D.onTime >= 0.9, D.onTime >= 0.8, '#delais'],
    ['Photos publiables (30 jours)', `${O.posts_month} ou plus`, String(K.photos30), K.photos30 >= O.posts_month, K.photos30 >= O.posts_month / 2, '#marche'],
  ];
  const reached = goals.filter((g) => g[3] === true).length, measured = goals.filter((g) => g[3] !== null).length;
  const blockers = F.filter((f) => f.level === 'ko'), watch = F.filter((f) => f.level === 'wa'), ideas = F.filter((f) => f.level === 'idea'), good = F.filter((f) => f.level === 'ok');

  const finding = (f) => h`<div class="an-f an-${f.level}"><div class="line">${pill(...LEVEL[f.level])}<span class="eb">${f.area}</span></div>
<b class="t15 an-ft">${f.title}</b>${f.text ? h`<p class="mut m0">${f.text}</p>` : ''}
<p class="t14 m0"><b>À faire :</b> ${f.action}${f.href ? h` <a href="${f.href}">Ouvrir ›</a>` : ''}</p></div>`;

  const months = R.ca.months.map((x) => ({ l: MOIS_C[parseDate(x.m + '-15').getMonth()], v: x.v, n: x.n }));
  const body = h`
<div class="head"><div><div class="eb">Piloter</div><h1>Analyse</h1><p class="mut mt8 mw680">Toutes les données de Carchon OS comparées aux objectifs de ta stratégie 2027. Le diagnostic se recalcule à chaque visite.</p></div>
<nav class="push line an-per" aria-label="Période">${A.PERIODS.map(([v, l]) => h`<a class="btn sm${Number(v) === per ? '' : ' alt'}" href="/analyse?periode=${v}">${l}</a>`)}</nav></div>

<section class="kpis mt20">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Objectifs atteints</span>${pill(reached >= measured * 0.7 && measured ? 'ok' : 'wa', `${measured} mesurés`)}</div><div class="big">${reached} / ${goals.length}</div><div class="sub2">indicateurs de ta stratégie</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Taux horaire réel</span>${P.rate === null ? pill('no', 'à mesurer') : pill(P.rate >= O.rate ? 'ok' : 'ko', `objectif ${O.rate} €`)}</div><div class="big">${P.rate === null ? '—' : eur(P.rate)}</div><div class="sub2">par heure d'atelier, matière déduite</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">CA signé · ${perLabel}</span>${pill('no', `${R.ca.nPeriod} affaire(s)`)}</div><div class="big">${eur(R.ca.period)}</div><div class="sub2">panier moyen ${eur(R.ca.basket)}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Carnet</span>${pill(C.backlogMonths !== null && C.backlogMonths >= O.backlog_min && C.backlogMonths <= O.backlog_max ? 'ok' : 'wa', `${O.backlog_min} à ${O.backlog_max} mois`)}</div><div class="big">${C.leftTotal ? `${n1(C.backlogMonths)} mois` : '—'}</div><div class="sub2">${hr(C.leftTotal)} restantes · ${eur(R.ca.backlogEur)}</div></div>
</section>

<section class="card mt20" id="diagnostic"><div class="line"><h2>Ce qui t'empêche d'avancer</h2><span class="push mut">${blockers.length} bloquant(s) · ${watch.length} à surveiller</span></div>
<p class="mut">Classé du plus urgent au moins urgent. Chaque ligne dit quoi faire.</p>
<div class="an-grid mt12">${[...blockers, ...watch].map(finding)}</div>
${blockers.length + watch.length ? '' : h`<p class="mut">Rien de bloquant sur la période.</p>`}</section>

<div class="cols">
<section class="card main-col" id="pistes"><h2>Pistes auxquelles tu n'as peut-être pas pensé</h2>
<div class="an-grid one mt12">${ideas.map(finding)}</div>${ideas.length ? '' : h`<p class="mut">Les pistes apparaissent quand il y a assez d'affaires terminées, de devis et de fiches mesurées.</p>`}</section>
<section class="card side-col"><h2>Ce qui marche</h2>
<div class="an-grid one mt12">${good.map(finding)}</div>${good.length ? '' : h`<p class="mut">Rien encore de confirmé par les chiffres.</p>`}</section>
</div>

<section class="card" id="objectifs"><h2>Tableau de bord de la stratégie 2027</h2>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>Indicateur</th><th>Cible</th><th class="num">Réel</th><th>État</th></tr></thead><tbody>
${goals.map(([l, c, v, ok, near, href]) => h`<tr><td class="b"><a href="${href}">${l}</a></td><td>${c}</td><td class="num b">${v}</td><td>${state(ok, near)}</td></tr>`)}</tbody></table></div></section>

<section class="card" id="ca"><h2>Chiffre d'affaires signé · 12 mois</h2>
<p class="mut">Montant HT des affaires, au mois de la signature (devis accepté, sinon acompte, sinon création). Objectif : ${eur(O.ca_month)} par mois.</p>
${columns(months, { target: O.ca_month, fmt: (v) => (v >= 1000 ? `${Math.round(v / 1000)} k€` : eur(v)) })}
<div class="an-stats">${[
    ['Moyenne 3 derniers mois', eur(R.ca.avg3)], ['Panier moyen', eur(R.ca.basket)], ['Carnet en cours', eur(R.ca.backlogEur)],
    ['Devis en attente', eur(S.pendingAmount)], ['Perdus (refus, expirés)', eur(S.lostAmount)], ['Affaires sans montant', String(R.ca.missingAmount)]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div></section>

<div class="cols">
<section class="card main-col" id="ventes"><h2>Ventes · devis envoyés par le portail</h2>
${R.quotesTestOnly ? h`<p class="flash ok">Le portail est encore en mode test : ces chiffres portent sur les devis de test.</p>` : ''}
${hbars(S.funnel.map(([l, v], i) => ({ label: l, value: v, text: `${v}${i && S.funnel[0][1] ? ` · ${pc(v / S.funnel[0][1])}` : ''}` })))}
<div class="an-stats">${[['Signés', S.accepted], ['Refusés', S.refused], ['Expirés sans réponse', S.expired], ['En attente', S.pending], ['Délai de signature (médiane)', S.decisionDays === null ? '—' : `${Math.round(S.decisionDays)} j`], ['Versions par devis signé', S.versionsSigned === null ? '—' : n1(S.versionsSigned)]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div></section>
<section class="card side-col"><h2>Pourquoi on te dit non</h2>
${S.reasons.map(([k, v], i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${k}</span><b>${v}</b></div>`)}${S.reasons.length ? '' : h`<p class="mut">Aucun refus motivé sur la période.</p>`}
${S.unopened.length ? h`<h3 class="h3 mt20">Devis jamais ouverts (+ de 3 jours)</h3>${S.unopened.map((d) => h`<div class="who"><span class="grow">${d.last.signer_name}<span class="mut t12">${d.number} · envoyé le ${ddmm(d.sentAt)}</span></span></div>`)}` : ''}</section>
</div>

<section class="card" id="rentabilite"><h2>Rentabilité · affaires terminées</h2>
<p class="mut">Taux horaire réel = (montant HT − matière et sous-traitance) ÷ heures déclarées à l'atelier. Le trait rouge marque ton objectif de ${O.rate} € / h.${P.noMaterial ? ` ${P.noMaterial} affaire(s) sans coût matière : leur taux est surestimé.` : ''}</p>
<div class="an-split mt12">
<div><h3 class="h3">Par famille</h3>${hbars(P.byFamily.map((x) => ({ label: x.k, value: x.rate, bad: x.rate < O.rate, text: `${eur(x.rate)} / h · ${x.n} aff. · ${eur(x.ca)}` })), { target: O.rate, targetLabel: `objectif ${O.rate} € / h` })}
<h3 class="h3 mt20">Par origine du client</h3>${hbars(P.bySource.map((x) => ({ label: x.k, value: x.rate, bad: x.rate < O.rate, text: `${eur(x.rate)} / h · ${x.n} aff.` })), { target: O.rate })}
<h3 class="h3 mt20">Par canal</h3>${hbars(P.byCanal.map((x) => ({ label: x.k, value: x.rate, bad: x.rate < O.rate, text: `${eur(x.rate)} / h · ${x.n} aff.` })), { target: O.rate })}</div>
<div><h3 class="h3">Les moins rentables</h3>
${P.list.slice(0, 8).map((p, i) => h`<div class="who${i ? '' : ' f'}"><a class="grow" href="/projets/${p.id}">${p.name}<span class="mut t12">${eur(p.amount_ht)} · ${hr(p.hd)}${p.family ? ` · ${p.family}` : ''}</span></a><b style="color:${p.rate < O.rate ? 'var(--red)' : 'var(--ink)'}">${eur(p.rate)} / h</b></div>`)}
${P.list.length ? '' : h`<p class="mut">Aucune affaire terminée avec montant et heures.${P.unpriced ? ` ${P.unpriced} terminée(s) sans montant ou sans heures.` : ''}</p>`}
${P.shortfall ? h`<p class="t14 mt12"><b>Manque à gagner :</b> ${eur(P.shortfall)} par rapport à ${O.rate} € / h.</p>` : ''}</div></div></section>

<div class="cols">
<section class="card main-col" id="chiffrage"><h2>Chiffrage · prévu contre réel, par geste</h2>
<p class="mut">Heures déclarées à l'iPad comparées aux heures du carnet, sur ${E.n} fiches finies. Rouge : dépasse ton seuil de ${O.gap} %.</p>
${hbars(E.byGeste.map((x) => ({ label: x.g, value: Math.abs(x.gap), bad: x.gap * 100 > O.gap, text: `${x.gap > 0 ? '+' : '−'}${pc(Math.abs(x.gap))} · ${x.extra > 0 ? '+' : '−'}${hr(Math.abs(x.extra))} · ${x.n} fiches` })))}
<div class="an-stats">${[['Écart global', E.gap === null ? '—' : `${E.gap > 0 ? '+' : ''}${pc(E.gap)}`], ['Heures au-delà du prévu', hr(E.over)], ['Soit, au taux objectif', eur(E.over * O.rate)], ['Tâches ajoutées par l’atelier', `${E.added} · ${hr(E.addedH)}`], ['Fiches sans heures déclarées', `${E.noDeclared} / ${E.doneN}`]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div></section>
<section class="card side-col"><h2>Affaires qui ont dérapé</h2>
${E.worstProjects.map((x, i) => h`<div class="who${i ? '' : ' f'}"><a class="grow" href="/projets/${x.id}">${x.name}<span class="mut t12">${hr(x.e)} prévues · ${hr(x.d)} réelles</span></a><b style="color:${x.gap * 100 > O.gap ? 'var(--red)' : 'var(--ink)'}">${x.gap > 0 ? '+' : ''}${pc(x.gap)}</b></div>`)}
${E.worstProjects.length ? '' : h`<p class="mut">Pas encore assez de fiches mesurées.</p>`}</section>
</div>

<div class="cols">
<section class="card main-col" id="capacite"><h2>Capacité · 12 semaines</h2>
<p class="mut">Charge de toute l'équipe semaine par semaine (heures prévues ÷ heures disponibles). Rouge : au-delà de 100 %. Ligne : ton seuil de ${O.load} %.</p>
${columns(C.twelve.map((x) => ({ l: ddmm(x.w), v: x.c ? Math.round(x.h / x.c * 100) : 0, over: x.c && x.h / x.c > 1, bad: false })), { target: O.load, fmt: (v) => `${v} %` })}
<div class="an-stats">${[['Charge 4 semaines', pc(C.load4)], ['Heures restantes (OF en cours)', hr(C.leftTotal)], ['Capacité utile par mois', hr(C.capMonth)], ['Carnet', C.leftTotal ? `${n1(C.backlogMonths)} mois` : '—'], ['Part qui repose sur toi', pc(C.patronShare)], ['Heures sans personne attribuée', hr(C.unassigned)]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div></section>
<section class="card side-col"><h2>L'équipe · ${perLabel}</h2>
<div class="tablebox"><table class="tbl"><thead><tr><th>Qui</th><th class="num">Fiches</th><th class="num">Heures</th><th class="num">Écart</th><th class="num">Charge 4 sem.</th></tr></thead><tbody>
${C.perPerson.map((x) => h`<tr><td class="b">${x.p.role === 'patron' ? 'Toi' : x.p.name}</td><td class="num">${x.done}</td><td class="num">${hr(x.h)}</td><td class="num">${x.e ? `${x.h >= x.e ? '+' : '−'}${pc(Math.abs(x.h - x.e) / x.e)}` : '—'}</td><td class="num" style="color:${x.load4 > 1 ? 'var(--red)' : 'var(--ink)'}">${pc(x.load4)}</td></tr>`)}</tbody></table></div>
<p class="mut t12 mt8">L'écart compare les heures déclarées aux heures prévues des fiches finies : c'est un signal sur le chiffrage, pas une note de la personne.</p></section>
</div>

<div class="cols">
<section class="card main-col" id="delais"><h2>Délais et trésorerie</h2>
<div class="an-stats">${[['Affaires livrées', D.delivered], ['À la date promise', pc(D.onTime)], ['Retard moyen', D.lateDays ? `${Math.round(D.lateDays)} j` : '—'], ['Signature → livraison (médiane)', D.leadTime === null ? '—' : `${Math.round(D.leadTime)} j`], ['Attente d’un acompte (médiane)', D.depositDays === null ? '—' : `${Math.round(D.depositDays)} j`], ['OF en cours sans échéance', D.noDue]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div>
${D.projectedLate.length ? h`<h3 class="h3 mt20">Finiront après la date promise</h3>${D.projectedLate.map((p) => h`<div class="who"><a class="grow" href="/projets/${p.id}">${p.name}</a><span class="mut">promis le ${ddmm(p.due_date)}</span></div>`)}` : ''}</section>
<section class="card side-col"><h2>Acomptes attendus</h2>
${D.waiting.map((p, i) => h`<div class="who${i ? '' : ' f'}"><a class="grow" href="/projets/${p.id}#acompte">${p.name}<span class="mut t12">${p.cname || ''}${p.amount_ht ? ` · ${eur(p.amount_ht)}` : ''}</span></a><b style="color:${p.since > 7 ? 'var(--red)' : 'var(--ink)'}">${Math.round(p.since)} j</b></div>`)}
${D.waiting.length ? '' : h`<p class="mut">Aucun acompte en attente.</p>`}</section>
</div>

<div class="cols">
<section class="card main-col" id="marche"><h2>D'où viennent tes affaires · ${perLabel}</h2>
<div class="an-split even mt12"><div><h3 class="h3">Par origine</h3>${hbars(K.bySource.map((x) => ({ label: x.k, value: x.ca || x.n, text: `${x.n} aff.${x.ca ? ` · ${eur(x.ca)}` : ''}` })))}</div>
<div><h3 class="h3">Par famille</h3>${hbars(K.byFamily.map((x) => ({ label: x.k, value: x.ca || x.n, bad: x.k === 'Hors positionnement' || x.k === 'Petite pièce', text: `${x.n} aff.${x.ca ? ` · ${eur(x.ca)}` : ''}` })))}</div></div>
<div class="an-stats">${[['Via le réseau', pc(K.network)], ['Dans les familles cœur', pc(K.core)], ['CA des familles cœur', pc(K.coreCa)], ['Clients revenus', pc(K.repeat)], ['Photos publiables (30 j)', `${K.photos30} · ${K.photosTotal} en tout`], ['Clients suivis par leur espace', `${K.portalSeen} / ${K.openPortals}`]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div></section>
<section class="card side-col"><h2>Ce que fabrique l'atelier</h2><p class="mut">OF lancés sur la période, par canal.</p>
${K.canal.map(([k, v], i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${k}</span><b>${v}</b></div>`)}${K.canal.length ? '' : h`<p class="mut">Aucun OF.</p>`}</section>
</div>

<div class="cols">
<section class="card main-col" id="qualite"><h2>Qualité et SAV</h2>
<div class="an-stats">${[['Problèmes signalés', Q.issues], ['Encore ouverts', Q.openIssues], ['Par affaire concernée', Q.issuesPerProject === null ? '—' : n1(Q.issuesPerProject)], ['Demandes SAV', `${Q.sav} · ${Q.savOpen} ouvertes`], ['SAV / pièces livrées', pc(Q.savRate)], ['PV avec réserve', `${Q.pvReserves} / ${Q.pv}`]].map(([l, v]) => h`<div><span class="mut t12">${l}</span><b>${v}</b></div>`)}</div>
<h3 class="h3 mt20">Problèmes par geste</h3>${hbars(Q.issuesByGeste.map(([k, v]) => ({ label: k, value: v, bad: v >= 3, text: String(v) })))}</section>
<section class="card side-col" id="appro"><h2>Achats et machines</h2>
<div class="who f"><span class="grow">Commandes fournisseurs</span><b>${AP.orders}</b></div>
<div class="who"><span class="grow">Arrivées en retard</span><b>${pc(AP.lateRate)}</b></div>
<div class="who"><span class="grow">En retard maintenant</span><b>${AP.openLate.length}</b></div>
<div class="who"><span class="grow">Achats bloqués par un acompte</span><b>${AP.blocked}</b></div>
<div class="who"><span class="grow">Besoins non commandés depuis 7 j</span><b>${AP.needsOld}</b></div>
<div class="who"><span class="grow">Matière / ventes</span><b>${pc(AP.materialShare)}</b></div>
<div class="who"><span class="grow">Stock vide</span><b>${AP.empty.length}</b></div>
${AP.bySup.filter((x) => x.late).map((x) => h`<div class="who"><span class="grow mut">${x.k}</span><span class="mut">${x.late} retard(s) sur ${x.n}</span></div>`)}
<h3 class="h3 mt20">Machines</h3>
<div class="who f"><span class="grow">Pannes · jours d'arrêt</span><b>${M.pannes} · ${n1(M.daysDown)} j</b></div>
<div class="who"><span class="grow">Entretiens faits</span><b>${M.entretiens}</b></div>
<div class="who"><span class="grow">Entretiens dépassés</span><b style="color:${M.late.length ? 'var(--red)' : 'var(--ink)'}">${M.late.length}</b></div>
<div class="who"><span class="grow">En panne maintenant</span><b style="color:${M.down.length ? 'var(--red)' : 'var(--ink)'}">${M.down.length}</b></div></section>
</div>

<div class="cols">
<section class="card main-col" id="donnees"><h2>Fiabilité de l'analyse</h2><p class="mut">Plus ces lignes sont à zéro, plus les chiffres ci-dessus sont justes.</p>
<div class="tablebox mt12"><table class="tbl"><thead><tr><th>Donnée manquante</th><th class="num">Concernés</th><th>Pourquoi c'est utile</th></tr></thead><tbody>
${R.data.map(([l, n, tot, why, href]) => h`<tr><td class="b"><a href="${href}">${l}</a></td><td class="num" style="color:${tot && n / tot > 0.3 ? 'var(--red)' : 'var(--ink)'}">${n} / ${tot}</td><td class="mut">${why}</td></tr>`)}</tbody></table></div></section>
<section class="card side-col" id="reglages-objectifs"><h2>Mes objectifs</h2><p class="mut">Repris de la stratégie 2027. Change-les quand ta situation change.</p>
<form method="post" action="/analyse/objectifs" class="form mt12">${A.OBJECTIVES.map(([k, l]) => h`<label>${l} <input name="${k}" inputmode="decimal" value="${O[k.replace('obj_', '')]}"></label>`)}
<button class="btn sm">Enregistrer</button></form></section>
</div>`;
  res.send(layout({ title: 'Analyse', tab: 'pilotage', sub: '/analyse', body, flash: req.flash }));
});

r.post('/analyse/objectifs', (req, res) => {
  for (const [k] of A.OBJECTIVES) {
    const v = Number(String(req.body[k] ?? '').replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(v) && v >= 0) setSetting(k, String(v));
  }
  res.flashTo('/analyse#reglages-objectifs', 'Objectifs enregistrés : le diagnostic est recalculé.');
});

module.exports = r;
