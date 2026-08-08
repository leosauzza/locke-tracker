'use strict';

// Construye el documento "slim" que se guarda en MongoDB cuando el tracker
// corre en modo `server` (plan-data-en-servidor.md §2).
//
// Es lógica pura sobre el dump canónico (SPEC §5): no toca el save ni depende
// de Electron, así que corre en Node puro y es trivial de testear
// (`node --test`). Se llama desde `src/main/tracker.js` en cada tick.
//
// Identidad de la run: `player + nuzlocke`. `gameLabel` queda como dato
// informativo (no es parte de la clave).

/**
 * @typedef {Object} SlimPartyMember
 * @property {number} species
 * @property {string} speciesName
 * @property {string} nickname
 * @property {number} level
 * @property {boolean} shiny
 *
 * @typedef {Object} SlimDoc
 * @property {string} _id        `${player}::${nuzlocke}`
 * @property {string} player
 * @property {string} nuzlocke
 * @property {string} gameLabel  informativo
 * @property {string} platform   informativo (layout del overlay frontend)
 * @property {SlimPartyMember[]} party
 * @property {number} deadCount
 * @property {string} updatedAt
 */

/**
 * Arma el documento slim a persistir.
 *
 * @param {object} dump      dump canónico (SPEC §5).
 * @param {string} player    nombre del jugador.
 * @param {string} nuzlocke  nombre del nuzlocke (identifica la run).
 * @returns {SlimDoc}
 */
function buildSlim(dump, player, nuzlocke) {
  const p = String(player == null ? '' : player).trim();
  const n = String(nuzlocke == null ? '' : nuzlocke).trim();

  const party = Array.isArray(dump && dump.party)
    ? dump.party.map((m) => ({
        species: m.species,
        speciesName: m.speciesName,
        nickname: m.nickname,
        level: m.level,
        shiny: !!m.shiny,
      }))
    : [];

  const deadBox = dump && dump.nuzlocke && dump.nuzlocke.deadBox;
  const deadCount = deadBox && typeof deadBox.count === 'number' ? deadBox.count : 0;

  return {
    _id: `${p}::${n}`,
    player: p,
    nuzlocke: n,
    gameLabel: (dump && dump.meta && dump.meta.gameLabel) || '',
    platform: (dump && dump.meta && dump.meta.platform) || '',
    party,
    deadCount,
    updatedAt: (dump && dump.meta && dump.meta.extractedAt) || new Date().toISOString(),
  };
}

module.exports = { buildSlim };
