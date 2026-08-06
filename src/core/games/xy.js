'use strict';

// Adapter de Pokémon X / Y — 3DS (Gen6, PK6).
// Respeta el contrato del SPEC §4 y el schema §5.
//
// Fuentes PKHeX (source of truth):
//   - Tamaño/detección  : PKHeX.Core/Saves/Util/SaveUtil.cs (SIZE_G6XY, HasSaveFooterBEEF)
//   - Layout del save   : PKHeX.Core/Saves/SAV6XY.cs + Saves/Access/SaveBlockAccessor6XY.cs
//   - Base SAV6 (slots) : PKHeX.Core/Saves/SAV6.cs + SAV_BEEF.cs
//   - Cripto PKM        : PKHeX.Core/PKM/Util/PokeCrypto.cs (Decrypt67)
//   - Campos PK6        : PKHeX.Core/PKM/PK6.cs + PKM/Shared/G6PKM.cs
//   - Trainer/Items/Time: Saves/Substructures/Gen6/{MyStatus6,Misc6XY,PlayTime6}.cs
//   - Personal table    : PKHeX.Core/Resources/byte/personal/personal_xy

const { decryptPKM } = require('../crypto');
const { levelFromExp, GROWTH_NAMES } = require('../exp');
const {
  loadNames, name, ballName, loadPersonal, getPersonal,
  readUTF16, GENDER,
} = require('../names');
const { GameAdapter } = require('../adapter');

// PKHeX: SaveUtil.cs
const SIZE_G6XY = 0x65600; // tamaño de UN slot
const BEEF_MAGIC = 0x42454546; // u32 LE en data[len-0x1F0] (HasSaveFooterBEEF)

// PKHeX: SaveBlockAccessor6XY.BlockMetadataOffset
const BLOCK_META_OFFSET = SIZE_G6XY - 0x200; // 0x65400 (timestamp / Secure Value)

// PKHeX: SAV6XY.cs (Initialize) + SaveBlockAccessor6XY.cs (offsets de bloques)
const OFF = {
  MyItem:   0x00400, // bloque 1  (mochila — pockets por verificar, ver readBag)
  PlayTime: 0x01800, // bloque 6
  Misc:     0x04200, // bloque 11 (money, badges)
  // PKHeX: SaveBlockAccessor6XY.cs bloque 12 (BOX) — BoxLayout6.cs.
  // Nombres de caja al inicio del bloque, ancho 0x22 cada uno.
  BoxLayout:0x04400,
  MyStatus: 0x14000, // bloque 17 (trainer)
  Party:    0x14200, // SAV6XY.Initialize -> PokePartySave
  Box:      0x22600, // bloque 53 (storage)
};

// PKHeX: SAV6.cs (SIZE_STORED/PARTY = PokeCrypto.SIZE_6STORED/PARTY)
const SIZE_STORED = 0xE8;  // 232 (PK6 stored)
const SIZE_PARTY  = 0x104; // 260 (PK6 party = stored + 0x1C battle-stat tail)
const BLOCK_SIZE  = 56;    // 0x38 (PokeCrypto.BlockPosition, Gen6/7)

// PKHeX: SAV6.cs
const BOX_COUNT     = 31;
const SLOTS_PER_BOX = 30;
// PKHeX: SAV6.LongStringLength = 0x22 (34 bytes = 17 UTF-16, NUL-terminated).
// Ancho de cada nombre de caja dentro del bloque BoxLayout (BoxLayout6.cs:
// GetBoxNameOffset(box) = StringMaxByteCount * box = 0x22 * box).
const BOX_NAME_LEN  = 0x22;

const PERSONAL_FILE = 'personal_xy';

// ---------------------------------------------------------------------------
// Selección de slot activo (dump de 3DS: A/B espejados + sección extra).
// PKHeX: SAV_BEEF.TimeStampCurrent (u64 @ BlockMetadataOffset).
// ---------------------------------------------------------------------------
function hasBEEF(slot) {
  return slot.readUInt32LE(slot.length - 0x1F0) === BEEF_MAGIC;
}

