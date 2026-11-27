'use strict';
// Base de données SQLite (module intégré à Node 22+). Un seul fichier : data/carchon.db
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'carchon.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

// Les 9 étapes de la frise d'un projet.
const PHASES = ['Conception', 'Accord', 'Bois', 'Débit', 'Assemblage', 'Finition', 'Contrôle', 'Livraison', 'Réception'];
// Les gestes suivis dans « Pilotage ».
const GESTES = ['Débit, corroyage', "Queues d'aronde", 'Assemblage', 'Collage', 'Ponçage', 'Vernis', 'Huile-cire', 'Contrôle', 'Pose', 'Usinage CNC', 'Autre'];
const STOCK_CATS = ['Quincaillerie', 'Droguerie', 'Matériaux', 'Consommables'];
// Familles de la stratégie 2027 (les trois premières sont le « cœur ») et origines des affaires.
const FAMILIES = ['Pièce signature', 'Agencement sur mesure', 'Projet pro', 'Petite pièce', 'Hors positionnement'];
const CORE_FAMILIES = FAMILIES.slice(0, 3);
const SOURCES = ['Prescripteur (architecte, décorateur)', 'Client livré, parrainage', 'Site web', 'Instagram, Pinterest', 'Fiche Google', 'Salon, porte ouverte', 'Revendeur', 'Autre'];

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, ini TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4A443E',
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

