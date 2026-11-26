'use strict';
// Page de l'assistant : poser une question, voir la réponse, repartir de zéro.
const express = require('express');
const { h, layout, pill, postBtn, rel } = require('../html');
const A = require('../assistant');
const ai = require('../ai');

const r = express.Router();
const IDEES = ['Qu’est-ce qui est en retard ou risque de l’être ?', 'Combien de pièces prêtes par modèle, et lesquelles sont réservées ?', 'Qui est surchargé dans les 4 prochaines semaines ?',
  'Quels entretiens machines faut-il faire cette semaine ?', 'Où en est la Bibliothèque noyer ?', 'Sur quels gestes on dépasse le plus le temps prévu ?'];

r.get('/assistant', (req, res) => {
  const msgs = A.transcript();
  const on = ai.enabled();
  const body = h`
<section class="card" style="border-top:0;padding-top:0">
<p class="mut mw680">Pose une question sur l'atelier : l'assistant cherche la réponse dans Carchon OS (OF, carnets, charge, stock, machines, achats, SAV). Il peut aussi noter un achat, ajouter une fiche en brouillon ou une absence, si tu le lui demandes. Il n'envoie rien à l'atelier ni aux clients.</p>
${on ? '' : h`<div class="flash ko mt12">L'assistant n'est pas encore activé : ajoute la clé <b>ANTHROPIC_API_KEY</b> chez l'hébergeur (Render › Environment). Voir Pilotage › Automatisations.</div>`}
</section>
<section class="card asst" aria-live="polite">
${msgs.map((m) => h`<div class="am am-${m.who}">${m.who === 'action' ? pill('ok', 'Fait') : h`<span class="am-who">${m.who === 'toi' ? 'Toi' : 'Assistant'}</span>`}<div class="am-text">${m.text}</div><span class="mut t12">${rel(m.at)}</span></div>`)}
${msgs.length ? '' : h`<div class="chips m0">${IDEES.map((i) => h`<form method="post" action="/assistant" class="inline" data-busy="L’assistant cherche…"><input type="hidden" name="q" value="${i}"><button class="chip" ${on ? '' : 'disabled'}>${i}</button></form>`)}</div>`}
<form method="post" action="/assistant" class="line mt20" data-busy="L’assistant cherche…" id="ask">
<label class="sr" for="aq">Ta question</label><textarea id="aq" class="qin" name="q" rows="2" required placeholder="ex. Combien d’heures reste-t-il sur le lot de suspensions ?" ${on ? 'autofocus' : 'disabled'}></textarea>
<button class="btn" ${on ? '' : 'disabled'}>Demander</button></form>
${msgs.length ? h`<div class="line mt12">${postBtn('/assistant/nouveau', 'Nouvelle conversation', 'btn alt sm', {}, 'Effacer cette conversation ?')}</div>` : ''}
</section>`;
  res.send(layout({ title: 'Assistant', heading: 'Assistant', tab: 'assistant', sub: '/assistant', body, flash: req.flash }));
});

r.post('/assistant', async (req, res, next) => {
  const question = String(req.body.q || '').trim();
  if (!question) return res.redirect('/assistant');
  try { await A.ask(question); res.redirect('/assistant#ask'); }
  catch (e) { if (e instanceof ai.AIError) return res.flashTo('/assistant', e.message, 'ko'); next(e); }
});
r.post('/assistant/nouveau', (req, res) => { A.reset(); res.redirect('/assistant'); });

module.exports = r;
