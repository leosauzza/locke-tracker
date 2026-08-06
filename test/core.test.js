'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { detectGame, getAdapter } = require('../src/core');
const { BdspAdapter } = require('../src/core/games/bdsp');
const { OrasAdapter } = require('../src/core/games/oras');
const { findDeadBox, summarize } = require('../src/core/nuzlocke');
const { loadNames } = require('../src/core/names');

const SAVE = path.join(__dirname, '..', 'bdsp-save-example.bin');
const hasSave = fs.existsSync(SAVE);
const ORAS_SAVE = path.join(__dirname, '..', 'oras-save-example');
const hasOrasSave = fs.existsSync(ORAS_SAVE);

// Pokemon canonical shape (SPEC §5.1).
const POKEMON_KEYS = [
  'slot', 'species', 'speciesName', 'nickname', 'form', 'level', 'exp',
  'growth', 'growthName', 'nature', 'natureName', 'gender', 'ability',
  'abilityName', 'abilityNum', 'isHiddenAbility', 'heldItem', 'heldItemName',
  'ball', 'ballName', 'pid', 'tid', 'sid', 'id32', 'ot', 'htName', 'shiny',
  'isEgg', 'isNicknamed', 'isFateful', 'moves', 'ivs', 'evs', 'stats', 'met',
];
function assertPokemonShape(p) {
  for (const k of POKEMON_KEYS) assert.ok(k in p, `missing key "${k}"`);
  for (const k of ['HP', 'Atk', 'Def', 'Spe', 'SpA', 'SpD']) {
    assert.ok(k in p.ivs, `ivs missing ${k}`);
    assert.ok(k in p.evs, `evs missing ${k}`);
  }
  assert.ok(p.ot && 'name' in p.ot && 'gender' in p.ot);
  assert.ok(p.met && 'level' in p.met && 'location' in p.met);
}

test('BDSP detection by size + revision byte', () => {
  const buf = Buffer.alloc(0xEF0A4);
  buf[0] = 0x34; // v1.3
  assert.equal(BdspAdapter.detect(buf), true);
  buf[0] = 0x00;
  assert.equal(BdspAdapter.detect(buf), false);
});

test('registry resolves BDSP by key', () => {
  assert.equal(getAdapter('BDSP'), BdspAdapter);
  assert.equal(getAdapter('NOPE'), null);
});

test('ORAS detection by size + BEEF magic (PKHeX IsG6AO)', () => {
  const SIZE_G6ORAS = 0x76000;
  const buf = Buffer.alloc(SIZE_G6ORAS);
  // sin BEEF magic -> no detecta
  assert.equal(OrasAdapter.detect(buf), false);
  // BEEF magic @ len - 0x1F0 (= 0x42454546 LE) -> detecta
  buf.writeUInt32LE(0x42454546, buf.length - 0x1F0);
  assert.equal(OrasAdapter.detect(buf), true);
  // tamaño incorrecto -> no detecta
  assert.equal(OrasAdapter.detect(Buffer.alloc(0x65600)), false);
});

test('registry resolves ORAS by key', () => {
  assert.equal(getAdapter('ORAS'), OrasAdapter);
});

// ---------------------------------------------------------------------------
// Nuzlocke: conteo de la caja "muertos" (SPEC §5.2).
// Lógica pura sobre el array de cajas que devuelve readBoxes().
// ---------------------------------------------------------------------------
test('nuzlocke.findDeadBox: match exacto case-insensitive + trim', () => {
  const boxes = [
    { box: 0, name: 'Caja 1', count: 30 },
    { box: 1, name: ' MUERTOS ', count: 7 },
    { box: 2, name: 'BOX 3', count: 0 },
  ];
  assert.deepEqual(findDeadBox(boxes), { index: 1, name: ' MUERTOS ', count: 7 });
});

test('nuzlocke.findDeadBox: también matchea "dead" (inglés)', () => {
  const boxes = [{ box: 5, name: 'Dead', count: 3 }];
  assert.deepEqual(findDeadBox(boxes), { index: 5, name: 'Dead', count: 3 });
});

test('nuzlocke.findDeadBox: no matchea subcadenas ("muertos2", "no muertos")', () => {
  const boxes = [
    { box: 0, name: 'muertos2', count: 1 },
    { box: 1, name: 'no muertos', count: 1 },
    { box: 2, name: 'BOX 1', count: 0 },
  ];
  assert.equal(findDeadBox(boxes), null);
});

test('nuzlocke.findDeadBox: devuelve null si no hay caja muertos', () => {
  assert.equal(findDeadBox([]), null);
  assert.equal(findDeadBox([{ box: 0, name: 'BOX 1', count: 0 }]), null);
  assert.equal(findDeadBox(null), null);
});

test('nuzlocke.summarize: shape del dump { deadBox }', () => {
  assert.deepEqual(summarize([]), { deadBox: null });
  assert.deepEqual(
    summarize([{ box: 2, name: 'Muertos', count: 4 }]),
    { deadBox: { index: 2, name: 'Muertos', count: 4 } }
  );
});

