'use strict';

// Bucle de "track" (SPEC §14 — Track & Overlay).
//
// Cada TICK_MS (5s) relee el save seleccionado, extrae el dump canónico y
// pisa `overlay/data.js` (que lee el overlay de OBS). Si la lectura falla
// (ej. el emulador está reescribiendo el save a mitad de camino), se saltea
// el tick y se conserva el último dato bueno — el tracker sigue corriendo.
//
// La función extractNow es compartida con el handler IPC `extract` para que
// la extracción manual y la del track usen exactamente la misma lógica.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const { detectGame, getAdapter } = require('../core');
const { loadNames } = require('../core/names');
const { summarize: nuzlockeSummary } = require('../core/nuzlocke');
const { writeOverlay } = require('./overlay');

const TICK_MS = 5000;

let overlayDir = null;
function getOverlayDir() {
  if (!overlayDir) overlayDir = path.join(app.getPath('userData'), 'overlay');
  return overlayDir;
}

// Devuelve el dump canónico (SPEC §5) o lanza.
// Compartido por el handler `extract` (extracción manual) y el tracker.
function extractNow(filePath, gameKey, toolVersion) {
  const buf = fs.readFileSync(filePath);
  const Adapter = gameKey && gameKey !== 'auto' ? getAdapter(gameKey) : detectGame(buf);
  if (!Adapter) throw new Error('No se pudo detectar el juego. Elegilo manualmente.');

  loadNames();

  let hashValid = null;
  try {
    hashValid = Adapter.verifyHash(buf).ok;
  } catch {
    hashValid = null;
  }

  const boxes = Adapter.readBoxes(buf).boxes;

  return {
    meta: {
      file: path.basename(filePath),
      filePath,
      fileSize: buf.length,
      platform: Adapter.platform,
      gameKey: Adapter.gameKey,
      gameLabel: Adapter.gameLabel,
      revision: typeof Adapter.revision === 'function' ? Adapter.revision(buf) : null,
      hashValid,
      extractedAt: new Date().toISOString(),
      toolVersion,
    },
    trainer: Adapter.readTrainer(buf),
    party:   Adapter.readParty(buf),
    boxes,
    nuzlocke: nuzlockeSummary(boxes),
    bag:     Adapter.readBag(buf),
  };
}

// Estado del tracker.
let timer = null;
let current = null;

function tick() {
  if (!current) return;
  try {
    const dump = extractNow(current.filePath, current.gameKey, current.toolVersion);
    writeOverlay(getOverlayDir(), dump);
    current.lastDump = dump;
    current.lastError = null;
    current.lastUpdatedAt = dump.meta.extractedAt;
  } catch (err) {
    // Reintentamos en el próximo tick; dejamos el último dato bueno.
    current.lastError = err && err.message ? err.message : String(err);
  }
}

function start(filePath, gameKey, toolVersion) {
  if (!filePath) throw new Error('Falta filePath');
  stop();
  current = {
    filePath,
    gameKey,
    toolVersion,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    lastError: null,
    lastDump: null,
  };
  // Primera extracción inmediata (si falla, igual arranca el loop).
  tick();
  timer = setInterval(tick, TICK_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  current = null;
}

function isRunning() {
  return timer !== null;
}

function status() {
  if (!current) {
    return { running: false, overlayDir: getOverlayDir() };
  }
  return {
    running: true,
    filePath: current.filePath,
    gameKey: current.gameKey,
    startedAt: current.startedAt,
    lastUpdatedAt: current.lastUpdatedAt,
    lastError: current.lastError,
    overlayDir: getOverlayDir(),
  };
}

module.exports = {
  start,
  stop,
  status,
  isRunning,
  extractNow,
  getOverlayDir,
  TICK_MS,
};