// Devuelve el sub-buffer (length SIZE_G6XY) del slot activo.
function activeSlot(buf) {
  if (buf.length === SIZE_G6XY) return buf;
  if (buf.length >= 2 * SIZE_G6XY) {
    const a = buf.subarray(0, SIZE_G6XY);
    const b = buf.subarray(SIZE_G6XY, 2 * SIZE_G6XY);
    const ta = Number(a.readBigUInt64LE(BLOCK_META_OFFSET));
    const tb = Number(b.readBigUInt64LE(BLOCK_META_OFFSET));
    // El slot con timestamp más alto es el activo (escrito más reciente).
    return tb > ta ? b : a;
  }
  return buf;
}

function isSlotEmpty(data) {
  const ec = data.readUInt32LE(0);
  if (ec === 0 || ec === 0xFFFFFFFF) return true;
  return false;
}

// Conteo de bits en un byte (para el campo Badges bitmask de Gen6).
function popcount8(n) {
  n &= 0xFF;
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

function decryptPK6(data) {
  return decryptPKM(data, BLOCK_SIZE, SIZE_STORED);
}

// Normaliza ability number del PKM al schema §5 (1, 2 o 3; 3 = HA).
// PKHeX almacena ability number como bitflag (1=abl1, 2=abl2, 4=HA).
function normalizeAbilityNum(raw) {
  if (raw === 4) return 3;
  if (raw === 2) return 2;
  return 1;
}

// Shiny Gen6+ : (TID^SID^PIDhi^PIDlo) < 16  (PKHeX PKM.IsShiny / GetIsShiny)
function isShiny(tid16, sid16, pid) {
  return ((tid16 ^ sid16 ^ (pid & 0xFFFF) ^ (pid >>> 16)) & 0xFFFF) < 16;
}

// PK6 field map (PK6.cs + G6PKM.cs). Schema §5.1.
// `personalFile` permite reusar este parser desde el adapter ORAS con su propia
// personal table ('personal_ao'). Default: 'personal_xy'.
function parsePK6(data, slot, isParty, personalFile = PERSONAL_FILE) {
  const ec        = data.readUInt32LE(0x00); // EncryptionConstant (seed crypto)
  const species   = data.readUInt16LE(0x08);
  const heldItem  = data.readUInt16LE(0x0A);
  const tid16     = data.readUInt16LE(0x0C);
  const sid16     = data.readUInt16LE(0x0E);
  const exp       = data.readUInt32LE(0x10);
  const ability   = data[0x14];                // u8 (en Gen6 ability es 1 byte)
  const ablRaw    = data[0x15];
  const abilityNum = normalizeAbilityNum(ablRaw);
  const pid       = data.readUInt32LE(0x18);   // PID propio de Gen6 (distinto del EC)
  const nature    = data[0x1C];
  const statusFlag = data[0x1D];
  const isFateful = (statusFlag & 1) === 1;
  const genderBits = (statusFlag >> 1) & 3;
  const form      = statusFlag >> 3;
  const evs = {
    HP: data[0x1E], Atk: data[0x1F], Def: data[0x20],
    Spe: data[0x21], SpA: data[0x22], SpD: data[0x23],
  };

  const nickname = readUTF16(data, 0x40, 0x1A);
  const moves = [
    data.readUInt16LE(0x5A), data.readUInt16LE(0x5C),
    data.readUInt16LE(0x5E), data.readUInt16LE(0x60),
  ];
  const movePP    = [data[0x62], data[0x63], data[0x64], data[0x65]];
  const movePPUps = [data[0x66], data[0x67], data[0x68], data[0x69]];

  const iv32 = data.readUInt32LE(0x74);
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

  const htName = readUTF16(data, 0x78, 0x1A);
  const otName = readUTF16(data, 0xB0, 0x1A);
  const otGender = data[0xDD] >> 7;
  const metByte  = data[0xDD];
  const metLevel = metByte & 0x7F;
  const metLoc   = data.readUInt16LE(0xDA);
  const eggLoc   = data.readUInt16LE(0xD8);
  const ball     = data[0xDC];
  const gameVer  = data[0xDF];
  const language = data[0xE3];

  // Party-only cached battle stats (null en caja — schema §5.1 nota).
  let level = null, stats = null;
  if (isParty && data.length >= SIZE_PARTY) {
    level = data[0xEC];
    stats = {
      HP:  data.readUInt16LE(0xF2), // Stat_HPMax
      Atk: data.readUInt16LE(0xF4),
      Def: data.readUInt16LE(0xF6),
      Spe: data.readUInt16LE(0xF8),
      SpA: data.readUInt16LE(0xFA),
      SpD: data.readUInt16LE(0xFC),
    };
  }

  const personal = getPersonal(loadPersonal(personalFile), species) || { growth: 0, abilities: [] };
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
    shiny: isShiny(tid16, sid16, pid),
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
      locationName: null, // backlog §10
      eggLocation: eggLoc,
      language,
    },
  };
}

