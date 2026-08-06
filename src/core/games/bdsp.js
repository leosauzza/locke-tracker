'use strict';

// Adapter de BDSP (Brilliant Diamond / Shining Pearl) — Switch.
// Refactor de extract.js respetando el contrato del SPEC §4 y el schema §5.
//
// Fuentes PKHeX (source of truth):
//   - Save layout : PKHeX.Core/Saves/SAV8BS.cs
//   - PKM crypto  : PKHeX.Core/PKM/Util/PokeCrypto.cs (Decrypt8 / PB8)
//   - PKM fields  : PKHeX.Core/PKM/PB8.cs + G8PKM.cs

const crypto = require('crypto');
const { decryptPKM } = require('../crypto');
const { levelFromExp, GROWTH_NAMES } = require('../exp');
const {
  loadNames, name, ballName, loadPersonal, getPersonal,
  readUTF16, GENDER,
} = require('../names');

const { GameAdapter } = require('../adapter');

// PKHeX: SAV8BS.cs — absolute block offsets.
const OFF = {
  MyItem:    0x0563C,
  Party:     0x14098,
  BoxLayout: 0x148AA,
  Box:       0x14EF4,
  MyStatus:  0x79BB4,
  PlayTime:  0x79C04,
  Hash:      0xE9818,
};

// PKHeX: PB8.cs — sizes.
const SIZE_STORED = 0x148; // 328
const SIZE_PARTY  = 0x158; // 344 (stored + 0x10 battle-stat tail)
const BLOCK_SIZE  = 80;    // 0x50

// PKHeX: SAV8BS.cs
const BOX_COUNT       = 40;
const SLOTS_PER_BOX   = 30;
// PKHeX: SAV6.LongStringLength = 0x22 (34 bytes = 17 UTF-16, NUL-terminated).
// Ancho de cada nombre de caja dentro del bloque BoxLayout (BoxLayout8b.cs:
// GetBoxNameOffset(box) = LongStringLength * box).
const BOX_NAME_LEN    = 0x22;
const ITEM_ENTRY_SIZE = 0x10;
const ITEM_ARRAY_COUNT = 3000;
const HASH_OFFSET     = 0xE9818;
const HASH_LEN        = 0x10;

// PKHeX: SaveUtil.SIZE_G8BDSP (accepted save sizes).
const ACCEPTED_SIZES = [0xEF0A4, 0xEED8C, 0xEDC20, 0xE9828];
const ACCEPTED_REVS  = [0x25, 0x2C, 0x32, 0x34];
const REV_NAMES = { 0x25: 'v1.0', 0x2C: 'v1.1', 0x32: 'v1.2', 0x34: 'v1.3' };

const PERSONAL_FILE = 'personal_bdsp';

function isSlotEmpty(data) {
  // Empty box/party slots are all zero (or 0xFF). A real PKM has a non-zero
  // EncryptionConstant at offset 0.
  const ec = data.readUInt32LE(0);
  if (ec === 0 || ec === 0xFFFFFFFF) return true;
  return false;
}

function decryptPB8(data) {
  return decryptPKM(data, BLOCK_SIZE, SIZE_STORED);
}

// Normaliza el ability number del PKM al schema §5 (1, 2 o 3; 3 = HA).
// PKHeX almacena ability number como bitflag (1=abl1, 2=abl2, 4=HA).
function normalizeAbilityNum(raw) {
  if (raw === 4) return 3; // hidden
  if (raw === 2) return 2;
  return 1;
}

