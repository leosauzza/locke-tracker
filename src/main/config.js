'use strict';

// Persistencia de la configuración del usuario (plan-data-en-servidor.md §3.5).
// Se guarda en `app.getPath('userData')/config.json`: modo de salida, datos del
// servidor (player, nuzlocke, mongoUri) y último archivo/juego usados.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = Object.freeze({
  mode: 'local',     // 'local' | 'server'
  player: '',
  nuzlocke: '',
  mongoUri: '',
  filePath: '',
  gameKey: 'auto',
});

let cached = null;
let configPathCache = null;

function configPath() {
  if (!configPathCache) {
    configPathCache = path.join(app.getPath('userData'), 'config.json');
  }
  return configPathCache;
}

/** Devuelve la config merged con defaults (cacheada en memoria). */
function load() {
  if (cached) return { ...cached };
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    cached = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cached = { ...DEFAULTS };
  }
  return { ...cached };
}

/** Guarda la config (merged con defaults) y la devuelve. */
function save(cfg) {
  cached = { ...DEFAULTS, ...(cfg || {}) };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cached, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
  return { ...cached };
}

module.exports = { load, save, DEFAULTS };
