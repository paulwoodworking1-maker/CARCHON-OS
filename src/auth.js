'use strict';
// Sessions par cookie signé (pas de base de sessions), mots de passe et codes iPad hachés (scrypt).
const crypto = require('node:crypto');
const { q, setting, setSetting } = require('./db');

function secret() {
  let s = process.env.SESSION_SECRET || setting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('='); if (i < 0) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

const COOKIE = 'carchon';
function readSession(req) {
  const c = parseCookies(req)[COOKIE];
  if (!c) return {};
  const [data, mac] = c.split('.');
  if (!data || !mac) return {};
  const expect = sign(data);
  if (expect.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) return {};
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return {}; }
}
function writeSession(res, sess) {
  const data = Buffer.from(JSON.stringify(sess)).toString('base64url');
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure}`);
}

// Middleware : req.session (lecture), res.saveSession(), flash.
function sessionMiddleware(req, res, next) {
  req.session = readSession(req);
  const flash = req.session.flash; // lu une fois
  if (flash) { delete req.session.flash; writeSession(res, req.session); }
  req.flash = flash;
  res.saveSession = () => writeSession(res, req.session);
  res.flashTo = (url, text, kind = 'ok', extra = {}) => { req.session.flash = { text, kind, ...extra }; writeSession(res, req.session); res.redirect(url); };
  next();
}

function hash(secretValue) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(secretValue), salt, 32).toString('hex');
}
function verify(secretValue, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const got = crypto.scryptSync(String(secretValue), salt, 32);
  const exp = Buffer.from(h, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}
const token = () => crypto.randomBytes(24).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Le patron est connecté ?
function requirePatron(req, res, next) {
  if (!setting('patron_password')) return res.redirect('/installation');
  if (req.session.role === 'patron' && String(req.session.gen ?? '0') === setting('session_gen', '0')) return next();
  return res.redirect('/connexion?suite=' + encodeURIComponent(req.originalUrl));
}
// Un ouvrier (ou le patron) est connecté sur l'iPad ?
function requireAtelier(req, res, next) {
  if (req.session.atelier) {
    const p = q.get('SELECT * FROM people WHERE id = ? AND active = 1', req.session.atelier);
    if (p) { req.person = p; return next(); }
  }
  return res.redirect('/atelier/qui');
}

// Anti-bourrinage simple sur les connexions.
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 8;
}
function fail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }
// Efface les essais d'une clé (utilisé par les tests).
function forgive(key) { attempts.delete(key); }

module.exports = { sessionMiddleware, requirePatron, requireAtelier, hash, verify, token, sha256, throttle, fail, forgive, setSetting, secret };