// Schema §5.1 — Pokemon (campos siempre presentes; null si no aplica).
// `isParty`: true para equipo (stats cacheadas + level leído); false para caja
// (stats = null, level calculado desde exp + growth — §5.1 nota).
function parsePB8(data, slot, isParty) {
  const species    = data.readUInt16LE(0x08);
  const heldItem   = data.readUInt16LE(0x0A);
  const tid16      = data.readUInt16LE(0x0C);
  const sid16      = data.readUInt16LE(0x0E);
  const exp        = data.readUInt32LE(0x10);
  const ability    = data.readUInt16LE(0x14);
  const ablRaw     = data[0x16] & 7;
  const abilityNum = normalizeAbilityNum(ablRaw);
  const pid        = data.readUInt32LE(0x1C);
  const nature     = data[0x20];
  const genderBits = (data[0x22] >> 2) & 3;
  const isFateful  = (data[0x22] & 1) === 1;
  const form       = data[0x24];
  const evs = { HP: data[0x26], Atk: data[0x27], Def: data[0x28], Spe: data[0x29], SpA: data[0x2A], SpD: data[0x2B] };
  const iv32 = data.readUInt32LE(0x8C);
  const ivs = {
    HP:  (iv32 >>> 0)  & 0x1F,
    Atk: (iv32 >>> 5)  & 0x1F,
    Def: (iv32 >>> 10) & 0x1F,
    Spe: (iv32 >>> 15) & 0x1F,
    SpA: (iv32 >>> 20) & 0x1F,
    SpD: (iv32 >>> 25) & 0x1F,
  };
  const isEgg       = ((iv32 >>> 30) & 1) === 1;
  const isNicknamed = ((iv32 >>> 31) & 1) === 1;

  const nickname = readUTF16(data, 0x58);
  const moves = [
    data.readUInt16LE(0x72), data.readUInt16LE(0x74),
    data.readUInt16LE(0x76), data.readUInt16LE(0x78),
  ];
  const movePP    = [data[0x7A], data[0x7B], data[0x7C], data[0x7D]];
  const movePPUps = [data[0x7E], data[0x7F], data[0x80], data[0x81]];

  const otName  = readUTF16(data, 0xF8);
  const ball    = data[0x124];
  const metByte = data[0x125];
  const metLevel = metByte & 0x7F;
  const otGender = (metByte >>> 7) & 1;
  const metLoc  = data.readUInt16LE(0x122);
  const eggLoc  = data.readUInt16LE(0x120);
  const language = data[0xE2];
  const htName  = readUTF16(data, 0xA8);

  // Party-only cached battle stats (null en caja — schema §5.1 nota).
  let level = null, stats = null;
  if (isParty && data.length >= SIZE_PARTY) {
    level = data[0x148];
    stats = {
      HP:  data.readUInt16LE(0x14A),
      Atk: data.readUInt16LE(0x14C),
      Def: data.readUInt16LE(0x14E),
      Spe: data.readUInt16LE(0x150),
      SpA: data.readUInt16LE(0x152),
      SpD: data.readUInt16LE(0x154),
    };
  }

  const personal = getPersonal(loadPersonal(PERSONAL_FILE), species) || { growth: 0, abilities: [] };
  if (level == null) level = levelFromExp(exp, personal.growth);

  return {
    slot,
    species,
    speciesName: name('species', species),
    nickname,
    form,
    level,
    exp,
    growth: personal.growth,
    growthName: GROWTH_NAMES[personal.growth] || null,
    nature,
    natureName: name('natures', nature),
    gender: GENDER[genderBits] || null,
    ability,
    abilityName: name('abilities', ability),
    abilityNum,
    isHiddenAbility: abilityNum === 3,
    heldItem,
    heldItemName: heldItem ? name('items', heldItem) : null,
    ball,
    ballName: ballName(ball),
    pid: '0x' + pid.toString(16).toUpperCase().padStart(8, '0'),
    tid: tid16,
    sid: sid16,
    id32: ((sid16 << 16) >>> 0) | tid16,
    ot: { name: otName, gender: GENDER[otGender] || null },
    htName: htName || null,
    shiny: ((tid16 ^ sid16 ^ (pid & 0xFFFF) ^ (pid >>> 16)) & 0xFFFF) < 16,
    isEgg,
    isNicknamed,
    isFateful,
    moves: moves.map((m, i) => ({
      id: m,
      name: name('moves', m),
      pp: movePP[i],
      ppUps: movePPUps[i],
      // maxPp requiere tabla base de movimientos (backlog). null por ahora.
      maxPp: null,
    })),
    ivs,
    evs,
    stats,
    met: {
      level: metLevel,
      location: metLoc,
      locationName: null, // backlog §10: tabla de ubicaciones por juego
      eggLocation: eggLoc,
      language,
    },
  };
}

