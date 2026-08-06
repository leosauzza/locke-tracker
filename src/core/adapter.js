'use strict';

// Contrato base de los adapters por juego (SPEC §4).
// Cada juego implementa estos static methods. La UI y el JSON de salida son
// idénticos para todos los juegos — solo cambia el adapter.

class GameAdapter {
  /** Clave estable usada en el dropdown y persistencia. */
  static gameKey   = 'BASE';
  static gameLabel = 'Base Game';
  static platform  = 'Switch'; // 'Switch' | '3DS'
  /** Tamaño(s) de archivo aceptados (autodetección rápida). */
  static acceptedSizes = [];

  /** ¿Es este buffer un save de este juego? (checksum/size/magic) */
  static detect(_buf) { return false; }

  /** Verificación de integridad. { ok, stored?, calc? } */
  static verifyHash(_buf) { return { ok: null }; }

  static readTrainer(_buf) { return null; }
  static readParty(_buf)   { return []; }
  static readBoxes(_buf)   { return { total: 0, boxes: [] }; }
  static readBag(_buf)     { return []; }
}

module.exports = { GameAdapter };