// Colonnes ajoutées après la première version (bases déjà en service).
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('bars', 'auto', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bars', 'step_id', 'INTEGER');
addColumn('trips', 'reminder_sent_at', 'TEXT');
addColumn('steps', 'ai_generated', 'INTEGER NOT NULL DEFAULT 0');
addColumn('projects', 'ref', 'TEXT');
// Version complète : OF (canal, modèle, quantité), stock fini, machines, capacité.
addColumn('projects', 'canal', "TEXT NOT NULL DEFAULT 'Sur-mesure'");
addColumn('projects', 'model_id', 'INTEGER');
addColumn('projects', 'qty', 'INTEGER NOT NULL DEFAULT 1');
addColumn('projects', 'for_whom', "TEXT DEFAULT ''");
addColumn('people', 'hours_week', 'REAL NOT NULL DEFAULT 35');
addColumn('stock_items', 'machine_id', 'INTEGER');
// Suivi des portails : le client a-t-il ouvert, lu, demandé son code ?
addColumn('quotes', 'opened_at', 'TEXT');
addColumn('quotes', 'last_seen_at', 'TEXT');
addColumn('quotes', 'views', 'INTEGER NOT NULL DEFAULT 0');
addColumn('quotes', 'pdf_opened_at', 'TEXT');
addColumn('quotes', 'code_sent_at', 'TEXT');
addColumn('quotes', 'link_at', 'TEXT');
addColumn('quotes', 'lines', "TEXT DEFAULT '[]'");     // lignes du devis, pour que le client ajuste ligne par ligne
addColumn('quotes', 'response_json', 'TEXT');
addColumn('quotes', 'token_enc', 'TEXT');          // lien chiffré, pour le remettre dans les SMS
addColumn('quotes', 'signer_phone', "TEXT DEFAULT ''");
addColumn('projects', 'portal_token_enc', 'TEXT');
addColumn('clients', 'sms_off', 'INTEGER NOT NULL DEFAULT 0');
// Comment le portail s'adresse au client (vide = deviné depuis le nom).
addColumn('clients', 'civility', "TEXT DEFAULT ''");
addColumn('clients', 'first_name', "TEXT DEFAULT ''");
addColumn('clients', 'last_name', "TEXT DEFAULT ''");
// Chaîne de production générée depuis le devis, les vues 3D et le chiffrage.
addColumn('projects', 'prod_status', "TEXT DEFAULT ''");   // '' | en_cours | pret | erreur
addColumn('projects', 'prod_error', 'TEXT');
addColumn('projects', 'prod_note', 'TEXT');
addColumn('projects', 'prod_at', 'TEXT');
addColumn('projects', 'prod_analysis', 'TEXT');
addColumn('suppliers', 'lead_days', 'INTEGER');            // délai de livraison habituel (jours ouvrés)
addColumn('needs', 'qty', 'REAL');
addColumn('needs', 'unit', "TEXT DEFAULT ''");
addColumn('needs', 'for_chain', 'INTEGER NOT NULL DEFAULT 0'); // matière nécessaire avant la fabrication
addColumn('documents', 'kind', "TEXT DEFAULT ''");          // facture_acompte, facture, plan3d, chiffrage…
addColumn('documents', 'number', "TEXT DEFAULT ''");
addColumn('documents', 'amount', "TEXT DEFAULT ''");
addColumn('projects', 'portal_opened_at', 'TEXT');
addColumn('projects', 'portal_seen_at', 'TEXT');
addColumn('projects', 'portal_views', 'INTEGER NOT NULL DEFAULT 0');
addColumn('projects', 'portal_link_at', 'TEXT');
addColumn('projects', 'descr', "TEXT DEFAULT ''");          // ce qu'on fabrique (le titre, lui, est le nom du client)
addColumn('clients', 'cockpit_id', 'TEXT');                  // fiche client de Cockpit
addColumn('clients', 'synced_at', 'TEXT');
addColumn('trips', 'kind', "TEXT DEFAULT 'Livraison et pose'");
addColumn('trips', 'hours', 'REAL DEFAULT 0');
// Analyse : montant vendu, matière, famille et origine de chaque affaire (pour le taux horaire réel et les sources).
addColumn('projects', 'amount_ht', 'REAL');
addColumn('projects', 'material_ht', 'REAL');
addColumn('projects', 'family', "TEXT DEFAULT ''");
addColumn('projects', 'source', "TEXT DEFAULT ''");
addColumn('quotes', 'amount_ht', 'REAL');
addColumn('quotes', 'source', "TEXT DEFAULT ''");
addColumn('quotes', 'family', "TEXT DEFAULT ''");
// Facture d'acompte émise dans Qonto à l'acceptation du devis.
addColumn('quotes', 'billing_json', 'TEXT');
// Facture de solde (Qonto) émise à la signature du PV ; suivi des relances et messages après la pose.
for (const [c, d] of [['balance_invoice_id', 'TEXT'], ['balance_invoice_number', 'TEXT'], ['balance_invoice_url', 'TEXT'], ['balance_invoice_status', 'TEXT'], ['balance_invoice_error', "TEXT DEFAULT ''"],
  ['balance_invoice_ttc', 'REAL'], ['balance_invoice_due', 'TEXT'], ['balance_invoice_sent_at', 'TEXT'], ['deposit_reminded_at', 'TEXT'], ['balance_reminded_at', 'TEXT']]) addColumn('projects', c, d);
addColumn('quotes', 'relance1_at', 'TEXT');
addColumn('quotes', 'relance2_at', 'TEXT');
addColumn('trips', 'review_sent_at', 'TEXT');
addColumn('trips', 'anniversary_sent_at', 'TEXT');
for (const [c, d] of [['deposit_invoice_id', 'TEXT'], ['deposit_invoice_number', 'TEXT'], ['deposit_invoice_url', 'TEXT'], ['deposit_invoice_status', 'TEXT'], ['deposit_invoice_error', "TEXT DEFAULT ''"],
  ['deposit_invoice_ttc', 'REAL'], ['deposit_invoice_due', 'TEXT'], ['deposit_invoice_sent_at', 'TEXT']]) addColumn('projects', c, d);

db.exec(`
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, family TEXT DEFAULT 'Mobilier', woods TEXT DEFAULT '',
  dims TEXT DEFAULT '', notes TEXT DEFAULT '', care TEXT DEFAULT '', photo TEXT, notice TEXT, threshold INTEGER NOT NULL DEFAULT 0,
  checks TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS model_bom (
  id INTEGER PRIMARY KEY, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  article TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit TEXT DEFAULT '', essence TEXT DEFAULT '', thickness TEXT DEFAULT '',
  stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_steps (
  id INTEGER PRIMARY KEY, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, piece TEXT DEFAULT '', phase TEXT DEFAULT '', geste TEXT DEFAULT '', est_hours REAL DEFAULT 0, per_unit INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '', checks TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS wood_lots (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, essence TEXT NOT NULL, thickness TEXT DEFAULT '', volume REAL NOT NULL DEFAULT 0,
  origin TEXT DEFAULT '', supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, received_at TEXT DEFAULT (date('now')),
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  serial TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'a_faire', wood_lot_id INTEGER REFERENCES wood_lots(id) ON DELETE SET NULL,
  reserved_for TEXT DEFAULT '', checks TEXT NOT NULL DEFAULT '[]', controlled_at TEXT, controlled_by INTEGER REFERENCES people(id),
  shipment_id INTEGER, warranty_until TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, recipient TEXT DEFAULT '', address TEXT DEFAULT '',
  carrier TEXT DEFAULT '', tracking TEXT DEFAULT '', packing TEXT DEFAULT '', shipped_at TEXT, delivered_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sav (
  id INTEGER PRIMARY KEY, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client TEXT DEFAULT '', body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'recue', warranty INTEGER NOT NULL DEFAULT 1, notes TEXT DEFAULT '',
  hours REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), closed_at TEXT
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT '', brand TEXT DEFAULT '', serial TEXT DEFAULT '', since TEXT DEFAULT '',
  gestes TEXT DEFAULT '', sav_contact TEXT DEFAULT '', notice TEXT, down_since TEXT, down_note TEXT DEFAULT '', ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS machine_tasks (
  id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE, title TEXT NOT NULL,
  every_hours REAL, every_days INTEGER, last_done TEXT
);
CREATE TABLE IF NOT EXISTS machine_events (
  id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE, date TEXT DEFAULT (datetime('now')),
  title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'entretien', who TEXT DEFAULT '', days_down REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, label TEXT DEFAULT 'Congé'
);
CREATE TABLE IF NOT EXISTS sms_queue (
  id INTEGER PRIMARY KEY, target TEXT NOT NULL, project_id INTEGER, quote_id INTEGER, phone TEXT NOT NULL, event TEXT NOT NULL, vars TEXT DEFAULT '{}',
  text TEXT, status TEXT NOT NULL DEFAULT 'attente', error TEXT, send_after TEXT NOT NULL, sent_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
-- Fiche de débit générée (cotes finies et brutes, pièce par pièce).
CREATE TABLE IF NOT EXISTS cut_list (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, ord INTEGER DEFAULT 0,
  ensemble TEXT DEFAULT '', piece TEXT NOT NULL, qty REAL DEFAULT 1, material TEXT DEFAULT '',
  l REAL, w REAL, t REAL, bl REAL, bw REAL, bt REAL, grain TEXT DEFAULT '', note TEXT DEFAULT ''
);
-- Fichiers joints à un devis (vues 3D, nomenclature, chiffrage) : repris par l'OF à l'acceptation.
CREATE TABLE IF NOT EXISTS quote_files (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS snoozes (key TEXT PRIMARY KEY, until TEXT NOT NULL);
-- Parcours client : rendez-vous, prises de cotes, échanges… visibles sur son portail.
CREATE TABLE IF NOT EXISTS client_log (
  id INTEGER PRIMARY KEY, number TEXT DEFAULT '', project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'rdv', title TEXT NOT NULL, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
`);

// Sous-traitance : une prestation confiée à un autre atelier (laquage, découpe numérique, verre, sellerie…).
// Statuts : a_commander → commande → envoye (pièces parties chez lui) → recu → controle.
db.exec(`
CREATE TABLE IF NOT EXISTS subcontracts (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, what TEXT NOT NULL, pieces TEXT DEFAULT '', qty TEXT DEFAULT '',
  spec TEXT DEFAULT '', price REAL, quote_ref TEXT DEFAULT '', file TEXT, status TEXT NOT NULL DEFAULT 'a_commander',
  ordered_at TEXT, sent_at TEXT, due_at TEXT, back_at TEXT, controlled_at TEXT, note TEXT DEFAULT '',
  ai INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS subcontracts_project ON subcontracts(project_id, status);
-- Dossier de production : chaque génération du carnet (plans lus + dictée du patron), gardée pour s'y retrouver.
CREATE TABLE IF NOT EXISTS carnet_runs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plans TEXT DEFAULT '', dictation TEXT DEFAULT '', remarks TEXT DEFAULT '', questions TEXT NOT NULL DEFAULT '[]',
  debit TEXT NOT NULL DEFAULT '[]', n INTEGER NOT NULL DEFAULT 0, model TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
`);
addColumn('suppliers', 'subcontractor', 'INTEGER NOT NULL DEFAULT 0');

// CNC : bibliothèque d'outils, avances par matière, travaux (pièces à usiner) et programmes enregistrés.
db.exec(`
CREATE TABLE IF NOT EXISTS cnc_tools (
  id INTEGER PRIMARY KEY, num INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fraise', diameter REAL NOT NULL,
  max_depth REAL NOT NULL DEFAULT 20, rpm INTEGER NOT NULL DEFAULT 18000, feed REAL NOT NULL DEFAULT 3000, plunge REAL NOT NULL DEFAULT 1000,
  pass_depth REAL NOT NULL DEFAULT 6, note TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cnc_feeds (
  id INTEGER PRIMARY KEY, tool_id INTEGER NOT NULL REFERENCES cnc_tools(id) ON DELETE CASCADE, material TEXT NOT NULL,
  rpm INTEGER NOT NULL, feed REAL NOT NULL, plunge REAL NOT NULL, pass_depth REAL NOT NULL, UNIQUE (tool_id, material)
);
CREATE TABLE IF NOT EXISTS cnc_jobs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT 'Mélaminé', thickness REAL NOT NULL DEFAULT 19, sheet_l REAL NOT NULL DEFAULT 2800, sheet_w REAL NOT NULL DEFAULT 2070,
  parts TEXT NOT NULL DEFAULT '[]', source TEXT DEFAULT '', step_id INTEGER REFERENCES steps(id) ON DELETE SET NULL,
  validated_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cnc_programs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, job_id INTEGER REFERENCES cnc_jobs(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1, sheet INTEGER, kind TEXT NOT NULL DEFAULT 'carchon', name TEXT NOT NULL, file TEXT NOT NULL,
  minutes REAL, note TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS cnc_jobs_project ON cnc_jobs(project_id);
CREATE INDEX IF NOT EXISTS cnc_programs_project ON cnc_programs(project_id, active);
`);

// Référence de dossier : P2026-001, P2026-002… attribuée à la création.
db.exec(`
CREATE TRIGGER IF NOT EXISTS projects_ref AFTER INSERT ON projects WHEN NEW.ref IS NULL BEGIN
  UPDATE projects SET ref = 'P' || strftime('%Y', 'now') || '-' || printf('%03d',
    (SELECT COUNT(*) FROM projects WHERE ref LIKE 'P' || strftime('%Y', 'now') || '-%') + 1) WHERE id = NEW.id;
END;
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES people(id), who TEXT DEFAULT '', text TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id, created_at);
`);
for (const p of db.prepare('SELECT id, created_at FROM projects WHERE ref IS NULL ORDER BY id').all()) {
  const y = String(p.created_at || '').slice(0, 4) || String(new Date().getFullYear());
  const n = db.prepare("SELECT COUNT(*) n FROM projects WHERE ref LIKE ?").get(`P${y}-%`).n + 1;
  db.prepare('UPDATE projects SET ref = ? WHERE id = ?').run(`P${y}-${String(n).padStart(3, '0')}`, p.id);
}

// Historique d'un projet : qui a fait quoi, quand.
function logActivity(projectId, personId, text, who = '') {
  if (!projectId) return;
  db.prepare('INSERT INTO activity (project_id, person_id, who, text) VALUES (?, ?, ?, ?)').run(projectId, personId || null, who, String(text).slice(0, 300));
}

// DA Carchon : les pastilles de l'équipe passent en tons neutres (une fois).
if (db.prepare("SELECT value FROM settings WHERE key = 'da_colors'").get() === undefined) {
  const map = { '#3D5A73': '#4A443E', '#7A4E00': '#6B635A', '#2F5D3A': '#2E2925', '#6B4E71': '#5A534B', '#8A2B1E': '#3E3832', '#1C1917': '#1A1714' };
  for (const [a, b] of Object.entries(map)) db.prepare('UPDATE people SET color = ? WHERE upper(color) = ?').run(b, a);
  db.prepare("INSERT INTO settings (key, value) VALUES ('da_colors', '1')").run();
}

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

// Transactions imbriquables : une action peut en appeler une autre sans erreur.
let depth = 0;
function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    depth--;
    db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
    return r;
  } catch (e) {
    depth--;
    try { db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); } catch {}
    throw e;
  }
}