class BdspAdapter extends GameAdapter {
  static gameKey = 'BDSP';
  static gameLabel = 'Brilliant Diamond / Shining Pearl';
  static platform = 'Switch';
  static acceptedSizes = ACCEPTED_SIZES;

  static detect(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    if (!ACCEPTED_SIZES.includes(buf.length)) return false;
    return ACCEPTED_REVS.includes(buf[0]);
  }

  static revision(buf) {
    return REV_NAMES[buf[0]] || ('0x' + buf[0].toString(16));
  }

  // PKHeX: SAV8BS.SetChecksums — MD5 sobre el buffer con el campo hash en cero.
  // Nota §7.0.1: dumps de Ryujinx suelen no matchear; informativo, no bloqueante.
  static verifyHash(buf) {
    if (buf.length < HASH_OFFSET + HASH_LEN) return { ok: false };
    const stored = Buffer.from(buf.subarray(HASH_OFFSET, HASH_OFFSET + HASH_LEN));
    const tmp = Buffer.from(buf);
    tmp.fill(0, HASH_OFFSET, HASH_OFFSET + HASH_LEN);
    const calc = crypto.createHash('md5').update(tmp).digest();
    return { ok: stored.equals(calc), stored: stored.toString('hex'), calc: calc.toString('hex') };
  }

  static readTrainer(buf) {
    const o = OFF.MyStatus;
    const ot = readUTF16(buf, o + 0x00, 0x1A);
    const tid = buf.readUInt16LE(o + 0x1C);
    const sid = buf.readUInt16LE(o + 0x1E);
    const money = buf.readUInt32LE(o + 0x20);
    const male = buf[o + 0x24];
    const rom = buf[o + 0x2B];
    const gameClear = buf[o + 0x2C];
    const game = rom === 0 ? 'Brilliant Diamond' : rom === 1 ? 'Shining Pearl' : `Unknown(${rom})`;
    const pt = OFF.PlayTime;
    const playedHours = buf.readUInt16LE(pt);
    const playedMins  = buf[pt + 2];
    const playedSecs  = buf[pt + 3];
    return {
      name: ot,
      tid,
      sid,
      id32: ((sid << 16) >>> 0) | tid,
      money,
      gender: male ? 'Male' : 'Female',
      game,
      badges: buf[o + 0x29],
      champion: !!gameClear,
      playtime: `${playedHours}h ${playedMins}m ${playedSecs}s`,
      rival: readUTF16(buf, 0x55F4, 0x1A),
    };
  }

  static readParty(buf) {
    const out = [];
    const count = buf[OFF.Party + 6 * SIZE_PARTY]; // PartyCount byte
    for (let i = 0; i < 6; i++) {
      const o = OFF.Party + i * SIZE_PARTY;
      const raw = buf.subarray(o, o + SIZE_PARTY);
      if (isSlotEmpty(raw)) continue;
      const data = Buffer.from(raw);
      decryptPB8(data);
      out.push(parsePB8(data, i, true));
    }
    return out;
  }

  static readBoxes(buf) {
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
        slots.push(parsePB8(data, s, false));
      }
      total += slots.length;
      // PKHeX: BoxLayout8b.GetBoxName(box) — readUTF16 desde
      // OFF.BoxLayout + box*0x22. Si la caja nunca fue renombrada el campo
      // está vacío (NUL) → cae al default del juego "BOX N".
      const rawName = readUTF16(buf, OFF.BoxLayout + b * BOX_NAME_LEN, BOX_NAME_LEN);
      boxes.push({ box: b, name: rawName || `BOX ${b + 1}`, count: slots.length, slots });
    }
    return { total, boxes };
  }

  static readBag(buf) {
    const items = [];
    for (let id = 0; id < ITEM_ARRAY_COUNT; id++) {
      const o = OFF.MyItem + id * ITEM_ENTRY_SIZE;
      const count = buf.readInt32LE(o);
      if (count <= 0) continue;
      const favorite = buf.readInt32LE(o + 0x08);
      items.push({
        id,
        name: name('items', id),
        count,
        favorite: !!favorite,
      });
    }
    return items;
  }
}

module.exports = { BdspAdapter, parsePB8 };
