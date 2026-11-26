'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { q, setting, setSetting } = require('./db');
const { sessionMiddleware, requirePatron, hash, verify, throttle, fail } = require('./auth');
const { page, h, flashBox } = require('./html');
const { filePath } = require('./uploads');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/sante', (req, res) => res.type('text').send('ok'));

// --- Installation (premier démarrage) et connexion du patron ---
const loginPage = (title, intro, form, flash) => page(title, h`
<main class="login"><img src="/static/logo.png" alt="Carchon Les Ateliers" class="login-logo">
<h1>${title}</h1><p class="mut">${intro}</p>${flashBox(flash)}${form}</main>`);

app.get('/installation', (req, res) => {
  if (setting('patron_password')) return res.redirect('/connexion');
  res.send(loginPage('Bienvenue dans Carchon OS', 'Choisis le mot de passe du patron. Il ouvre tout le logiciel sur l’ordinateur.', h`
<form method="post" action="/installation" class="stack">
<label>Ton prénom <input name="name" required autocomplete="given-name"></label>
<label>Mot de passe (8 caractères minimum) <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
<button class="btn" type="submit">Commencer</button></form>`, req.flash));
});
app.post('/installation', (req, res) => {
  if (setting('patron_password')) return res.redirect('/connexion');
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.flashTo('/installation', 'Le mot de passe doit faire au moins 8 caractères.', 'ko');
  setSetting('patron_password', hash(pw));
  if (req.body.name) q.run("UPDATE people SET name = ? WHERE role = 'patron'", String(req.body.name).trim());
  req.session = { role: 'patron' };
  res.flashTo('/', 'C’est prêt. Commence par ajouter ton équipe dans Pilotage › Réglages équipe.');
});

app.get('/connexion', (req, res) => {
  if (!setting('patron_password')) return res.redirect('/installation');
  res.send(loginPage('Carchon OS', 'Accès patron.', h`
<form method="post" action="/connexion" class="stack"><input type="hidden" name="suite" value="${req.query.suite || '/'}">
<label>Mot de passe <input type="password" name="password" required autofocus autocomplete="current-password"></label>
<button class="btn" type="submit">Se connecter</button></form>
<p class="mut" style="margin-top:24px">Sur l’iPad de l’atelier : <a href="/atelier/qui">ouvrir le mode atelier</a>.</p>`, req.flash));
});
app.post('/connexion', (req, res) => {
  const key = 'patron:' + req.ip;
  if (throttle(key)) return res.flashTo('/connexion', 'Trop d’essais. Réessaie dans 10 minutes.', 'ko');
  if (!verify(req.body.password || '', setting('patron_password'))) { fail(key); return res.flashTo('/connexion', 'Mot de passe incorrect.', 'ko'); }
  const suite = String(req.body.suite || '/');
  req.session = { role: 'patron', atelier: req.session.atelier };
  res.saveSession();
  res.redirect(suite.startsWith('/') && !suite.startsWith('//') ? suite : '/');
});
app.post('/deconnexion', (req, res) => { req.session = {}; res.saveSession(); res.redirect('/connexion'); });

// --- Fichiers internes (patron ou atelier connecté) ---
app.get('/fichiers/:name', (req, res) => {
  if (req.session.role !== 'patron' && !req.session.atelier) return res.status(403).send('Accès refusé');
  const f = filePath(req.params.name);
  if (!fs.existsSync(f)) return res.status(404).send('Introuvable');
  res.sendFile(f);
});

// Après chaque modification faite dans le logiciel, le planning automatique se recalcule.
const automations = require('./automations');
let replanQueued = false;
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.path.startsWith('/p/') && !req.path.startsWith('/api/')) {
    res.on('finish', () => {
      if (res.statusCode >= 400 || replanQueued) return;
      replanQueued = true;
      setImmediate(() => { replanQueued = false; automations.changed(); });
    });
  }
  next();
});

// --- Routes ---
app.use('/api/v1', require('./routes/api'));       // liaison Cockpit (clé API)
app.use('/p', require('./routes/client'));          // portail client (liens privés)
app.use('/atelier', require('./routes/atelier'));   // iPad
for (const m of ['patron', 'carnets', 'achats', 'planning', 'reglages', 'portails', 'automatisations', 'catalogue', 'machines', 'charge', 'matiere', 'livraison']) app.use('/', requirePatron, require(`./routes/${m}`));

app.use((req, res) => res.status(404).send(page('Introuvable', h`<main class="login"><h1>Page introuvable</h1><p><a href="/">Revenir à l’accueil</a></p></main>`)));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(page('Erreur', h`<main class="login"><h1>Un problème est survenu</h1><p class="mut">${err.message}</p><p><a href="javascript:history.back()">Revenir</a></p></main>`));
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Carchon OS prêt sur http://localhost:${port}`));
  automations.start();
}
module.exports = app;
