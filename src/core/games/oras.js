'use strict';

// Adapter de Pokémon Omega Ruby / Alpha Sapphire — 3DS (Gen6, PK6).
// Respeta el contrato del SPEC §4 y el schema §5.
//
// La cripto PK6, el parser de campos y la selección de slot A/B son idénticos a
// XY (mismo Gen6) y se reutilizan desde `xy.js`. Lo único que cambia es el
// layout del save (offsets y tamaño) y la personal table.
//
// Fuentes PKHeX (source of truth):
//   - Tamaño/detección  : PKHeX.Core/Saves/Util/SaveUtil.cs (SIZE_G6ORAS, IsG6AO)
//   - Layout del save   : PKHeX.Core/Saves/SAV6AO.cs (Initialize) +
//                         PKHeX.Core/Saves/Access/SaveBlockAccessor6AO.cs
//   - Base SAV6 (slots) : PKHeX.Core/Saves/SAV6.cs + SAV_BEEF.cs
//   - Cripto PKM        : PKHeX.Core/PKM/Util/PokeCrypto.cs (Decrypt67)
//   - Campos PK6        : PKHeX.Core/PKM/PK6.cs + PKM/Shared/G6PKM.cs
//   - Trainer/Items/Time: Saves/Substructures/Gen6/{MyStatus6,Misc6AO,PlayTime6}.cs
//   - Personal table    : PKHeX.Core/Resources/byte/personal/personal_ao

const { decryptPKM } = require('../crypto');
const { name, readUTF16 } = require('../names');
const { GameAdapter } = require('../adapter');
// Reutiliza el parser de campos PK6 desde el adapter XY (ambos Gen6, formato
// PK6). La cripto y el shape del PKM son idénticos entre XY y ORAS.
const { parsePK6 } = require('./xy');

// PKHeX: SaveUtil.cs
const SIZE_G6ORAS = 0x76000; // tamaño de UN slot (mayor que XY: trae SecretBase/EonTicket/JPEG extra)
const BEEF_MAGIC = 0x42454546; // u32 LE en data[len-0x1F0] (HasSaveFooterBEEF)

// PKHeX: SaveBlockAccessor6AO.BlockMetadataOffset = SIZE_G6ORAS - 0x200
const BLOCK_META_OFFSET = SIZE_G6ORAS - 0x200; // 0x75E00 (timestamp / Secure Value)

// PKHeX: SAV6AO.cs (Initialize) + SaveBlockAccessor6AO.cs (offsets de bloques).
// Comparado con XY, los únicos offsets que cambían son Box y JPEG (ambos al
// final del save por los bloques extra PSS/EonTicket/SecretBase).
const OFF = {
  MyItem:   0x00400, // bloque 01 (mochila — len 0xB90, ver readBag)
  PlayTime: 0x01800, // bloque 06
  Misc:     0x04200, // bloque 11 (money, badges) — Misc6AO.cs
  // PKHeX: SaveBlockAccessor6AO.cs bloque 12 (BOX) — BoxLayout6.cs.
  // Nombres de caja al inicio del bloque, ancho 0x22 cada uno.
  BoxLayout:0x04400,
  MyStatus: 0x14000, // bloque 17 (trainer) — MyStatus6.cs (común a XY/ORAS)
  Party:    0x14200, // SAV6AO.Initialize -> PokePartySave (bloque 18)
  Box:      0x33000, // bloque 56 (storage) — distinto a XY (0x22600)
};

// PKHeX: SAV6.cs (SIZE_STORED/PARTY = PokeCrypto.SIZE_6STORED/PARTY)
const SIZE_STORED = 0xE8;  // 232 (PK6 stored)
const SIZE_PARTY  = 0x104; // 260 (PK6 party = stored + 0x1C battle-stat tail)
const BLOCK_SIZE  = 56;    // 0x38 (PokeCrypto.BlockPosition, Gen6/7)

// PKHeX: SAV6.cs (BoxCount = 31; Box layout 30 slots/box con SIZE_STORED).
const BOX_COUNT     = 31;
const SLOTS_PER_BOX = 30;
// PKHeX: SAV6.LongStringLength = 0x22 (34 bytes = 17 UTF-16, NUL-terminated).
// Ancho de cada nombre de caja dentro del bloque BoxLayout (BoxLayout6.cs:
// GetBoxNameOffset(box) = StringMaxByteCount * box = 0x22 * box).
const BOX_NAME_LEN  = 0x22;

const PERSONAL_FILE = 'personal_ao';

// Tamaño del bloque MyItem en ORAS (SaveBlockAccessor6AO.cs bloque 01 = 0xB90).
// 4 bytes/entry (u16 id + u16 count — InventoryPouch4.cs).
const MYITEM_LEN = 0xB90;
const ITEM_ENTRY = 4;

// ---------------------------------------------------------------------------
// Selección de slot activo (dump 3DS: A/B espejados + sección extra).
// PKHeX: SAV_BEEF.TimeStampCurrent (u64 @ BlockMetadataOffset).
// ---------------------------------------------------------------------------
function hasBEEF(slot) {
  return slot.readUInt32LE(slot.length - 0x1F0) === BEEF_MAGIC;
}

