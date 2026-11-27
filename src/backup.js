'use strict';
// Sauvegardes de la base : une copie chaque nuit, les 14 dernières sont gardées.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');
const { today } = require('./html');

const DIR = path.join(DATA_DIR, 'sauvegardes');
const KEEP = 14;

function make(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // copie cohérente, même pendant l'utilisation
  return file;
}
function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => /^carchon-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(DIR, f)).size }));
}
// Appelée par les automatisations : une fois par jour.
function daily() {
  const file = path.join(DIR, `carchon-${today()}.db`);
  if (fs.existsSync(file)) return false;
  make(file);
  for (const old of list().slice(KEEP)) fs.unlinkSync(path.join(DIR, old.name));
  return true;
}
const fileOf = (name) => (/^carchon-\d{4}-\d{2}-\d{2}\.db$/.test(name) ? path.join(DIR, name) : null);

module.exports = { make, list, daily, fileOf, DIR, KEEP };
