'use strict';

// PKHeX: PKHeX.Core/PKM/Util/PokeCrypto.cs
// Gen6/7/8 PKM crypto: XOR-LCG (LCRNG) + 4-block shuffle, generalizado por
// blockSize/storedSize para soportar PK6/PK7/PB8/PK8.

// PKHeX PokeCrypto.BlockPosition: 24 rows of 4 + 8 duplicate rows so that
// sv = (PV >> 13) & 31 indexes directly without `% 24`.
const BLOCK_POSITION = [
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
  2,0,1,3, 3,0,1,2, 2,0,3,1, 3,0,2,1, 1,2,0,3, 1,3,0,2, 2,1,0,3, 3,1,0,2,
  2,3,0,1, 3,2,0,1, 1,2,3,0, 1,3,2,0, 2,1,3,0, 3,1,2,0, 2,3,1,0, 3,2,1,0,
  // duplicates of rows 0..7 (so sv 24..31 work without %24):
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
];

// PKHeX LCRNG.cs (mult/inc constants).
function cryptArray(buf, seed) {
  let s = seed >>> 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    s = (Math.imul(0x41C64E6D, s) + 0x6073) >>> 0;
    buf.writeUInt16LE((buf.readUInt16LE(i) ^ ((s >>> 16) & 0xFFFF)) & 0xFFFF, i);
  }
}

/**
 * Descifra un PKM Gen6/7/8 in-place.
 * PKHeX: PokeCrypto.Decrypt67 / Decrypt8.
 *
 * @param data        Buffer (stored o party length del formato del gen)
 * @param blockSize   56 (Gen6/7) | 80 (Gen8 / PB8)
 * @param storedSize  0xE8 (Gen6/7) | 0x148 (Gen8)
 */
function decryptPKM(data, blockSize, storedSize) {
  const pv = data.readUInt32LE(0);
  const sv = (pv >>> 13) & 31;

  cryptArray(data.subarray(8, storedSize), pv);
  if (data.length > storedSize) cryptArray(data.subarray(storedSize), pv); // party tail

  const copy = Buffer.from(data.subarray(8, 8 + 4 * blockSize));
  for (let i = 0; i < 4; i++) {
    const src = BLOCK_POSITION[sv * 4 + i];
    copy.copy(data, 8 + i * blockSize, src * blockSize, src * blockSize + blockSize);
  }
}

module.exports = { BLOCK_POSITION, cryptArray, decryptPKM };
