# PLAN — Modo servidor (MongoDB) para `locke-tracker`

> Parte **A** del plan general (escritor). El lector/frontend vive en el repo
> `locke-data-viewer` (ver su `PLAN.md`).

## 1. Objetivo

Agregar al tracker un **modo de salida**, elegible desde la UI:

- `local` → genera `overlay.html` local (comportamiento actual). **Por defecto.**
- `server` → escribe cada run en **MongoDB**.

Los dos modos son **mutuamente excluyentes**. En modo `server` el usuario
completa:

- **Nombre del jugador** (`player`)
- **Nuzlocke name** (`nuzlocke`)
- **Connection string** de MongoDB (input tipo contraseña, con **checkbox
  "Mostrar"** que alterna `password`/`text`)

Además:

- Hay un botón **"Probar conexión"** que valida conectividad + `ping`
  (no inicia el track).
- El track arranca **solo al presionar "Trackear"** (como hoy).

## 2. Contrato de datos (compartido con el frontend)

Documento por run, clave `{ player, nuzlocke }`, en DB `locke-tracker` /
colección `players` (índice único `{ player: 1, nuzlocke: 1 }`).

```jsonc
{
  "_id": "leo::con-amigos",            // = `${player}::${nuzlocke}`
  "player": "leo",
  "nuzlocke": "con-amigos",
  "gameLabel": "Brilliant Diamond / Shining Pearl",  // informativo (no es parte de la clave)
  "platform": "Switch",                // layout del /equipo (3DS=izq, Switch=centro)
  "party": [
    { "species": 394, "speciesName": "Prinplup", "nickname": "Pingo", "level": 31, "shiny": false }
    // ... hasta 6
  ],
  "deadCount": 5,                      // nuzlocke.deadBox?.count ?? 0
  "updatedAt": "2026-08-06T12:00:00.000Z"
}
```

> **Identidad:** la run se identifica por `player + nuzlocke`. Si un mismo
> jugador cambia de juego dentro del mismo nuzlocke, se **actualiza el mismo
> documento** (no se crea uno nuevo). `gameLabel` queda como dato informativo.

## 3. Tareas

### 3.1 Dependencia
- `npm install mongodb` (en `dependencies` — va al bundle portable de
  electron-builder).

### 3.2 `src/core/slim.js` (sin Electron, testeable)
```js
function buildSlim(dump, player, nuzlocke) {
  return {
    _id: `${player}::${nuzlocke}`,
    player,
    nuzlocke,
    gameLabel: dump.meta.gameLabel,
    platform: dump.meta.platform,
    party: (dump.party || []).map((p) => ({
      species: p.species,
      speciesName: p.speciesName,
      nickname: p.nickname,
      level: p.level,
      shiny: !!p.shiny,
    })),
    deadCount: dump.nuzlocke?.deadBox?.count ?? 0,
    updatedAt: dump.meta.extractedAt,
  };
}
module.exports = { buildSlim };
```
> Respeta la "regla de oro" del SPEC (`core/**` sin imports de Electron) →
> testeable con `node --test`.

### 3.3 `test/slim.test.js`
- Cubrir `buildSlim` usando el `output.json` de ejemplo (o un dump
  canónico armado a mano).
- Aserciones: `_id === "${player}::${nuzlocke}"`, `party` mapea solo los 5
  campos, `deadCount` toma `nuzlocke.deadBox?.count ?? 0`.

### 3.4 `src/main/db.js`
- `connect(uri)` → `MongoClient` con **instancia cacheada** (reutiliza entre
  ticks).
- `upsertRun(uri, slim)` →
  `players.updateOne({ player, nuzlocke }, { $set: slim }, { upsert: true })`.
- `ping(uri)` → `connect` + `db.command({ ping: 1 })`; devuelve `{ ok: true }`
  o `{ ok: false, error }`. **No escribe.**
- `close()` → cierra el `MongoClient` (lo llama `track:stop`).

### 3.5 `src/main/config.js` (nuevo)
- Persiste en `app.getPath('userData')/config.json`: `mode`, `player`,
  `nuzlocke`, `mongoUri`, y último `filePath`/`gameKey`.
- Se carga al iniciar la app y se guarda al cambiar la config.