// Devuelve el sub-buffer (length SIZE_G6ORAS) del slot activo.
function activeSlot(buf) {
  // Tamaño único (slot suelto, sin espejo): retorna tal cual.
  if (buf.length === SIZE_G6ORAS) return buf;
  // Dump con 2 slots A/B (Checkpoint/JKSM "main"): elige por timestamp mayor.
  if (buf.length >= 2 * SIZE_G6ORAS) {
    const a = buf.subarray(0, SIZE_G6ORAS);
    const b = buf.subarray(SIZE_G6ORAS, 2 * SIZE_G6ORAS);
    const ta = Number(a.readBigUInt64LE(BLOCK_META_OFFSET));
    const tb = Number(b.readBigUInt64LE(BLOCK_META_OFFSET));
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

// Descifra un PK6 in-place (reusa crypto.js con constantes Gen6).
// PKHeX: PokeCrypto.Decrypt67 (blockSize=56, storedSize=0xE8).
function decryptPK6(data) {
  return decryptPKM(data, BLOCK_SIZE, SIZE_STORED);
}

class OrasAdapter extends GameAdapter {
  static gameKey = 'ORAS';
  static gameLabel = 'Omega Ruby / Alpha Sapphire';
  static platform = '3DS';
  static acceptedSizes = [SIZE_G6ORAS];

  // PKHeX: IsG6AO -> data.Length == SIZE_G6ORAS && HasSaveFooterBEEF(data).
  static detect(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    if (buf.length === SIZE_G6ORAS) return hasBEEF(buf);
    if (buf.length >= 2 * SIZE_G6ORAS) {
      const a = buf.subarray(0, SIZE_G6ORAS);
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
    if (slot.length < SIZE_G6ORAS) return { ok: false };
    return { ok: hasBEEF(slot) };
  }

  static readTrainer(buf) {
    const slot = activeSlot(buf);
    // MyStatus6.cs (común a XY/ORAS): TID u16 @ 0x00, SID u16 @ 0x02,
    // Game u8 @ 0x04, Gender u8 @ 0x05, OT (UTF-16LE) @ 0x48 (0x1A bytes).
    const st = OFF.MyStatus;
    const tid = slot.readUInt16LE(st + 0x00);
    const sid = slot.readUInt16LE(st + 0x02);
    const game = slot[st + 0x04];
    const gender = slot[st + 0x05];
    const ot = readUTF16(slot, st + 0x48, 0x1A);

    // PlayTime6: hours u16 @ 0x00, min u8 @ 0x02, sec u8 @ 0x03.
    const pt = OFF.PlayTime;
    const playedHours = slot.readUInt16LE(pt);
    const playedMins  = slot[pt + 2];
    const playedSecs  = slot[pt + 3];

    // Misc6AO.cs: Money u32 @ 0x08, Badges u8 @ 0x0C (mismos offsets que XY).
    // A diferencia de BDSP (donde el byte es un conteo directo), en Gen6 el
    // byte de Badges es una MÁSCARA DE BITS (1 bit por medalla). PKHeX
    // (Misc6AO.Badges) devuelve el byte crudo, pero el conteo real para mostrar
    // es popcount(byte). Verificado: save de Leon (ORAS completado) tiene 0xFF
    // en este offset -> popcount = 8 medallas.
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
      rival: null,    // ORAS no expone rival directo en MyStatus (no inventar)
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
      out.push(parsePK6(data, i, true, PERSONAL_FILE));
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
        slots.push(parsePK6(data, s, false, PERSONAL_FILE));
      }
      total += slots.length;
      // PKHeX: BoxLayout6.GetBoxName(box) — readUTF16 desde
      // OFF.BoxLayout + box*0x22. Caja sin renombrar → campo vacío → default "BOX N".
      const rawName = readUTF16(slot, OFF.BoxLayout + b * BOX_NAME_LEN, BOX_NAME_LEN);
      boxes.push({ box: b, name: rawName || `BOX ${b + 1}`, count: slots.length, slots });
    }
    return { total, boxes };
  }

  // Mochila Gen6 (PKHeX: SaveBlockAccessor6AO -> bloque MyItem @ OFF.MyItem,
  // len 0xB90). Cada entry = InventoryPouch4 (4 bytes: id u16 + count u16).
  // Los pockets son regiones contiguas dentro del bloque; el schema §5 no
  // requiere distinguirlos, así que recorremos linealmente y reportamos toda
  // entry no-cero. Gen6 no tiene flag de "favorite" → false.
  static readBag(buf) {
    const slot = activeSlot(buf);
    const byId = new Map();
    const ENTRIES = MYITEM_LEN / ITEM_ENTRY; // 740 — cubre todos los pockets
    for (let i = 0; i < ENTRIES; i++) {
      const o = OFF.MyItem + i * ITEM_ENTRY;
      if (o + ITEM_ENTRY > slot.length) break;
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

// GameVersion enum (PKHeX Core/Game/Enums/GameVersion.cs):
// AS = 26 (Alpha Sapphire), OR = 27 (Omega Ruby). Mapeo del byte MyStatus6.Game.
function gameLabel(gameByte) {
  if (gameByte === 27) return 'Omega Ruby';
  if (gameByte === 26) return 'Alpha Sapphire';
  return `Omega Ruby / Alpha Sapphire (#${gameByte})`;
}

module.exports = { OrasAdapter, activeSlot, SIZE_G6ORAS, popcount8 };
