'use strict';

// Carga perezosa de tablas de nombres desde data/*.txt y personal tables.
// `src/core/` no depende de Electron: resuelve la carpeta `data/` relativa a
// este archivo (`<root>/data`).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

let NAMES = null;
let PERSONAL_CACHE = {};

function readFileLines(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  const txt = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  if (txt.length) txt[0] = txt[0].replace(/^\uFEFF/, ''); // strip BOM
  return txt;
}

function loadNames() {
  if (NAMES) return NAMES;
  NAMES = {
    species:   readFileLines('species_en.txt'),
    moves:     readFileLines('moves_en.txt'),
    abilities: readFileLines('abilities_en.txt'),
    natures:   readFileLines('natures_en.txt'),
    items:     readFileLines('items_en.txt'),
    types:     readFileLines('types_en.txt'),
  };
  return NAMES;
}

function name(table, id) {
  const n = NAMES && NAMES[table];
  if (n && n[id] != null && n[id] !== '') return n[id];
  return null;
}

const BALLS = ['', 'Poké Ball', 'Great Ball', 'Ultra Ball', 'Master Ball', 'Safari Ball',
  'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball',
  'Premier Ball', 'Dusk Ball', 'Heal Ball', 'Quick Ball', 'Cherish Ball', 'Fast Ball',
  'Level Ball', 'Lure Ball', 'Moon Ball', 'Friend Ball', 'Love Ball', 'Heavy Ball',
  'Dream Ball', 'Beast Ball'];
function ballName(id) { return BALLS[id] || `Ball#${id}`; }

// Personal tables: binary, 0x44 bytes per species entry.
const PERSONAL_ENTRY = 0x44;
function loadPersonal(file) {
  if (PERSONAL_CACHE[file]) return PERSONAL_CACHE[file];
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) { PERSONAL_CACHE[file] = null; return null; }
  PERSONAL_CACHE[file] = fs.readFileSync(p);
  return PERSONAL_CACHE[file];
}

function getPersonal(table, species) {
  if (!table) return null;
  const o = species * PERSONAL_ENTRY;
  if (o < 0 || o + PERSONAL_ENTRY > table.length) return null;
  return {
    base:  [table[o+0], table[o+1], table[o+2], table[o+3], table[o+4], table[o+5]],
    types: [table[o+6], table[o+7]],
    growth: table[o+0x15],
    genderRatio: table[o+0x12],
    abilities: [table.readUInt16LE(o+0x18), table.readUInt16LE(o+0x1A), table.readUInt16LE(o+0x1C)],
  };
}

function readUTF16(buf, offset, maxBytes = 26) {
  let s = '';
  for (let i = 0; i < maxBytes; i += 2) {
    if (offset + i + 1 >= buf.length) break;
    const c = buf.readUInt16LE(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const GENDER = ['Male', 'Female', 'Genderless'];

module.exports = {
  DATA_DIR, loadNames, name, ballName, BALLS,
  loadPersonal, getPersonal, PERSONAL_ENTRY,
  readUTF16, GENDER,
};
