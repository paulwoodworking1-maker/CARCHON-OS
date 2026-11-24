'use strict';
// Base de données SQLite (module intégré à Node 22+). Un seul fichier : data/carchon.db
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'carchon.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Les 9 étapes de la frise d'un projet.
const PHASES = ['Conception', 'Accord', 'Bois', 'Débit', 'Assemblage', 'Finition', 'Contrôle', 'Livraison', 'Réception'];
// Les gestes suivis dans « Pilotage ».
const GESTES = ['Débit, corroyage', "Queues d'aronde", 'Assemblage', 'Collage', 'Ponçage', 'Vernis', 'Huile-cire', 'Contrôle', 'Pose', 'Autre'];
const STOCK_CATS = ['Quincaillerie', 'Droguerie', 'Matériaux', 'Consommables'];

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, ini TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#3D5A73',
  sub TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'ouvrier', pin_hash TEXT, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'Particulier', email TEXT DEFAULT '',
  phone TEXT DEFAULT '', address TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'Particulier', client_id INTEGER REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'en_cours', due_date TEXT, ready_date TEXT, lead_id INTEGER REFERENCES people(id),
  next_action TEXT DEFAULT '', wood TEXT DEFAULT '', notes TEXT DEFAULT '',
  deposit_needed INTEGER NOT NULL DEFAULT 1, deposit_asked_at TEXT, deposit_at TEXT,
  portal_token_hash TEXT, portal_state TEXT NOT NULL DEFAULT 'none',
  sent_to_atelier_at TEXT, created_at TEXT DEFAULT (datetime('now')), finished_at TEXT
);

CREATE TABLE IF NOT EXISTS phase_overrides (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, phase TEXT NOT NULL,
  state TEXT NOT NULL, label TEXT DEFAULT '', PRIMARY KEY (project_id, phase)
);

CREATE TABLE IF NOT EXISTS pieces (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, descr TEXT DEFAULT '', status TEXT DEFAULT '', who_id INTEGER REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL, descr TEXT DEFAULT '', file TEXT, status TEXT NOT NULL DEFAULT 'brouillon',
  validated_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, piece TEXT DEFAULT '', who_id INTEGER REFERENCES people(id),
  phase TEXT DEFAULT '', geste TEXT DEFAULT '', est_hours REAL DEFAULT 0, note TEXT DEFAULT '',
  checks TEXT NOT NULL DEFAULT '[]', plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL, audio TEXT,
  status TEXT NOT NULL DEFAULT 'todo', sent INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0, added_by_atelier INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, done_at TEXT, declared_hours REAL, declared_label TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES people(id), body TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  read_by_patron INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES steps(id) ON DELETE SET NULL, file TEXT NOT NULL, title TEXT DEFAULT '',
  person_id INTEGER REFERENCES people(id), shared_client INTEGER NOT NULL DEFAULT 0, publishable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES steps(id) ON DELETE SET NULL, person_id INTEGER REFERENCES people(id),
  body TEXT NOT NULL, photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL, reply TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, file TEXT NOT NULL, visible_client INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '',
  habit TEXT DEFAULT '', note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, ord INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, what TEXT NOT NULL,
  ordered_at TEXT DEFAULT (date('now')), expected_at TEXT, arrived_at TEXT
);

CREATE TABLE IF NOT EXISTS needs (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, category TEXT DEFAULT '', supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
  person_id INTEGER REFERENCES people(id), source TEXT NOT NULL DEFAULT 'note', checked INTEGER NOT NULL DEFAULT 1,
  needs_deposit INTEGER NOT NULL DEFAULT 0, force INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo', order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bars (
  id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id) ON DELETE CASCADE, lane TEXT NOT NULL DEFAULT 'person',
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, label TEXT NOT NULL, detail TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'work', start_date TEXT NOT NULL, end_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, date TEXT NOT NULL,
  what TEXT DEFAULT '', place TEXT DEFAULT '', access TEXT DEFAULT '', contact TEXT DEFAULT '', team TEXT DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]', done_at TEXT,
  pv_signed_at TEXT, pv_name TEXT, pv_reserves TEXT DEFAULT '', pv_signature TEXT, pv_reserves_lifted_at TEXT,
  balance_paid_at TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, client_id INTEGER REFERENCES clients(id),
  number TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, pdf TEXT NOT NULL, pdf_sha256 TEXT NOT NULL, cgv TEXT, cgv_sha256 TEXT,
  signer_name TEXT NOT NULL, signer_email TEXT NOT NULL, project_name TEXT DEFAULT '', valid_until TEXT NOT NULL,
  token_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', test INTEGER NOT NULL DEFAULT 0,
  otp_hash TEXT, otp_expires TEXT, otp_tries INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT,
  accepted_at TEXT, accept_name TEXT, accept_quality TEXT, accept_text TEXT, accept_ip TEXT, accept_ua TEXT, accept_ref TEXT,
  response_kind TEXT, response_text TEXT, responded_at TEXT, treated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, date TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT DEFAULT '', show_client INTEGER NOT NULL DEFAULT 0
);
`);

// --- petits utilitaires ---
const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};

function setting(key, def = null) {
  const r = q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Premier démarrage : le patron et une liste de stock de départ (à adapter).
function bootstrap() {
  if (!q.get('SELECT id FROM people WHERE role = ?', 'patron')) {
    q.run("INSERT INTO people (name, ini, color, sub, role) VALUES ('Toi', 'PA', '#1C1917', 'conception, rendez-vous', 'patron')");
  }
  if (!q.get('SELECT id FROM stock_items LIMIT 1') && setting('stock_seeded') !== '1') {
    const base = {
      Quincaillerie: ['Charnières', 'Vis SPAX', 'Coulisses de tiroir', 'Taquets d’étagère'],
      Droguerie: ['Vernis mat', 'Huile-cire', 'Colle vinylique', 'Colle époxy', 'Teintes'],
      Matériaux: ['Chêne 27 mm', 'Chêne 40 mm', 'Noyer 27 mm', 'Frêne 27 mm', 'Bandes de chant'],
      Consommables: ['Abrasifs', 'Cartouches de masque', 'Bacs à peinture', 'Chiffons'],
    };
    for (const [cat, items] of Object.entries(base)) items.forEach((n, i) => q.run('INSERT INTO stock_items (category, name, ord) VALUES (?, ?, ?)', cat, n, i));
    setSetting('stock_seeded', '1');
  }
  if (setting('portal_test_mode') === null) setSetting('portal_test_mode', '1');
}
bootstrap();

module.exports = { db, q, tx, setting, setSetting, PHASES, GESTES, STOCK_CATS, DATA_DIR, UPLOAD_DIR };