class XyAdapter extends GameAdapter {
  static gameKey = 'XY';
  static gameLabel = 'Pokémon X / Y';
  static platform = '3DS';
  static acceptedSizes = [SIZE_G6XY];

  static detect(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    if (buf.length === SIZE_G6XY) return hasBEEF(buf);
    if (buf.length >= 2 * SIZE_G6XY) {
      // dump con 2 slots (A/B)
      const a = buf.subarray(0, SIZE_G6XY);
      return hasBEEF(a);
    }
    return false;
  }

  // Gen6 no tiene revision byte como BDSP.
  static revision(_buf) { return null; }

  // Verificación del magic BEEF (informativo). El sistema BEEF tiene checksums
  // por bloque; una validación completa requeriría iterar AllBlocks (backlog).
  static verifyHash(buf) {
    const slot = activeSlot(buf);
    if (slot.length < SIZE_G6XY) return { ok: false };
    return { ok: hasBEEF(slot) };
  }

  static readTrainer(buf) {
    const slot = activeSlot(buf);
    const st = OFF.MyStatus;       // MyStatus6 block
    const tid = slot.readUInt16LE(st + 0x00);
    const sid = slot.readUInt16LE(st + 0x02);
    const game = slot[st + 0x04];
    const gender = slot[st + 0x05];
    const ot = readUTF16(slot, st + 0x48, 0x1A);

    // PlayTime6 (MyStatus6.cs): hours u16 @ 0x00, min u8 @ 0x02, sec u8 @ 0x03
    const pt = OFF.PlayTime;
    const playedHours = slot.readUInt16LE(pt);
    const playedMins  = slot[pt + 2];
    const playedSecs  = slot[pt + 3];

    // Misc6XY: Money u32 @ 0x08, Badges u8 @ 0x0C.
    // En Gen6 el byte de Badges es una MÁSCARA DE BITS (1 bit por medalla),
    // igual que ORAS. El conteo real es popcount(byte). PKHeX devuelve el byte
    // crudo (Misc6XY.Badges), pero para mostrar usamos el conteo.
    const ms = OFF.Misc;
    const money = slot.readUInt32LE(ms + 0x08);
    const badges = popcount8(slot[ms + 0x0C]);

    return {
      name: ot,
      tid,
      sid,
      id32: ((sid << 16) >>> 0) | tid,
      money,
      gender: gender ? 'Female' : 'Male',
      game: gameLabel(game),
      badges,
      champion: null, // requiere event flags (no inventar)
      playtime: `${playedHours}h ${playedMins}m ${playedSecs}s`,
      rival: null,    // no hay campo directo de rival en XY (no inventar)
    };
  }

