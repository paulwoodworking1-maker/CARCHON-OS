'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { q, setting, setSetting } = require('./db');
const { sessionMiddleware, requirePatron, hash, verify, throttle, fail } = require('./auth');
const { page, h, flashBox } = require('./html');
const { filePath, sendUpload } = require('./uploads');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; '));
  if (process.env.COOKIE_SECURE === '1') res.set('Strict-Transport-Security', 'max-age=31536000');
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
  req.session = { role: 'patron', gen: setting('session_gen', '0') };
  res.flashTo('/', 'C’est prêt. Commence par ajouter ton équipe dans Pilotage › Réglages équipe.');
});

app.get('/connexion', (req, res) => {
  if (!setting('patron_password')) return res.redirect('/installation');
  res.send(loginPage('Carchon OS', 'Accès patron.', h`
<form method="post" action="/connexion" class="stack"><input type="hidden" name="suite" value="${req.query.suite || '/'}">
<label>Mot de passe <input type="password" name="password" required autofocus autocomplete="current-password"></label>
<button class="btn" type="submit">Se connecter</button></form>
<p style="margin-top:16px"><a href="/mot-de-passe-oublie">Mot de passe oublié ?</a></p>
<p class="mut" style="margin-top:24px">Sur l’iPad de l’atelier : <a href="/atelier/qui">ouvrir le mode atelier</a>.</p>`, req.flash));
});
app.post('/connexion', (req, res) => {
  const key = 'patron:' + req.ip;
  if (throttle(key)) return res.flashTo('/connexion', 'Trop d’essais. Réessaie dans 10 minutes.', 'ko');
  if (!verify(req.body.password || '', setting('patron_password'))) { fail(key); return res.flashTo('/connexion', 'Mot de passe incorrect.', 'ko'); }
  const suite = String(req.body.suite || '/');
  req.session = { role: 'patron', atelier: req.session.atelier, gen: sessionGen() };
  res.saveSession();
  res.redirect(suite.startsWith('/') && !suite.startsWith('//') ? suite : '/');
});

// --- Mot de passe oublié ---
// 1. Par e-mail : un lien valable 30 minutes, envoyé à l'adresse du patron (Pilotage › Automatisations).
// 2. En secours : la variable ADMIN_RESET_PASSWORD chez l'hébergeur, appliquée au démarrage.
const crypto = require('node:crypto');
const mail = require('./mail');
const { sha256 } = require('./auth');
const sessionGen = () => setting('session_gen', '0');
const patronEmail = () => setting('patron_email', '') || process.env.PATRON_EMAIL || '';

