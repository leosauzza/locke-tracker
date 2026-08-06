'use strict';

// Punto de entrada del núcleo: registro de adapters + autodetección (SPEC §4.1).
// `src/core/**` no importa nada de Electron.

const { BdspAdapter } = require('./games/bdsp');
const { XyAdapter } = require('./games/xy');
const { OrasAdapter } = require('./games/oras');

const ADAPTERS = [
  BdspAdapter,
  XyAdapter,
  OrasAdapter,
];

const BY_KEY = new Map(ADAPTERS.map((A) => [A.gameKey, A]));

function listGames() {
  return ADAPTERS.map((A) => ({
    gameKey: A.gameKey,
    gameLabel: A.gameLabel,
    platform: A.platform,
  }));
}

function getAdapter(gameKey) {
  if (!gameKey) return null;
  return BY_KEY.get(gameKey) || null;
}

function detectGame(buf) {
  const hits = ADAPTERS.filter((A) => {
    try { return A.detect(buf); } catch { return false; }
  });
  if (hits.length === 1) return hits[0];
  return null; // ambiguo o desconocido → la UI pide al usuario que elija
}

module.exports = { ADAPTERS, listGames, getAdapter, detectGame };