// Premier démarrage : le patron et une liste de stock de départ (à adapter).
function bootstrap() {
  if (!q.get('SELECT id FROM people WHERE role = ?', 'patron')) {
    q.run("INSERT INTO people (name, ini, color, sub, role) VALUES ('Toi', 'PA', '#1A1714', 'conception, rendez-vous', 'patron')");
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
  // Inventaire réel de l'atelier (quincaillerie, droguerie, consommables), sans quantités : chacun en OK / Bientôt / Vide.
  if (setting('stock_atelier_v2') !== '1') {
    const REAL = {
      Quincaillerie: [
        'Vis SPAX-M 4 × 50 mm, empreinte T20, Wirox (boîte de 500)', 'Vis SPAX 4 × 30 mm, empreinte T20 (boîte de 200)',
        'Vis de liaison de meubles (assemblage de caissons)', 'Charnières en applique', 'Charnières pour porte encastrée',
        'Charnières Blum droites (en applique), grises', 'Charnières Blum encastrées, grises', 'Embases droites Blum, grises',
        'Pieds et embases de meuble réglables, 75 mm', 'Clips de plinthes',
        'Connecteurs Lamello Clamex P', 'Connecteurs Lamello Tenso', 'Lamelles bois Lamello, taille 20',
        'Dominos Festool 4 × 20 mm', 'Dominos Festool 5 × 30 mm', 'Dominos Festool 6 × 40 mm', 'Dominos Festool 8 × 40 mm', 'Dominos Festool 10 × 50 mm',
      ],
      Droguerie: ['Rouleaux de peinture', 'Bacs à peinture'],
      Consommables: ['Cartouches de masque, filtre standard', 'Cartouches de masque, filtre vernis et solvants', 'Sacs d’aspirateur'],
    };
    // Les intitulés trop vagues sont remplacés par les dénominations précises.
    for (const old of ['Charnières', 'Vis SPAX', 'Cartouches de masque', 'Bacs à peinture']) q.run('DELETE FROM stock_items WHERE name = ?', old);
    for (const [cat, items] of Object.entries(REAL)) {
      let ord = (q.get('SELECT MAX(ord) m FROM stock_items WHERE category = ?', cat)?.m ?? -1) + 1;
      for (const n of items) if (!q.get('SELECT id FROM stock_items WHERE name = ?', n)) q.run('INSERT INTO stock_items (category, name, state, ord) VALUES (?, ?, 0, ?)', cat, n, ord++);
    }
    setSetting('stock_atelier_v2', '1');
  }
  // Bibliothèque CNC de départ : valeurs prudentes, à vérifier par le patron avant le premier usinage.
  if (!q.get('SELECT id FROM cnc_tools LIMIT 1') && setting('cnc_seeded') !== '1') {
    const T = [[1, 'Fraise compression 2 dents', 'fraise', 8, 32, 18000, 6000, 1500, 10], [2, 'Fraise droite 2 dents', 'fraise', 6, 22, 18000, 4000, 1200, 6],
      [3, 'Foret à bois', 'foret', 5, 30, 6000, 3000, 1800, 15], [4, 'Foret à bois', 'foret', 8, 30, 6000, 3000, 1500, 15], [5, 'Mèche à façonner (charnière)', 'foret', 35, 14, 4500, 2000, 600, 14]];
    for (const t of T) q.run('INSERT INTO cnc_tools (num, name, kind, diameter, max_depth, rpm, feed, plunge, pass_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...t);
    setSetting('cnc_seeded', '1');
  }
}
// Index : les listes restent rapides avec beaucoup de dossiers.
db.exec(`
CREATE INDEX IF NOT EXISTS steps_project ON steps(project_id);
CREATE INDEX IF NOT EXISTS steps_who ON steps(who_id, status);
CREATE INDEX IF NOT EXISTS needs_project ON needs(project_id);
CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS units_project ON units(project_id);
CREATE INDEX IF NOT EXISTS projects_status ON projects(status, due_date);
`);

bootstrap();

// Coordonnées de l'entreprise (documents imprimés, e-mails, portail client).
const COMPANY_FIELDS = [['company_name', 'Raison sociale', 'Carchon Les Ateliers'], ['company_address', 'Adresse', ''], ['company_siret', 'SIRET', ''],
  ['company_phone', 'Téléphone', ''], ['company_email', 'E-mail', ''], ['company_site', 'Site web', 'www.carchon.com']];
const company = () => Object.fromEntries(COMPANY_FIELDS.map(([k, , d]) => [k.replace('company_', ''), setting(k, d) || d]));

module.exports = { db, q, tx, setting, setSetting, logActivity, company, COMPANY_FIELDS, PHASES, GESTES, STOCK_CATS, FAMILIES, CORE_FAMILIES, SOURCES, DATA_DIR, UPLOAD_DIR };