test('nuzlocke.findDeadBox: override de nombres', () => {
  const boxes = [{ box: 0, name: 'Cementerio', count: 9 }];
  assert.equal(findDeadBox(boxes), null);
  assert.deepEqual(findDeadBox(boxes, ['cementerio']), { index: 0, name: 'Cementerio', count: 9 });
});

(hasSave ? test : test.skip)('regression: real bdsp-save-example.bin (Leo, BDSP v1.3)', () => {
  loadNames();
  const buf = fs.readFileSync(SAVE);
  const Adapter = detectGame(buf);
  assert.equal(Adapter, BdspAdapter);

  const trainer = BdspAdapter.readTrainer(buf);
  assert.equal(trainer.name, 'Leo');
  assert.equal(trainer.tid, 65308);
  assert.equal(trainer.sid, 6058);
  assert.equal(trainer.game, 'Brilliant Diamond');

  const party = BdspAdapter.readParty(buf);
  assert.equal(party.length, 6);
  party.forEach(assertPokemonShape);
  const lead = party[0];
  assert.equal(lead.species, 394); // Prinplup
  assert.equal(lead.nickname, 'Pingo');
  assert.equal(lead.stats && lead.stats.HP != null, true); // party tiene stats
  assert.equal(lead.abilityNum >= 1 && lead.abilityNum <= 3, true);

  const boxes = BdspAdapter.readBoxes(buf);
  assert.equal(boxes.total, 43); // SPEC §11 snapshot
  assert.equal(boxes.boxes.length, 40);
  if (boxes.boxes[0].slots[0]) assertPokemonShape(boxes.boxes[0].slots[0]);
  // Pokémon de caja: stats === null
  const aBoxMon = boxes.boxes.find((b) => b.count > 0).slots[0];
  assert.equal(aBoxMon.stats, null);
  // Nombres de caja leídos del save (SPEC §7.0 BoxLayout @ 0x148AA).
  // Leo renombró las primeras cajas a "Caja N"; las no tocadas caen a "BOX N".
  assert.equal(boxes.boxes[0].name, 'Caja 1');
  assert.equal(boxes.boxes[1].name, 'Caja 2');
  assert.equal(boxes.boxes[2].name, 'BOX 3'); // vacía en el save → default
  for (const box of boxes.boxes) {
    assert.equal(typeof box.name, 'string');
    assert.ok(box.name.length > 0, 'box name no debe ser vacío');
  }

  const bag = BdspAdapter.readBag(buf);
  assert.equal(bag.length, 113); // SPEC §11 snapshot
});

(hasOrasSave ? test : test.skip)('regression: real oras-save-example (Leon, Alpha Sapphire)', () => {
  loadNames();
  const buf = fs.readFileSync(ORAS_SAVE);
  const Adapter = detectGame(buf);
  assert.equal(Adapter, OrasAdapter);

  const v = OrasAdapter.verifyHash(buf);
  assert.equal(v.ok, true); // BEEF magic presente

  const trainer = OrasAdapter.readTrainer(buf);
  assert.equal(trainer.name, 'Leon');
  assert.equal(trainer.tid, 48317);
  assert.equal(trainer.sid, 12141);
  assert.equal(trainer.game, 'Alpha Sapphire');
  assert.equal(trainer.gender, 'Male');
  // Badges en Gen6 es bitmask (popcount), no byte crudo. Leon tiene 8 medallas.
  assert.equal(trainer.badges, 8);

  const party = OrasAdapter.readParty(buf);
  assert.equal(party.length, 6);
  party.forEach(assertPokemonShape);
  const lead = party[0];
  assert.equal(lead.species, 319); // Sharpedo
  assert.equal(lead.stats && lead.stats.HP != null, true); // party tiene stats
  assert.equal(lead.abilityNum >= 1 && lead.abilityNum <= 3, true);
  assert.equal(lead.heldItemName, 'Sharpedonite'); // mega stone — ORAS feature

  const boxes = OrasAdapter.readBoxes(buf);
  assert.equal(boxes.boxes.length, 31); // SAV6.BoxCount
  if (boxes.boxes[0].slots[0]) assertPokemonShape(boxes.boxes[0].slots[0]);
  // Pokémon de caja: stats === null (schema §5.1 nota)
  const aBoxMon = boxes.boxes.find((b) => b.count > 0).slots[0];
  assert.equal(aBoxMon.stats, null);
  // level en caja se calcula desde exp + growth, no es null
  assert.equal(aBoxMon.level != null && aBoxMon.level >= 1 && aBoxMon.level <= 100, true);
  // Nombres de caja leídos del save (SPEC §7.1 BoxLayout @ 0x04400).
  // ORAS precarga defaults localizados al español ("Caja N").
  assert.equal(boxes.boxes[0].name, 'Caja 1');
  for (const box of boxes.boxes) {
    assert.equal(typeof box.name, 'string');
    assert.ok(box.name.length > 0, 'box name no debe ser vacío');
  }

  const bag = OrasAdapter.readBag(buf);
  assert.ok(bag.length > 0);
  // toda entry de bag debe tener id/count válidos y name (las conocidas)
  for (const it of bag.slice(0, 20)) {
    assert.ok(it.id > 0 && it.count > 0);
    assert.equal(it.favorite, false); // Gen6 no tiene flag favorite
  }
});