  static readParty(buf) {
    const slot = activeSlot(buf);
    const out = [];
    const count = slot[OFF.Party + 6 * SIZE_PARTY]; // PartyCount byte (SAV6.PartyCount)
    for (let i = 0; i < 6; i++) {
      const o = OFF.Party + i * SIZE_PARTY; // SAV6.GetPartyOffset
      const raw = slot.subarray(o, o + SIZE_PARTY);
      if (isSlotEmpty(raw)) continue;
      const data = Buffer.from(raw);
      decryptPK6(data);
      out.push(parsePK6(data, i, true));
    }
    return out;
  }

  static readBoxes(buf) {
    const slot = activeSlot(buf);
    const boxes = [];
    let total = 0;
    for (let b = 0; b < BOX_COUNT; b++) {
      const slots = [];
      for (let s = 0; s < SLOTS_PER_BOX; s++) {
        // SAV6.GetBoxOffset = Box + SIZE_STORED * box * 30
        const o = OFF.Box + (b * SLOTS_PER_BOX + s) * SIZE_STORED;
        const raw = slot.subarray(o, o + SIZE_STORED);
        if (isSlotEmpty(raw)) continue;
        const data = Buffer.from(raw);
        decryptPK6(data);
        slots.push(parsePK6(data, s, false));
      }
      total += slots.length;
      // PKHeX: BoxLayout6.GetBoxName(box) — readUTF16 desde
      // OFF.BoxLayout + box*0x22. Caja sin renombrar → campo vacío → default "BOX N".
      const rawName = readUTF16(slot, OFF.BoxLayout + b * BOX_NAME_LEN, BOX_NAME_LEN);
      boxes.push({ box: b, name: rawName || `BOX ${b + 1}`, count: slots.length, slots });
    }
    return { total, boxes };
  }

  // Mochila Gen6 (PKHeX: SaveBlockAccessor6XY -> bloque MyItem @ OFF.MyItem,
  // len 0xB88). Cada entry = InventoryItem base (4 bytes: id u16 + count u16,
  // PKHeX Saves/Substructures/Inventory/Item/InventoryItem.cs).
  // Los pockets (Items / KeyItems / TMHM / Berries / BattleItems) son regiones
  // contiguas dentro del bloque; como el schema §5 no requiere distinguirlos,
  // recorremos el bloque linealmente y reportamos toda entry no-cero.
  // Gen6 no tiene flag de "favorite" (eso es Gen7+ / IItemFavorite) → false.
  static readBag(buf) {
    const slot = activeSlot(buf);
    // Acumula por itemID (un mismo item puede aparecer en varios pockets).
    const byId = new Map();
    const ENTRY = 4;
    const ENTRIES = 0xB88 / ENTRY; // 738 — cubre los 5 pockets del bloque MyItem
    for (let i = 0; i < ENTRIES; i++) {
      const o = OFF.MyItem + i * ENTRY;
      if (o + ENTRY > slot.length) break;
      const id = slot.readUInt16LE(o);
      const count = slot.readUInt16LE(o + 2);
      if (id === 0 || count === 0) continue;
      if (id > 0x7FF) continue; // sanity: descarta entries que no son items
      byId.set(id, (byId.get(id) || 0) + count);
    }
    const items = [...byId.entries()]
      .map(([id, count]) => ({ id, name: name('items', id), count, favorite: false }))
      .sort((a, b) => a.id - b.id);
    return items;
  }
}

// GameVersion enum (PKHeX): X = 24, Y = 25. Mapeo del byte MyStatus6.Game.
function gameLabel(gameByte) {
  if (gameByte === 24) return 'Pokémon X';
  if (gameByte === 25) return 'Pokémon Y';
  return `Pokémon X/Y (#${gameByte})`;
}

module.exports = { XyAdapter, parsePK6, activeSlot, popcount8 };
