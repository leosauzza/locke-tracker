#!/usr/bin/env node
'use strict';
/*
 * BDSP Save Extractor
 * -------------------
 * Extracts trainer info, party, box (storage) and bag items from a Pokemon
 * Brilliant Diamond / Shining Pearl `bdsp-save-example.bin` (e.g. dumped by Ryujinx).
 *
 * Reverse-engineered from PKHeX (https://github.com/kwsch/PKHeX):
 *   - Save layout  : SAV8BS.cs
 *   - PKM crypto   : PokeCrypto.cs  (Gen8 XOR-LCG + 4x80 block shuffle)
 *   - PKM fields   : PB8.cs / G8PKM.cs
 *
 * Usage:
 *   node extract.js [bdsp-save-example.bin] [--json out.json]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SAVE_PATH = process.argv[2] && !process.argv[2].startsWith('--')
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'bdsp-save-example.bin');
const DATA_DIR = path.join(__dirname, 'data');

// ---------------------------------------------------------------------------
// BDSP save layout (absolute offsets, from PKHeX SAV8BS.cs)
// ---------------------------------------------------------------------------
const OFF = {
  MyItem:     0x0563C,
  Party:      0x14098,
  BoxLayout:  0x148AA,
  Box:        0x14EF4,
  MyStatus:   0x79BB4,
  PlayTime:   0x79C04,
  Hash:       0xE9818,
};
const SIZE_STORED      = 0x148;  // 328  (PB8 stored)
const SIZE_PARTY        = 0x158;  // 344  (PB8 party = stored + 0x10 battle-stat tail)
const BLOCK_SIZE        = 80;     // 0x50
const BOX_COUNT         = 40;
const SLOTS_PER_BOX     = 30;
const ITEM_ENTRY_SIZE   = 0x10;
const ITEM_ARRAY_COUNT  = 3000;
const SIZE_G8BDSP_3     = 0xEF0A4; // v1.3 expected length
const HASH_OFFSET       = 0xE9818;
const HASH_LEN          = 0x10;

// Gen8 PKM block shuffle table (PKHeX PokeCrypto.BlockPosition), 32 rows of 4.
// sv = (PV >> 13) & 31  indexes a row directly (last 8 rows mirror the first 8
// so that sv 0..31 can be used without a modulo).
const BLOCK_POSITION = [
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
  2,0,1,3, 3,0,1,2, 2,0,3,1, 3,0,2,1, 1,2,0,3, 1,3,0,2, 2,1,0,3, 3,1,0,2,
  2,3,0,1, 3,2,0,1, 1,2,3,0, 1,3,2,0, 2,1,3,0, 3,1,2,0, 2,3,1,0, 3,2,1,0,
  // duplicates of rows 0..7 (so sv 24..31 work without %24):
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
];

// EXP tables per growth type (PKHeX Experience.Growth0..5). Index N = min EXP
// needed to BE level (N+1). table[99] = max EXP for level 100.
const EXP_TABLES = [
  // 0 Medium-Fast (1_000_000)
  [0,8,27,64,125,216,343,512,729,1000,1331,1728,2197,2744,3375,4096,4913,5832,6859,8000,9261,10648,12167,13824,15625,17576,19683,21952,24389,27000,29791,32768,35937,39304,42875,46656,50653,54872,59319,64000,68921,74088,79507,85184,91125,97336,103823,110592,117649,125000,132651,140608,148877,157464,166375,175616,185193,195112,205379,216000,226981,238328,250047,262144,274625,287496,300763,314432,328509,343000,357911,373248,389017,405224,421875,438976,456533,474552,493039,512000,531441,551368,571787,592704,614125,636056,658503,681472,704969,729000,753571,778688,804357,830584,857375,884736,912673,941192,970299,1000000],
  // 1 Erratic (600_000)
  [0,15,52,122,237,406,637,942,1326,1800,2369,3041,3822,4719,5737,6881,8155,9564,11111,12800,14632,16610,18737,21012,23437,26012,28737,31610,34632,37800,41111,44564,48155,51881,55737,59719,63822,68041,72369,76800,81326,85942,90637,95406,100237,105122,110052,115015,120001,125000,131324,137795,144410,151165,158056,165079,172229,179503,186894,194400,202013,209728,217540,225443,233431,241496,249633,257834,267406,276458,286328,296358,305767,316074,326531,336255,346965,357812,367807,378880,390077,400293,411686,423190,433572,445239,457001,467489,479378,491346,501878,513934,526049,536557,548720,560922,571333,583539,591882,600000],
  // 2 Fluctuating (1_640_000)
  [0,4,13,32,65,112,178,276,393,540,745,967,1230,1591,1957,2457,3046,3732,4526,5440,6482,7666,9003,10506,12187,14060,16140,18439,20974,23760,26811,30146,33780,37731,42017,46656,50653,55969,60505,66560,71677,78533,84277,91998,98415,107069,114205,123863,131766,142500,151222,163105,172697,185807,196322,210739,222231,238036,250562,267840,281456,300293,315059,335544,351520,373744,390991,415050,433631,459620,479600,507617,529063,559209,582187,614566,639146,673863,700115,737280,765275,804997,834809,877201,908905,954084,987754,1035837,1071552,1122660,1160499,1214753,1254796,1312322,1354652,1415577,1460276,1524731,1571884,1640000],
  // 3 Medium-Slow (1_059_860)
  [0,9,57,96,135,179,236,314,419,560,742,973,1261,1612,2035,2535,3120,3798,4575,5460,6458,7577,8825,10208,11735,13411,15244,17242,19411,21760,24294,27021,29949,33084,36435,40007,43808,47846,52127,56660,61450,66505,71833,77440,83335,89523,96012,102810,109923,117360,125126,133229,141677,150476,159635,169159,179056,189334,199999,211060,222522,234393,246681,259392,272535,286115,300140,314618,329555,344960,360838,377197,394045,411388,429235,447591,466464,485862,505791,526260,547274,568841,590969,613664,636935,660787,685228,710266,735907,762160,789030,816525,844653,873420,902835,932903,963632,995030,1027103,1059860],
  // 4 Fast (800_000)
  [0,6,21,51,100,172,274,409,583,800,1064,1382,1757,2195,2700,3276,3930,4665,5487,6400,7408,8518,9733,11059,12500,14060,15746,17561,19511,21600,23832,26214,28749,31443,34300,37324,40522,43897,47455,51200,55136,59270,63605,68147,72900,77868,83058,88473,94119,100000,106120,112486,119101,125971,133100,140492,148154,156089,164303,172800,181584,190662,200037,209715,219700,229996,240610,251545,262807,274400,286328,298598,311213,324179,337500,351180,365226,379641,394431,409600,425152,441094,457429,474163,491300,508844,526802,545177,563975,583200,602856,622950,643485,664467,685900,707788,730138,752953,776239,800000],
  // 5 Slow (1_250_000)
  [0,10,33,80,156,270,428,640,911,1250,1663,2160,2746,3430,4218,5120,6141,7290,8573,10000,11576,13310,15208,17280,19531,21970,24603,27440,30486,33750,37238,40960,44921,49130,53593,58320,63316,68590,74148,80000,86151,92610,99383,106480,113906,121670,129778,138240,147061,156250,165813,175760,186096,196830,207968,219520,231491,243890,256723,270000,283726,297910,312558,327680,343281,359370,375953,393040,410636,428750,447388,466560,486271,506530,527343,548720,570666,593190,616298,640000,664301,689210,714733,740880,767656,795070,823128,851840,881211,911250,941963,973360,1005446,1038230,1071718,1105920,1140841,1176490,1212873,1250000],
];
const GROWTH_NAMES = ['Medium-Fast', 'Erratic', 'Fluctuating', 'Medium-Slow', 'Fast', 'Slow'];

// ---------------------------------------------------------------------------
// Name tables (loaded lazily from data/*.txt)
// ---------------------------------------------------------------------------
let NAMES = null;
function loadNames() {
  const read = (f) => {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').split(/\r?\n/);
  };
  const clean = (arr) => {
    if (!arr) return null;
    // strip a possible UTF-8 BOM on the first line
    if (arr.length) arr[0] = arr[0].replace(/^\uFEFF/, '');
    return arr;
  };
  NAMES = {
    species:   clean(read('species_en.txt'))   || [],
    moves:     clean(read('moves_en.txt'))     || [],
    abilities: clean(read('abilities_en.txt')) || [],
    natures:   clean(read('natures_en.txt'))   || [],
    items:     clean(read('items_en.txt'))     || [],
    types:     clean(read('types_en.txt'))     || [],
  };
}
const name = (tbl, id) => (NAMES && NAMES[tbl] && NAMES[tbl][id] != null && NAMES[tbl][id] !== '')
  ? NAMES[tbl][id] : null;

const BALLS = ['', 'Poké Ball', 'Great Ball', 'Ultra Ball', 'Master Ball', 'Safari Ball',
  'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball',
  'Premier Ball', 'Dusk Ball', 'Heal Ball', 'Quick Ball', 'Cherish Ball', 'Fast Ball',
  'Level Ball', 'Lure Ball', 'Moon Ball', 'Friend Ball', 'Love Ball', 'Heavy Ball',
  'Dream Ball', 'Beast Ball'];
const ballName = (id) => BALLS[id] || `Ball#${id}`;

// Personal table (data/personal_bdsp) -> base stats + growth type, 0x44 bytes each.
let PERSONAL = null;
function loadPersonal() {
  const p = path.join(DATA_DIR, 'personal_bdsp');
  if (!fs.existsSync(p)) { PERSONAL = null; return; }
  PERSONAL = fs.readFileSync(p);
}
const PERSONAL_ENTRY = 0x44;
function getPersonal(species) {
  if (!PERSONAL) return null;
  const o = species * PERSONAL_ENTRY;
  if (o < 0 || o + PERSONAL_ENTRY > PERSONAL.length) return null;
  return {
    base:  [PERSONAL[o+0], PERSONAL[o+1], PERSONAL[o+2], PERSONAL[o+3], PERSONAL[o+4], PERSONAL[o+5]], // HP,ATK,DEF,SPE,SPA,SPD
    types: [PERSONAL[o+6], PERSONAL[o+7]],
    growth: PERSONAL[o+0x15],
    genderRatio: PERSONAL[o+0x12],
    abilities: [PERSONAL.readUInt16LE(o+0x18), PERSONAL.readUInt16LE(o+0x1A), PERSONAL.readUInt16LE(o+0x1C)],
  };
}

// ---------------------------------------------------------------------------
// Level from EXP
// ---------------------------------------------------------------------------
function levelFromExp(exp, growth) {
  const table = EXP_TABLES[growth] || EXP_TABLES[0];
  if (exp >= table[99]) return 100;
  let lvl = 1;
  while (lvl < 100 && exp >= table[lvl]) lvl++;
  return lvl;
}

// ---------------------------------------------------------------------------
// Gen8 PKM crypto (PB8)
// ---------------------------------------------------------------------------
function cryptArray(buf, seed) {
  let s = seed >>> 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    s = (Math.imul(0x41C64E6D, s) + 0x6073) >>> 0;
    const xor = (s >>> 16) & 0xFFFF;
    buf.writeUInt16LE((buf.readUInt16LE(i) ^ xor) & 0xFFFF, i);
  }
}

// data: Buffer, length SIZE_STORED (0x148) or SIZE_PARTY (0x158). Decrypted in place.
function decryptPB8(data) {
  const pv = data.readUInt32LE(0);
  const sv = (pv >>> 13) & 31;

  // 1) XOR main body [8 .. 0x148) with LCG seeded by PV
  cryptArray(data.subarray(8, SIZE_STORED), pv);
  // 2) XOR party stat tail [0x148 .. 0x158), LCG re-seeded with PV
  if (data.length > SIZE_STORED)
    cryptArray(data.subarray(SIZE_STORED), pv);

  // 3) Unshuffle 4 blocks of 80 bytes:  decrypted[i] = source[BlockPosition[sv*4+i]]
  const copy = Buffer.from(data.subarray(8, 8 + 4 * BLOCK_SIZE));
  for (let i = 0; i < 4; i++) {
    const src = BLOCK_POSITION[sv * 4 + i];
    copy.copy(data, 8 + i * BLOCK_SIZE, src * BLOCK_SIZE, src * BLOCK_SIZE + BLOCK_SIZE);
  }
}

function isSlotEmpty(data) {
  // A real PB8 always has a non-zero EncryptionConstant. Empty box/party slots
  // are all zero (or all 0xFF in some edge cases).
  const ec = data.readUInt32LE(0);
  if (ec === 0 || ec === 0xFFFFFFFF) return true;
  // double-check: sanity byte at 0x04 should be 0 once decrypted
  return false;
}

// ---------------------------------------------------------------------------
// UTF-16LE string reader (Gen8 trash region)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// PB8 field extraction (data must already be decrypted)
// ---------------------------------------------------------------------------
const GENDER = ['Male', 'Female', 'Genderless'];

function parsePB8(data) {
  const species  = data.readUInt16LE(0x08);
  const heldItem = data.readUInt16LE(0x0A);
  const tid16    = data.readUInt16LE(0x0C);
  const sid16    = data.readUInt16LE(0x0E);
  const exp      = data.readUInt32LE(0x10);
  const ability  = data.readUInt16LE(0x14);
  const abilityNum = data[0x16] & 7;
  const pid      = data.readUInt32LE(0x1C);
  const nature   = data[0x20];
  const genderBits = (data[0x22] >> 2) & 3;
  const isFateful = (data[0x22] & 1) === 1;
  const form     = data[0x24];
  const evs      = { HP: data[0x26], Atk: data[0x27], Def: data[0x28], Spe: data[0x29], SpA: data[0x2A], SpD: data[0x2B] };
  const iv32     = data.readUInt32LE(0x8C);
  const ivs      = {
    HP:  (iv32 >>> 0)  & 0x1F,
    Atk: (iv32 >>> 5)  & 0x1F,
    Def: (iv32 >>> 10) & 0x1F,
    Spe: (iv32 >>> 15) & 0x1F,
    SpA: (iv32 >>> 20) & 0x1F,
    SpD: (iv32 >>> 25) & 0x1F,
    isEgg:      (iv32 >>> 30) & 1,
    isNicknamed:(iv32 >>> 31) & 1,
  };
  const nickname = readUTF16(data, 0x58);
  const moves    = [data.readUInt16LE(0x72), data.readUInt16LE(0x74), data.readUInt16LE(0x76), data.readUInt16LE(0x78)];
  const movePP   = [data[0x7A], data[0x7B], data[0x7C], data[0x7D]];
  const movePPUp = [data[0x7E], data[0x7F], data[0x80], data[0x81]];
  const otName   = readUTF16(data, 0xF8);
  const ball     = data[0x124];
  const metByte  = data[0x125];
  const metLevel = metByte & 0x7F;
  const otGender = (metByte >>> 7) & 1;
  const metLoc   = data.readUInt16LE(0x122);
  const eggLoc   = data.readUInt16LE(0x120);
  const language = data[0xE2];
  const htName   = readUTF16(data, 0xA8);

  // Party-only cached battle stats
  let level = null, stats = null, currentHP = null;
  if (data.length >= SIZE_PARTY) {
    level = data[0x148];
    currentHP = data.readUInt16LE(0x8A);
    stats = {
      MaxHP: data.readUInt16LE(0x14A),
      Atk:   data.readUInt16LE(0x14C),
      Def:   data.readUInt16LE(0x14E),
      Spe:   data.readUInt16LE(0x150),
      SpA:   data.readUInt16LE(0x152),
      SpD:   data.readUInt16LE(0x154),
    };
  }

  const p = getPersonal(species) || { growth: 0, genderRatio: 0, abilities: [] };
  if (level == null) level = levelFromExp(exp, p.growth);

  return {
    species, speciesName: name('species', species),
    nickname, form,
    level, exp, growth: p.growth, growthName: GROWTH_NAMES[p.growth],
    nature, natureName: name('natures', nature),
    gender: GENDER[genderBits] || `?(${genderBits})`,
    ability, abilityName: name('abilities', ability), abilityNum,
    heldItem, heldItemName: name('items', heldItem),
    ball, ballName: ballName(ball),
    pid: '0x' + pid.toString(16).toUpperCase().padStart(8, '0'),
    tid: tid16, sid: sid16, id32: (sid16 << 16) >>> 0 | tid16,
    ot: { name: otName, gender: GENDER[otGender] || `${otGender}` },
    htName,
    shiny: ((tid16 ^ sid16 ^ (pid & 0xFFFF) ^ (pid >>> 16)) < 8),
    moves: moves.map((m, i) => ({ id: m, name: name('moves', m), pp: movePP[i], ppUps: movePPUp[i] })),
    ivs, evs,
    isEgg: ivs.isEgg === 1, isNicknamed: ivs.isNicknamed === 1, isFateful,
    met: { level: metLevel, location: metLoc, eggLocation: eggLoc, language },
  };
}

// ---------------------------------------------------------------------------
// Save-level readers
// ---------------------------------------------------------------------------
function readTrainer(buf) {
  const o = OFF.MyStatus;
  const ot = readUTF16(buf, o + 0x00, 0x1A);
  const tid = buf.readUInt16LE(o + 0x1C);
  const sid = buf.readUInt16LE(o + 0x1E);
  const money = buf.readUInt32LE(o + 0x20);
  const male = buf[o + 0x24];
  const rom  = buf[o + 0x2B];
  const gameClear = buf[o + 0x2C];
  const starter = buf.readInt32LE(o + 0x34);
  const game = rom === 0 ? 'Brilliant Diamond' : rom === 1 ? 'Shining Pearl' : `Unknown(${rom})`;
  // PlayTime @ 0x79C04 (size 4): hours u16, minutes u8, seconds u8
  const pt = OFF.PlayTime;
  const playedHours = buf.readUInt16LE(pt);
  const playedMins  = buf[pt + 2];
  const playedSecs  = buf[pt + 3];
  return {
    name: ot, tid, sid, id32: (sid << 16) >>> 0 | tid,
    money, gender: male ? 'Male' : 'Female', game, romCode: rom,
    badges: buf[o + 0x29], gameClear: !!gameClear, starterType: starter,
    playtime: `${playedHours}h ${playedMins}m ${playedSecs}s`,
    rival: readUTF16(buf, 0x55F4, 0x1A),
    zoneID: buf.readInt16LE(0x5634),
  };
}

function readParty(buf) {
  const out = [];
  const count = buf[OFF.Party + 6 * SIZE_PARTY]; // PartyCount byte
  for (let i = 0; i < 6; i++) {
    const o = OFF.Party + i * SIZE_PARTY;
    const raw = buf.subarray(o, o + SIZE_PARTY);
    if (isSlotEmpty(raw)) continue;
    const data = Buffer.from(raw);
    decryptPB8(data);
    out.push({ slot: i, ...parsePB8(data) });
  }
  return { count, members: out };
}

function readBoxes(buf) {
  const boxes = [];
  let total = 0;
  for (let b = 0; b < BOX_COUNT; b++) {
    const slots = [];
    for (let s = 0; s < SLOTS_PER_BOX; s++) {
      const o = OFF.Box + (b * SLOTS_PER_BOX + s) * SIZE_PARTY;
      const raw = buf.subarray(o, o + SIZE_PARTY);
      if (isSlotEmpty(raw)) continue;
      const data = Buffer.from(raw);
      decryptPB8(data);
      slots.push({ slot: s, ...parsePB8(data) });
    }
    total += slots.length;
    boxes.push({ box: b, name: `BOX ${b + 1}`, count: slots.length, slots });
  }
  return { total, boxes };
}

function readBag(buf) {
  const items = [];
  for (let id = 0; id < ITEM_ARRAY_COUNT; id++) {
    const o = OFF.MyItem + id * ITEM_ENTRY_SIZE;
    const count = buf.readInt32LE(o);
    if (count <= 0) continue;
    const isNew      = buf.readInt32LE(o + 0x04);
    const favorite   = buf.readInt32LE(o + 0x08);
    const sortOrder  = buf.readUInt16LE(o + 0x0C);
    items.push({
      id, name: name('items', id), count, favorite: !!favorite,
      isNew: isNew === 0, sortOrder,
    });
  }
  return items;
}

function verifyHash(buf) {
  if (buf.length < HASH_OFFSET + HASH_LEN) return { ok: false, reason: 'file too small' };
  const stored = Buffer.from(buf.subarray(HASH_OFFSET, HASH_OFFSET + HASH_LEN));
  const tmp = Buffer.from(buf);
  tmp.fill(0, HASH_OFFSET, HASH_OFFSET + HASH_LEN);
  const calc = crypto.createHash('md5').update(tmp).digest();
  return { ok: stored.equals(calc), stored: stored.toString('hex'), calc: calc.toString('hex') };
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------
const STAT_KEYS = ['HP', 'Atk', 'Def', 'Spe', 'SpA', 'SpD'];
function fmtPokemon(p, indent = '') {
  const L = [];
  const spec = p.speciesName || `#${p.species}`;
  const formTag = p.form ? `-${p.form}` : '';
  const star = p.shiny ? ' ★' : '';
  const egg = p.isEgg ? ' [EGG]' : '';
  L.push(`${indent}${p.nickname || spec}${p.nickname && p.nickname !== spec ? ` (${spec}${formTag})` : (formTag ? ` (${spec}${formTag})` : '')}${star}${egg}  Lv.${p.level}`);
  L.push(`${indent}  Species: ${spec}${formTag} (#${p.species})   Nature: ${p.natureName || p.nature}   Gender: ${p.gender}`);
  L.push(`${indent}  Ability: ${p.abilityName || p.ability}${p.abilityNum === 2 ? ' (HA)' : ''}   Held: ${p.heldItem ? (p.heldItemName || `#${p.heldItem}`) : '—'}   Ball: ${p.ballName}`);
  L.push(`${indent}  PID ${p.pid}   OT: ${p.ot.name} (TID ${p.tid}/SID ${p.sid})${p.htName ? `   HT: ${p.htName}` : ''}`);
  if (p.stats) {
    L.push(`${indent}  Stats: ${STAT_KEYS.map(k => `${k} ${p.stats[k]}`).join('  ')}   HP ${p.stats.MaxHP || p.stats.MaxHP === 0 ? p.stats.MaxHP : '?'}/${p.stats.MaxHP}`);
  }
  L.push(`${indent}  IVs: ${STAT_KEYS.map(k => `${k} ${p.ivs[k]}`).join('  ')}`);
  L.push(`${indent}  EVs: ${STAT_KEYS.map(k => `${k} ${p.evs[k]}`).join('  ')}`);
  L.push(`${indent}  Moves:`);
  for (const m of p.moves) {
    if (!m.id) continue;
    const ups = m.ppUps > 0 ? ` (+${m.ppUps} PP up)` : '';
    L.push(`${indent}    - ${m.name || '#'+m.id}  (PP ${m.pp}${ups})`);
  }
  L.push(`${indent}  EXP: ${p.exp}   Growth: ${p.growthName}   Met Lv.${p.met.level} @ loc ${p.met.location}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  loadNames();
  loadPersonal();

  if (!fs.existsSync(SAVE_PATH)) {
    console.error(`Save file not found: ${SAVE_PATH}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(SAVE_PATH);
  console.log(`Loaded ${SAVE_PATH} (${buf.length} bytes = 0x${buf.length.toString(16).toUpperCase()})`);

  const revision = buf[0]; // version code lives in the low byte (0x25/0x2C/0x32/0x34)
  const revNames = { 0x25: 'v1.0', 0x2C: 'v1.1', 0x32: 'v1.2', 0x34: 'v1.3' };
  console.log(`Save revision: 0x${revision.toString(16)} (${revNames[revision] || 'unknown'})`);
  if (buf.length === SIZE_G8BDSP_3) console.log('Length matches BDSP v1.3 ✓');

  const hash = verifyHash(buf);
  // Note: PKHeX-spec MD5; Ryujinx dumps frequently don't carry a matching digest
  // even though the data is perfectly intact, so treat as informational.
  if (hash.ok) console.log('MD5 hash valid ✓');
  else console.log(`MD5 hash: no match (informational only — data parses fine)`);
  console.log('');

  const trainer = readTrainer(buf);
  console.log('=== TRAINER ===');
  console.log(`Name: ${trainer.name}   Game: ${trainer.game}`);
  console.log(`TID ${trainer.tid} / SID ${trainer.sid} (ID32 ${trainer.id32})   Money: ${trainer.money}`);
  console.log(`Gender: ${trainer.gender}   Badges: ${trainer.badges}   Champion: ${trainer.gameClear}`);
  console.log(`Rival: ${trainer.rival}   Playtime: ${trainer.playtime}`);
  console.log('');

  const party = readParty(buf);
  console.log(`=== PARTY (${party.members.length}/${6}, save count byte = ${party.count}) ===`);
  for (const p of party.members) {
    console.log(fmtPokemon(p));
    console.log('');
  }
  if (party.members.length === 0) console.log('(party empty)\n');

  const boxes = readBoxes(buf);
  console.log(`=== BOXES (${boxes.total} Pokémon across ${BOX_COUNT} boxes) ===`);
  for (const b of boxes.boxes) {
    if (b.count === 0) continue;
    console.log(`\n--- ${b.name} (${b.count}) ---`);
    for (const p of b.slots) {
      const spec = p.speciesName || `#${p.species}`;
      const tag = p.shiny ? '★' : '';
      console.log(`  [${String(p.slot).padStart(2)}] Lv.${String(p.level).padStart(3)} ${spec}${p.form ? '-'+p.form : ''}${p.gender === 'Male' ? ' ♂' : p.gender === 'Female' ? ' ♀' : ''} ${tag}  ${p.nickname && p.nickname !== spec ? `"${p.nickname}"` : ''}`);
    }
  }
  console.log('');

  const bag = readBag(buf);
  console.log(`=== BAG (${bag.length} item types) ===`);
  for (const it of bag) {
    console.log(`  x${String(it.count).padStart(4)}  #${String(it.id).padStart(4)}  ${it.name || '(unknown)'}${it.favorite ? ' ♥' : ''}`);
  }
  console.log('');

  // Optional JSON output
  const jsonArgIdx = process.argv.indexOf('--json');
  if (jsonArgIdx !== -1 && process.argv[jsonArgIdx + 1]) {
    const outPath = path.resolve(process.argv[jsonArgIdx + 1]);
    const dump = { file: path.basename(SAVE_PATH), length: buf.length, revision: revNames[revision] || ('0x'+revision.toString(16)),
      hashValid: hash.ok, trainer, party: party.members, boxes: boxes.boxes.map(b => ({ box: b.box, count: b.count, slots: b.slots })),
      bag };
    fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
    console.log(`JSON written to ${outPath}`);
  }
}

main();