app.get('/mot-de-passe-oublie', (req, res) => {
  const canMail = mail.configured() && patronEmail();
  res.send(loginPage('Mot de passe oublié', canMail ? 'Un lien pour choisir un nouveau mot de passe sera envoyé à l’adresse e-mail du patron.' : 'L’envoi d’e-mails n’est pas encore configuré : utilise la méthode de secours ci-dessous.', canMail ? h`
<form method="post" action="/mot-de-passe-oublie" class="stack"><button class="btn" type="submit">Recevoir le lien par e-mail</button></form>
<p class="mut" style="margin-top:20px">Le lien part à l’adresse enregistrée dans Pilotage › Automatisations. Il est valable 30 minutes.</p>
<details style="margin-top:20px"><summary class="mut">Je n’ai plus accès à cette adresse</summary>${rescue()}</details>
<p style="margin-top:20px"><a href="/connexion">Revenir à la connexion</a></p>` : h`${rescue()}<p style="margin-top:20px"><a href="/connexion">Revenir à la connexion</a></p>`, req.flash));
});
const rescue = () => h`<ol class="mut" style="padding-left:18px;line-height:1.7;margin-top:12px">
<li>Chez l’hébergeur (Render : service carchon-os › Environment), ajoute la variable <b>ADMIN_RESET_PASSWORD</b> avec ton nouveau mot de passe (8 caractères minimum).</li>
<li>Enregistre : le logiciel redémarre et applique ce mot de passe.</li>
<li>Connecte-toi avec, puis <b>supprime la variable</b> chez l’hébergeur.</li></ol>`;
app.post('/mot-de-passe-oublie', async (req, res, next) => {
  try {
    const key = 'reset:' + req.ip;
    if (throttle(key)) return res.flashTo('/mot-de-passe-oublie', 'Trop de demandes. Réessaie dans 10 minutes.', 'ko');
    fail(key);
    const to = patronEmail();
    if (mail.configured() && to) {
      const t = crypto.randomBytes(24).toString('base64url');
      setSetting('reset_token', sha256(t));
      setSetting('reset_expires', String(Date.now() + 30 * 60 * 1000));
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      await mail.send({ to, subject: 'Carchon OS · nouveau mot de passe', text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvre ce lien (valable 30 minutes) :\n${base}/mot-de-passe/${t}\n\nSi tu n’as rien demandé, ignore ce message : ton mot de passe ne change pas.\n\nCarchon OS` });
    }
    res.flashTo('/connexion', 'Si l’envoi d’e-mails est configuré, le lien vient de partir. Pense à regarder dans les indésirables.');
  } catch (e) { next(e); }
});
function validReset(t) {
  const stored = setting('reset_token');
  if (!stored || Date.now() > Number(setting('reset_expires', '0'))) return false;
  const a = Buffer.from(sha256(String(t || ''))), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get('/mot-de-passe/:t', (req, res) => {
  if (!validReset(req.params.t)) return res.send(loginPage('Lien expiré', 'Ce lien n’est plus valable. Fais une nouvelle demande.', h`<p><a href="/mot-de-passe-oublie">Nouvelle demande</a></p>`, req.flash));
  res.send(loginPage('Nouveau mot de passe', 'Choisis le nouveau mot de passe du patron.', h`
<form method="post" action="/mot-de-passe/${req.params.t}" class="stack">
<label>Nouveau mot de passe (8 caractères minimum) <input type="password" name="password" minlength="8" required autocomplete="new-password" autofocus></label>
<label>Encore une fois <input type="password" name="confirm" minlength="8" required autocomplete="new-password"></label>
<button class="btn" type="submit">Enregistrer</button></form>`, req.flash));
});
app.post('/mot-de-passe/:t', (req, res) => {
  if (!validReset(req.params.t)) return res.redirect(`/mot-de-passe/${req.params.t}`);
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.flashTo(`/mot-de-passe/${req.params.t}`, 'Au moins 8 caractères.', 'ko');
  if (pw !== String(req.body.confirm || '')) return res.flashTo(`/mot-de-passe/${req.params.t}`, 'Les deux mots de passe ne sont pas identiques.', 'ko');
  setSetting('patron_password', hash(pw));
  setSetting('reset_token', '');
  setSetting('session_gen', String(Number(sessionGen()) + 1)); // déconnecte les anciennes sessions
  req.session = { role: 'patron', gen: sessionGen() };
  res.saveSession();
  res.flashTo('/', 'Mot de passe changé. Les autres appareils devront se reconnecter.');
});

// Secours : ADMIN_RESET_PASSWORD chez l'hébergeur, appliqué une fois par valeur.
if (process.env.ADMIN_RESET_PASSWORD) {
  const pw = process.env.ADMIN_RESET_PASSWORD;
  if (pw.length >= 8 && setting('admin_reset_applied') !== sha256(pw)) {
    setSetting('patron_password', hash(pw));
    setSetting('admin_reset_applied', sha256(pw));
    setSetting('session_gen', String(Number(sessionGen()) + 1));
    console.log('Mot de passe patron remplacé par ADMIN_RESET_PASSWORD. Supprime cette variable chez l’hébergeur.');
  } else if (pw.length < 8) console.log('ADMIN_RESET_PASSWORD ignoré : 8 caractères minimum.');
}
app.post('/deconnexion', (req, res) => { req.session = {}; res.saveSession(); res.redirect('/connexion'); });

// --- Fichiers internes (patron ou atelier connecté) ---
app.get('/fichiers/:name', (req, res) => {
  if (req.session.role !== 'patron' && !req.session.atelier) return res.status(403).send('Accès refusé');
  const f = filePath(req.params.name);
  if (!fs.existsSync(f)) return res.status(404).send('Introuvable');
  sendUpload(res, f);
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
for (const m of ['patron', 'carnets', 'achats', 'planning', 'reglages', 'portails', 'automatisations', 'catalogue', 'machines', 'charge', 'matiere', 'livraison', 'assistant']) app.use('/', requirePatron, require(`./routes/${m}`));

app.use((req, res) => res.status(404).send(page('Introuvable', h`<main class="login"><h1>Page introuvable</h1><p><a href="/">Revenir à l’accueil</a></p></main>`)));
app.use((err, req, res, next) => {
  console.error(err);
  // Le détail technique n'est montré qu'au patron connecté ; le public voit un message neutre.
  const detail = req.session?.role === 'patron' ? err.message : 'L’atelier a été prévenu. Réessayez dans un instant.';
  res.status(500).send(page('Erreur', h`<main class="login"><h1>Un problème est survenu</h1><p class="mut">${detail}</p><p><a href="/" data-back>Revenir</a></p></main>`));
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Carchon OS prêt sur http://localhost:${port}`));
  automations.start();
}
module.exports = app;