### 3.6 `src/main/tracker.js`
- `start(filePath, gameKey, toolVersion, options)` donde
  `options = { mode, player, nuzlocke, mongoUri }`.
- `tick()`:
  - `mode === 'local'` → `writeOverlay(...)` (igual que hoy).
  - `mode === 'server'` → `buildSlim(dump, player, nuzlocke)` +
    `db.upsertRun(mongoUri, slim)`.
  - Ante error de escritura **no se mata el loop** (conserva último dato
    bueno, igual que el comportamiento actual).
- `stop()` cierra el `MongoClient` si estaba abierto.

### 3.7 `src/preload/preload.js` + `src/main/ipc.js`
- `trackStart(filePath, gameKey, options)` (options con `mode/player/nuzlocke/mongoUri`).
- Handlers nuevos: `db:test` (ping), `config:get`, `config:set`.

### 3.8 UI (`src/renderer/`)
- Selector **Modo de salida**: `Overlay local` | `Servidor (MongoDB)`.
- En `Servidor` mostrar:
  - **Nombre del jugador** (text, requerido)
  - **Nuzlocke name** (text, requerido)
  - **Connection string** (`type="password"` por defecto) + **checkbox
    "Mostrar"** que toggglea a `type="text"`.
  - Botón **Probar conexión** → llama `dbTest(uri)`, muestra OK/mensaje de
    error (no inicia track).
  - Botón **Trackear** (existente) → arranca el track con la config actual.
    Solo habilitado si `player` + `nuzlocke` + `mongoUri` son válidos (en
    modo server) o si hay `filePath` (en local).
- Validación: `player` y `nuzlocke` no vacíos; `mongoUri` con esquema
  `mongodb://` o `mongodb+srv://`.
- El panel del overlay local (path + preview) **solo se muestra en modo
  `local`**.

### 3.9 `SPEC.md`
- Agregar sección **"Modo servidor"** documentando todo lo anterior (obligatorio
  según §12 — "cualquier cambio de arquitectura debe actualizarse acá primero").

### 3.10 `electron-builder.yml`
- Verificar que `mongodb` (en `node_modules`) quede dentro de los `files`
  empaquetados (lo está por defecto).

## 4. Infra (setup fuera del código)

- **MongoDB Atlas M0 (gratuito)**: cluster + DB `locke-tracker`.
- **2 users**: uno *read-write* (esta app) y uno *read-only* (el frontend).
- Network access `0.0.0.0/0` (las functions del frontend corren en Vercel con
  IPs dinámicas; igual conviene abrirlo para no tener problemas).

## 5. Consideraciones y riesgos

- **Connection string en el `.exe`:** queda embebido en el binario portable.
  Aceptable para este uso, pero **documentarlo**. El frontend usa user
  **read-only** para minimizar exposición.
- **Colisión de runs:** si dos personas usan el mismo `player+nuzlocke`, se
  pisan. Por ahora se documenta; futuro: `player+nuzlocke+token`.
- **"Probar conexión"** no garantiza permisos de escritura (solo ping). Si el
  user de escritura no tiene permisos, el primer tick del track fallará y se
  verá en el estado del panel — sin matar el loop.
- **Tamaño/frecuencia:** ~1–2 KB por upsert cada 5s → despreciable.
- **Compatibilidad:** el modo `local` queda **intacto** (sin riesgo de
  regresión para los usuarios actuales).

## 6. Verificación

- `npm test` (`buildSlim` + mock de `db.ping`/`db.upsertRun`).
- Smoke test: trackear `bdsp-save-example.bin` en modo `server` contra Atlas y
  ver el documento creado/actualizado en la colección `players`.

## 7. Checklist de ejecución

1. `npm install mongodb`
2. `src/core/slim.js` + `test/slim.test.js`
3. `src/main/db.js` (`connect`, `upsertRun`, `ping`, `close`)
4. `src/main/config.js` (persistencia en `userData`)
5. `src/main/tracker.js` (modo + branch + `buildSlim`)
6. `src/main/ipc.js` + `src/preload/preload.js` (`track:start` con options,
   `db:test`, `config:*`)
7. UI: selector de modo, campos (`player`, `nuzlocke`, connection string con
   checkbox mostrar, botón Probar conexión), Track
8. Actualizar `SPEC.md` (sección "Modo servidor")
9. Verificar `electron-builder.yml`
