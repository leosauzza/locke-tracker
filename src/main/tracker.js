'use strict';

// Bucle de "track" (SPEC §14 — Track & Overlay; plan-data-en-servidor.md).
//
// Cada TICK_MS (5s) relee el save seleccionado, extrae el dump canónico y:
//   - modo `local`  → pisa `overlay/data.js` (overlay para OBS local).
//   - modo `server` → upsert del dump "slim" en MongoDB para esa run.
// Si la lectura/escritura falla (ej. el emulador está reescribiendo el save a
// mitad de camino, o la DB no responde), se saltea el tick y se conserva el
// último dato bueno — el tracker sigue corriendo.
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
const { buildSlim } = require('../core/slim');
const db = require('./db');

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
let ticking = false; // evita ticks superpuestos (escritura DB lenta)

// Normaliza + valida las opciones de salida. Lanza con mensaje claro si algo
// falta (lo atrapa el handler IPC `track:start`).
function normalizeOptions(options) {
  const mode = options && options.mode === 'server' ? 'server' : 'local';
  if (mode !== 'server') {
    return { mode };
  }
  const player = (options.player || '').trim();
  const nuzlocke = (options.nuzlocke || '').trim();
  const mongoUri = (options.mongoUri || '').trim();
  if (!player) throw new Error('Falta el nombre del jugador.');
  if (!nuzlocke) throw new Error('Falta el nombre del nuzlocke.');
  if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
    throw new Error('Connection string inválido (debe empezar con mongodb:// o mongodb+srv://).');
  }
  return { mode, player, nuzlocke, mongoUri };
}

async function tick() {
  if (!current || ticking) return;
  ticking = true;
  try {
    const dump = extractNow(current.filePath, current.gameKey, current.toolVersion);
    if (current.options.mode === 'server') {
      const slim = buildSlim(dump, current.options.player, current.options.nuzlocke);
      await db.upsertRun(current.options.mongoUri, slim);
    } else {
      writeOverlay(getOverlayDir(), dump);
    }
    current.lastDump = dump;
    current.lastError = null;
    current.lastUpdatedAt = dump.meta.extractedAt;
  } catch (err) {
    // Reintentamos en el próximo tick; dejamos el último dato bueno.
    current.lastError = err && err.message ? err.message : String(err);
  } finally {
    ticking = false;
  }
}

function start(filePath, gameKey, toolVersion, options) {
  if (!filePath) throw new Error('Falta filePath');
  stopSync(); // detiene loop anterior (la DB se cierra abajo de forma async)
  const norm = normalizeOptions(options);
  current = {
    filePath,
    gameKey,
    toolVersion,
    options: norm,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    lastError: null,
    lastDump: null,
  };
  // Primera extracción inmediata (si falla, igual arranca el loop).
  tick();
  timer = setInterval(tick, TICK_MS);
  // Las conexiones DB se cachean por URI (db.js): re-trackear con la misma URI
  // las reutiliza, y `stop()` las cierra. Nada que limpiar acá.
}

function stopSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function stop() {
  stopSync();
  current = null;
  await db.close();
}

function isRunning() {
  return timer !== null;
}

function status() {
  if (!current) {
    return { running: false, mode: null, overlayDir: getOverlayDir() };
  }
  return {
    running: true,
    mode: current.options.mode,
    player: current.options.player,
    nuzlocke: current.options.nuzlocke,
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
