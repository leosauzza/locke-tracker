'use strict';

// Acceso a MongoDB para el modo `server` del tracker (plan-data-en-servidor.md).
// Conexión cacheada por URI (la app es single-user, normalmente una sola URI).
// Colección: `players` en DB `locke-tracker`. Identidad de la run: `_id` =
// `${player}::${nuzlocke}` (ver `src/core/slim.js`).

const { MongoClient } = require('mongodb');

const DB_NAME = 'locke-tracker';
const COLLECTION = 'players';

// Map uri -> { client, db, connecting: Promise<client> }
const clients = new Map();

/**
 * Devuelve { client, db } conectados a la URI. Cachea la conexión: si se llama
 * otra vez con la misma URI (cada tick de 5s), reutiliza el client.
 * Si la conexión falla, se descarta del cache para poder reintentar.
 *
 * @param {string} uri connection string de MongoDB.
 */
async function connect(uri) {
  if (!uri) throw new Error('Falta connection string de MongoDB.');
  let entry = clients.get(uri);
  if (!entry) {
    const client = new MongoClient(uri);
    const connecting = client.connect();
    entry = { client, db: null, connecting };
    clients.set(uri, entry);
    // Si falla, limpiamos el cache para que el próximo intento vuelva a probar.
    connecting.catch(() => clients.delete(uri));
  }
  const client = await entry.connecting;
  if (!entry.db) entry.db = client.db(DB_NAME);
  return entry;
}

/**
 * Hace upsert del documento slim en `players`. El `_id` va en el filtro (igualdad)
 * y NO en el `$set`: así funciona tanto para insert (Mongo usa el `_id` del
 * filtro) como para update de un doc existente (no se toca el campo inmutable).
 *
 * @param {string} uri
 * @param {object} slim resultado de `buildSlim`.
 */
async function upsertRun(uri, slim) {
  const { db } = await connect(uri);
  const coll = db.collection(COLLECTION);
  const doc = { ...slim };
  const { _id } = doc;
  delete doc._id;
  await coll.updateOne({ _id }, { $set: doc }, { upsert: true });
}

/**
 * Valida conectividad: conecta y manda un `ping`. No escribe. Devuelve
 * `{ ok: true }` o `{ ok: false, error }`. Usado por el botón "Probar conexión".
 *
 * @param {string} uri
 */
async function ping(uri) {
  try {
    const { client } = await connect(uri);
    await client.db(DB_NAME).command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Cierra todos los clients cacheados. Lo llama `track:stop`.
 */
async function close() {
  const entries = [...clients.values()];
  clients.clear();
  await Promise.all(entries.map((e) => e.client.close().catch(() => {})));
}

module.exports = { connect, upsertRun, ping, close, DB_NAME, COLLECTION };
