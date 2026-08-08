# SPEC — PokéSave Extractor (GUI)

Especificación técnica para que futuros agentes puedan extender el proyecto.
Documento fuente de verdad: **cualquier implementación debe respetar este spec**,
y **cualquier cambio de arquitectura debe actualizarse acá primero**.

Idioma: la prosa está en español; identificadores de código, APIs y nombres de
archivos en inglés (igual que el código existente).

---

## 1. Objetivo

Aplicación de escritorio que, dado un archivo de guardado de un juego de Pokémon
(3DS o Switch), extrae la información del save (entrenador, equipo, cajas,
mochila) y la devuelve como JSON estructurado y legible.

### Flujo de uso
1. El usuario abre la app.
2. Selecciona el archivo de guardado (diálogo nativo del SO).
3. Selecciona el juego (dropdown: BDSP / ORAS / XY … o "Detectar
   automáticamente").
4. Presiona **Extraer**.
5. La app muestra un resumen legible y permite descargar/guardar el JSON.

### No-objetivos (out of scope, al menos por ahora)
- Editar / reescribir el save.
- Sincronización en la nube, cuentas, multiusuario.
- Acceso remoto vía navegador.
- Generación de QR o exportación a Showdown (podría agregarse después).

---

## 2. Decisión de arquitectura

**Stack: Electron + Node.js + frontend HTML/CSS/JS Vanilla (o framework liviano).**

Justificación:
- El parser ya está en Node.js (`extract.js`). En Electron corre directo en el
  *main process*, **sin capa HTTP ni serialización extra**.
- Para una herramienta local de un solo usuario, el **diálogo nativo de archivos**
  (`dialog.showOpenDialog`) es muy superior a un `<input type="file">` del
  browser: permite mostrar/editar la ruta, recordar la última carpeta y soportar
  archivos grandes sin cargarlos en memoria del renderer.
- Los saves son datos personales: que todo corra offline y local es una
  cualidad, no una limitación.

### 2.1 Empaquetado → **ejecutable portable** (prioridad)

Usar [`electron-builder`](https://www.electron.build/) con target **`portable`**
para Windows: produce **un único `.exe`** que se auto-extrae a `%TEMP%` y corre
sin instalar y sin permisos de administrador. Es justo lo que pidió el usuario.

| Plataforma | Target `electron-builder` | Resultado |
|------------|---------------------------|-----------|
| Windows (prioridad) | `portable` | `PokeSaveExtractor-<ver>.exe` (un archivo, sin install) |
| Windows (fallback)  | `nsis`     | Instalador `.exe` (si `portable` da problemas de toolchain) |
| Linux    | `AppImage` | Un archivo ejecutable |
| macOS    | `dmg`      | (Requiere firma/notarización para distribuir; opcional) |

> Si el compilador de `portable` rompe en el entorno de build, **caerá a `nsis`**
> (instalador) — es un fallback aceptable, no un bloqueador.

---

## 3. Estructura del repositorio (actual → objetivo)

### Estado actual (referencia BDSP funcional)
```
locke-tracker/
├─ bdsp-save-example.bin     # save de ejemplo (BDSP v1.3)
├─ oras-save-example         # save de ejemplo (ORAS)
├─ xy-save-example           # save de ejemplo (XY)
├─ extract.js                # parser BDSP de referencia (CLI)
├─ output.json               # ejemplo de salida del CLI (generado, gitignored)
└─ data/
   ├─ species_en.txt         # tablas de nombres (reutilizables Gen6+)
   ├─ moves_en.txt
   ├─ abilities_en.txt
   ├─ natures_en.txt
   ├─ items_en.txt
   ├─ types_en.txt
   └─ personal_bdsp          # personal table BDSP (por juego)
```

### Estructura objetivo
```
locke-tracker/
├─ package.json              # electron, electron-builder, scripts
├─ electron-builder.yml      # config de packaging (target portable)
├─ src/
│  ├─ main/                  # Electron main process
│  │  ├─ index.js            # crea ventana, registra IPC handlers
│  │  └─ ipc.js              # handlers: openFileDialog, extract
│  ├─ preload/
│  │  └─ preload.js          # contextBridge: API segura renderer↔main
│  ├─ renderer/              # frontend (UI)
│  │  ├─ index.html
│  │  ├─ styles.css
│  │  └─ app.js
│  └─ core/                  # Lógica de parseo (sin dependencias de Electron)
│     ├─ crypto.js           # LCG + block-shuffle Gen6/7/8 (compartido)
│     ├─ names.js            # carga de data/*.txt + lookups
│     ├─ exp.js              # tablas EXP + levelFromExp (compartido)
│     ├─ nuzlocke.js         # stats derivadas (caja "muertos") — SPEC §5.2
│     ├─ adapter.js          # interfaz/contrato de los adapters
│     ├─ index.js            # detectGame(buf) + getAdapter(gameKey)
│     └─ games/
│        ├─ bdsp.js          # ← refactor de extract.js (HECHO)
│        ├─ oras.js          # Gen6 ORAS (HECHO)
│        └─ xy.js            # Gen6 XY (HECHO)
├─ data/                     # tablas de nombres + personal tables (por juego)
│  ├─ species_en.txt ... types_en.txt
│  ├─ personal_bdsp
│  ├─ personal_ao            # ORAS (HECHO)
│  └─ personal_xy            # XY   (HECHO)
├─ bdsp-save-example.bin     # save de ejemplo
├─ oras-save-example         # save de ejemplo
├─ xy-save-example           # save de ejemplo
└─ SPEC.md                   # este archivo
```

> **Regla de oro:** `src/core/**` no debe importar nada de Electron. Así el
> núcleo es testeable en Node puro (`node --test`) y reutilizable.

---

## 4. Contrato del adapter (extensibilidad por juego)

Cada juego implementa este contrato. La UI y el JSON de salida son idénticos
para todos los juegos — solo cambia el adapter.

```js
// src/core/adapter.js
/**
 * @typedef {Object} Pokemon   // ver §5 para el schema completo
 * @typedef {Object} Trainer
 * @typedef {Object} Box
 * @typedef {Object} BagItem
 */

class GameAdapter {
  /** Clave estable usada en el dropdown y persistencia. */
  static gameKey   = 'BDSP';          // 'BDSP' | 'ORAS' | 'XY' | ...
  static gameLabel = 'Brilliant Diamond / Shining Pearl';
  static platform  = 'Switch';        // 'Switch' | '3DS'
  /** Tamaño(s) de archivo aceptados (para autodetección rápida). */
  static acceptedSizes = [0xEF0A4, 0xEED8C, 0xEDC20, 0xE9828];

  /** ¿Es este buffer un save de este juego? (checksum/size/magic) */
  static detect(buf) { /* return boolean */ }

  /** Verificación de integridad. Siempre devuelve objeto; .ok puede ser false. */
  static verifyHash(buf) { /* return { ok: boolean, stored?: string, calc?: string } */ }

  static readTrainer(buf) { /* return Trainer */ }
  static readParty(buf)   { /* return Pokemon[] */ }
  static readBoxes(buf)   { /* return { total: number, boxes: Box[] } */ }
  static readBag(buf)     { /* return BagItem[] */ }
}
```

### 4.1 Autodetección (`src/core/index.js`)
```js
const ADAPTERS = [BdspAdapter, OrasAdapter, XyAdapter];
function detectGame(buf) {
  const hits = ADAPTERS.filter(A => A.detect(buf));
  if (hits.length === 1) return hits[0];
  return null; // ambiguo o desconocido → la UI pide al usuario que elija
}
```
Orden de prioridad: probar `detect()` por tamaño primero (barato) y luego por
magic/checksum si hace falta.

---

## 5. Schema del JSON de salida (contrato estable)

**Este schema es canónico y compartido por todos los juegos.** Los campos que no
apliquen a un juego van en `null` (nunca se omiten) para no romper consumers.

```jsonc
{
  "meta": {
    "file": "bdsp-save-example.bin",
    "fileSize": 979108,
    "platform": "Switch",
    "gameKey": "BDSP",
    "gameLabel": "Brilliant Diamond / Shining Pearl",
    "revision": "v1.3",
    "hashValid": null,        // boolean | null (null = no aplica / no verificable)
    "extractedAt": "2026-08-04T12:00:00.000Z",
    "toolVersion": "0.1.0"
  },
  "trainer": {
    "name": "Leo",
    "tid": 65308,
    "sid": 6058,
    "id32": 397082396,
    "money": 83394,
    "gender": "Male",
    "game": "Brilliant Diamond",
    "badges": 2,
    "champion": false,
    "playtime": "11h 44m 21s",
    "rival": "Barry"
  },
  "party": [ /* Pokemon[] (hasta 6) */ ],
  "boxes": [
    { "box": 0, "name": "BOX 1", "count": 30, "slots": [ /* Pokemon[] */ ] }
  ],
  "nuzlocke": {
    "deadBox": { "index": 17, "name": "Muertos", "count": 5 }  // o null
  },
  "bag": [
    { "id": 4, "name": "Poké Ball", "count": 24, "favorite": false }
  ]
}
```

### 5.2 Schema de la sección `nuzlocke`
Estadísticas derivadas para Nuzlocke, calculadas en `extractNow` (tracker.js) a
partir de `boxes` — **no** las produce el adapter. Lógica pura en
`src/core/nuzlocke.js` (sin Electron, testeable en Node).

```jsonc
{
  "deadBox": {              // caja "de muertos" (donde van los Pokémon caídos)
    "index": 17,            // índice 0-based dentro de `boxes`
    "name": "Muertos",      // nombre tal cual está en el save
    "count": 5              // cantidad de Pokémon en esa caja
  }                         // null si no existe ninguna caja con ese nombre
}
```

Match: case-insensitive + trim, por **igualdad exacta** (no subcadena, para no
matchear "no muertos" ni "muertos2"). Nombres que cuentan como caja de muertos
(`DEAD_BOX_NAMES` en `nuzlocke.js`): `"muertos"` (es) y `"dead"` (en). El
helper `findDeadBox(boxes, deadBoxNames?)` acepta un override de nombres para
extenderlo (ej. `"cementerio"`). Si el jugador no renombró ninguna caja, o el
save no es de un Nuzlocke, `deadBox` es `null`.

> Origen del feature: para un Nuzlocke se suele renombrar una caja del PC a
> "muertos" y mover ahí los Pokémon inhabilitados por perder todo su HP. Este
> conteo expone ese dato directamente en el dump.

### 5.1 Schema del objeto `Pokemon` (canónico)
Todos los juegos deben producir este shape. Campo = `null` si no aplica.

```jsonc
{
  "slot": 0,
  "species": 394,
  "speciesName": "Prinplup",
  "nickname": "Pingo",
  "form": 0,
  "level": 31,
  "exp": 24294,
  "growth": 3,
  "growthName": "Medium-Slow",
  "nature": 24,
  "natureName": "Quirky",
  "gender": "Male",                 // "Male" | "Female" | "Genderless"
  "ability": 3,
  "abilityName": "Torrent",
  "abilityNum": 1,                  // 1, 2 o 3 (3 = habilidad oculta)
  "isHiddenAbility": false,
  "heldItem": 251,
  "heldItemName": "Mystic Water",
  "ball": 4,
  "ballName": "Master Ball",
  "pid": "0x63071E2B",
  "tid": 65308,
  "sid": 6058,
  "id32": 397082396,
  "ot": { "name": "Leo", "gender": "Male" },
  "htName": null,
  "shiny": false,
  "isEgg": false,
  "isNicknamed": false,
  "isFateful": false,
  "moves": [
    { "id": 206, "name": "False Swipe", "pp": 40, "ppUps": 0, "maxPp": 40 }
  ],
  "ivs":  { "HP": 31, "Atk": 31, "Def": 21, "Spe": 10, "SpA": 31, "SpD": 19 },
  "evs":  { "HP": 11, "Atk": 12, "Def": 13, "Spe": 24, "SpA": 12, "SpD": 11 },
  "stats": { "HP": null, "Atk": null, "Def": null, "Spe": null, "SpA": null, "SpD": null },
  "met": { "level": 5, "location": 434, "locationName": null, "eggLocation": 0, "language": 2 }
}
```

Notas:
- `stats` sólo se llena para Pokémon en equipo (cache de batalla). En caja → `null`.
- `locationName` queda `null` hasta que se agregue la tabla de ubicaciones por
  juego (ver §10).
- `level` en caja se **calcula** desde `exp` + `growth`; en equipo se lee cacheado.

---

## 6. Cripto compartido (Gen 6 / 7 / 8) — **ya implementado en BDSP**

Todos los PKM de Gen 6 en adelante usan el **mismo** esquema de cifrado. El código
actual de `extract.js` (`cryptArray` + unshuffle) es **reutilizable tal cual**,
generalizando el tamaño de bloque. Esto es la piedra angular del proyecto.

```js
// src/core/crypto.js  (extraído y generalizado de extract.js)
const BLOCK_POSITION = [
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
  2,0,1,3, 3,0,1,2, 2,0,3,1, 3,0,2,1, 1,2,0,3, 1,3,0,2, 2,1,0,3, 3,1,0,2,
  2,3,0,1, 3,2,0,1, 1,2,3,0, 1,3,2,0, 2,1,3,0, 3,1,2,0, 2,3,1,0, 3,2,1,0,
  // 8 filas duplicadas (24→32) para evitar `% 24` con sv=(PV>>13)&31
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
];

// LCG Pokémon (mult/inc constantes desde PKHeX LCRNG.cs)
function cryptArray(buf, seed) {
  let s = seed >>> 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    s = (Math.imul(0x41C64E6D, s) + 0x6073) >>> 0;
    buf.writeUInt16LE((buf.readUInt16LE(i) ^ ((s >>> 16) & 0xFFFF)) & 0xFFFF, i);
  }
}

/**
 * Descifra un PKM Gen6/7/8 in-place.
 * @param data        Buffer (length === stored o party del formato del gen)
 * @param blockSize   56 (Gen6/7) | 80 (Gen8 / PB8)
 * @param storedSize  0xE8 (Gen6/7) | 0x148 (Gen8)
 */
function decryptPKM(data, blockSize, storedSize) {
  const pv = data.readUInt32LE(0);
  const sv = (pv >>> 13) & 31;
  cryptArray(data.subarray(8, storedSize), pv);
  if (data.length > storedSize) cryptArray(data.subarray(storedSize), pv); // party tail, re-seed PV
  const copy = Buffer.from(data.subarray(8, 8 + 4 * blockSize));
  for (let i = 0; i < 4; i++) {
    const src = BLOCK_POSITION[sv * 4 + i];
    copy.copy(data, 8 + i * blockSize, src * blockSize, src * blockSize + blockSize);
  }
}
```

| Gen | Formato | blockSize | storedSize | partySize | Adapter |
|-----|---------|-----------|------------|-----------|---------|
| 6 (XY/ORAS) | PK6 | **56** (0x38) | 0xE8 | 0x104 | `oras.js` ✓, `xy.js` ✓ |
| 7 (Sol/Luna…) | PK7 | 56 | 0xE8 | 0x104 | futuro |
| 8b (BDSP) | PB8 | **80** (0x50) | 0x148 | 0x158 | `bdsp.js` ✓ |

> **Referencia fuente de verdad:** `PKHeX.Core/PKM/Util/PokeCrypto.cs`
> (`Decrypt67`, `Decrypt8`, `CryptArray`, `BlockPosition`).

### 6.1 Strings (Gen 6/7/8)
UTF-16LE con terminador `0x0000`, 12 chars máx. para nickname/OT (trash de 26
bytes). La función `readUTF16(buf, offset, maxBytes)` actual ya es genérica.

---

## 7. Adapters — estado y guía por juego

### 7.0 BDSP (Switch) — ✅ HECHO (referencia)
Migrar `extract.js` a `src/core/games/bdsp.js` respetando el contrato del §4 y el
schema del §5. Offsets verificados contra el save real:

| Bloque | Offset | Observaciones |
|--------|--------|---------------|
| MyItem (mochila) | `0x0563C` | arreglo plano de 3000 entradas × 0x10; índice = itemID |
| Party | `0x14098` | 6 × 0x158; PartyCount byte en `0x14098 + 6*0x158` |
| BoxLayout | `0x148AA` | nombres de cajas (40 × 0x22 UTF-16), wallpaper, battle teams |
| Box (storage) | `0x14EF4` | 40 cajas × 30 slots × **0x158** (formato party!) |
| MyStatus | `0x79BB4` | OT, TID/SID, dinero, juego, medallas |
| PlayTime | `0x79C04` | hours u16, minutes u8, seconds u8 |
| MD5 | `0xE9818` | 16 bytes (ver §7.0.1) |

Fuente: `PKHeX.Core/Saves/SAV8BS.cs`. Detección: tamaño en
`{0xE9828, 0xEDC20, 0xEED8C, 0xEF0A4}` + `buf[0]` ∈ `{0x25,0x2C,0x32,0x34}`.

PKM = **PB8** (`0x148`/`0x158`, blockSize 80). Campo offsets en
`PKHeX.Core/PKM/PB8.cs` y `G8PKM.cs` (ya documentados en `extract.js`).

#### 7.0.2 Nombres de caja (BoxLayout)
`readBoxes()` lee el nombre real de cada caja desde `BoxLayout + box*0x22`
(`PKHeX BoxLayout8b.GetBoxName`). Campo UTF-16LE NUL-terminated, ancho 0x22
(34 bytes = 17 UTF-16, 16 chars + NUL; `SAV6.LongStringLength`). Cajas nunca
accedidas por el jugador quedan vacías en el save → fallback `"BOX {n+1}"`.
Esto permite leer nombres custom (caso de uso Nuzlocke: caja "MUERTOS").

#### 7.0.1 Hash MD5
PKHeX calcula MD5 sobre todo el buffer con el campo de 16 bytes en `0xE9818`
puesto en cero (`SAV8BS.SetChecksums`). **Observación importante:** los dumps de
Ryujinx rara vez matchean este digest aunque los datos estén intactos, así que
`verifyHash()` debe devolver el resultado pero la UI debe mostrarlo como
**informativo**, nunca como error que bloquee la extracción. (`hashValid` puede
quedar como booleano; el `meta.hashValid: null` se reserva para juegos sin hash.)

### 7.1 ORAS (3DS) — ✅ HECHO
- PKM = **PK6** (`0xE8`/`0x104`, blockSize **56**). Usa `crypto.js` con
  `blockSize=56, storedSize=0xE8`. La lógica de parseo de campos PK6 y la
  selección de slot A/B se **reutilizan** desde `xy.js` (`parsePK6`,
  `decryptPK6`), ya que ambos son Gen6 con formato PK6 idéntico.
- Save container 3DS: el dump ("main" de Checkpoint/JKSM) trae **dos slots
  espejados (A/B) + sección extra**. `activeSlot(buf)` elige el activo por
  `TimeStampCurrent` (u64 @ `BlockMetadataOffset`), igual que XY.
- Offsets verificados contra PKHeX (`SAV6AO.cs` + `SaveBlockAccessor6AO.cs`):

  | Bloque | Offset | Observaciones |
  |--------|--------|---------------|
  | MyItem (mochila) | `0x00400` | bloque 01, len **0xB90** (≠ XY: 0xB88); entries InventoryPouch4 (4 bytes: id u16 + count u16) |
  | PlayTime | `0x01800` | bloque 06 (hours u16, minutes u8, seconds u8) |
  | Misc (money/badges) | `0x04200` | bloque 11 — Misc6AO.cs: Money u32 @ 0x08, Badges u8 @ 0x0C |
  | BoxLayout | `0x04400` | bloque 12 — BoxLayout6.cs: 31 nombres de caja × 0x22 UTF-16, luego wallpapers/flags |
  | MyStatus | `0x14000` | bloque 17 — MyStatus6.cs (común a XY/ORAS) |
  | Party | `0x14200` | SAV6AO.Initialize() PokePartySave (bloque 18); PartyCount byte @ Party + 6*0x104 |
  | Box | `0x33000` | bloque 56 (storage) — **distinto a XY** (0x22600) |
  | BlockMetadataOffset | `0x75E00` | `SIZE_G6ORAS - 0x200` (TimeStampCurrent u64) |

- Detección: `buf.length == SIZE_G6ORAS && HasSaveFooterBEEF(buf)` — magic
  `0x42454546` u32 LE en `len - 0x1F0`.
- `SIZE_G6ORAS = 0x76000` (483328 bytes, mayor que XY por bloques extra:
  SecretBase/EonTicket/JPEG).
- `BOX_COUNT = 31` (SAV6.BoxCount, común a XY/ORAS).
- Mapeo `MyStatus6.Game`: `AS = 26`, `OR = 27` (PKHeX `GameVersion.cs`).
- Items/movimientos/habilidades/nombres: **reutilizan** `data/*.txt` (líneas
  hasta `MaxSpeciesID_6 = 721` válidas). Personal table: `data/personal_ao`
  (66080 bytes = 972 entries × 0x44, incluye Primal/Mega forms).
- Verificado contra save real `oras-save-example` (Alpha Sapphire, entrenador Leon,
  57 Pokémon en cajas, 6 en equipo con Sharpedo+Sharpedonite, 8 medallas).
  Tests de detección + regression en `test/core.test.js`.
- **Badges en Gen6 (XY/ORAS) son BITMASK, no conteo.** El byte `Misc.Badges`
  (@ +0x0C) tiene 1 bit por medalla (0xFF = 8 medallas, post-élite). PKHeX
  (`Misc6AO.Badges` / `Misc6XY.Badges`) devuelve el byte crudo; nosotros
  aplicamos `popcount8()` para reportar el conteo. BDSP en cambio usa un
  byte de conteo directo (sin popcount). Helper `popcount8` exportado desde
  `xy.js` y `oras.js`.
- **Nombres de caja** leídos del save (`BoxLayout6.GetBoxName`): nombre N en
  `0x04400 + N*0x22` UTF-16LE NUL-terminated. En ORAS el juego precarga los
  defaults localizados ("Caja N" en español); el fallback `"BOX {n+1}"` sólo
  aplica si el campo está vacío. Mecanismo general en §7.0.2.

### 7.2 XY (3DS) — ✅ HECHO
- Idéntico mecanismo que ORAS (Gen6, PK6) **pero con layout de save distinto** y
  tamaño `SIZE_G6XY` (más chico que ORAS).
- Fuentes PKHeX:
  - `PKHeX.Core/Saves/SAV6XY.cs`
  - `PKHeX.Core/Saves/Access/SaveBlockAccessor6XY.cs` (offsets de bloques)
  - `PKHeX.Core/Resources/byte/personal/personal_xy` — personal table
  - Resto (crypto, slots, PK6) igual que ORAS.
- Offsets verificados contra PKHeX (`SAV6XY.cs` + `SaveBlockAccessor6XY.cs`):

  | Bloque | Offset | Observaciones |
  |--------|--------|---------------|
  | MyItem (mochila) | `0x00400` | bloque 01, len **0xB88** (≠ ORAS: 0xB90); entries 4 bytes (id u16 + count u16) |
  | PlayTime | `0x01800` | bloque 06 (hours u16, minutes u8, seconds u8) |
  | Misc (money/badges) | `0x04200` | bloque 11 — Misc6XY.cs: Money u32 @ 0x08, Badges u8 @ 0x0C (bitmask, popcount) |
  | BoxLayout | `0x04400` | bloque 12 — BoxLayout6.cs: 31 nombres de caja × 0x22 UTF-16 (igual que ORAS) |
  | MyStatus | `0x14000` | bloque 17 — MyStatus6.cs |
  | Party | `0x14200` | SAV6XY.Initialize() PokePartySave (bloque 18); PartyCount byte @ Party + 6*0x104 |
  | Box | `0x22600` | bloque 53 (storage) — **distinto a ORAS** (0x33000) |
  | BlockMetadataOffset | `0x65400` | `SIZE_G6XY - 0x200` (TimeStampCurrent u64) |

- `SIZE_G6XY = 0x65600` (415232 bytes). `BOX_COUNT = 31`. Detección:
  `buf.length == SIZE_G6XY && HasSaveFooterBEEF(buf)`.
- Nombres de caja: mismo mecanismo que ORAS (ver §7.0.2 / §7.1) —
  `BoxLayout6.GetBoxName` lee `BoxLayout + box*0x22` UTF-16LE NUL-terminated.

### 7.3 Futuros (no en scope inicial)
Let's Go (Gen7b/LGPE, `PA8`), Sword/Shield (Gen8, `PK8`), Legends Arceus (Gen8a,
`PA8`), Scarlet/Violet (Gen9, `PK9`), Sol/Luna/USUM (Gen7, `PK7`). El diseño por
adapters hace que agregarlos sea **un archivo nuevo en `src/core/games/`** + su
personal table, sin tocar la UI.

---

## 8. Capa Electron

### 8.1 Main process (`src/main/`)
Responsabilidades:
- Crear la `BrowserWindow`.
- Registrar handlers IPC (abajo).
- Ejecutar el parseo en el main (tiene acceso al filesystem y al core Node).
- **Nunca** exponer `require`/fs al renderer.

### 8.2 Contrato IPC (preload expone `window.api`)
```js
// src/preload/preload.js  (contextBridge)
contextBridge.exposeInMainWorld('api', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  extract: (filePath, gameKey) => ipcRenderer.invoke('extract', filePath, gameKey),
  saveJson: (defaultName, json) => ipcRenderer.invoke('dialog:saveJson', defaultName, json),
});
```

```js
// src/main/ipc.js
ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Seleccionar archivo de guardado',
    filters: [{ name: 'Pokémon Save', extensions: ['bin','dat','main','sav','*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('extract', async (_e, filePath, gameKey) => {
  const buf = fs.readFileSync(filePath);
  const Adapter = gameKey && gameKey !== 'auto'
    ? getAdapter(gameKey)
    : detectGame(buf);
  if (!Adapter) return { error: 'No se pudo detectar el juego. Elegilo manualmente.' };
  const dump = {
    meta: { /* §5 */ },
    trainer: Adapter.readTrainer(buf),
    party:  Adapter.readParty(buf),
    boxes:  Adapter.readBoxes(buf),
    bag:    Adapter.readBag(buf),
  };
  return dump;
});

ipcMain.handle('dialog:saveJson', async (_e, defaultName, json) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters:[{name:'JSON',extensions:['json']}] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, json);
  return r.filePath;
});
```

> **Seguridad:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox:
> true`. Solo el preload expone `window.api`.

### 8.3 Renderer (`src/renderer/`) — UI/UX
Layout simple de **3 pasos**:

```
┌─ PokéSave Extractor ──────────────────────────────┐
│  Archivo:  [C:\...\bdsp-save-example.bin] [Examinar…]   │
│  Juego:    [ Detectar automáticamente ▼ ]         │
│                                                     │
│            [        Extraer        ]               │
└────────────────────────────────────────────────────┘
```

Requisitos de UX:
- Tras elegir archivo, si la autodetección funciona, **pre-seleccionar** el juego
  y mostrar una nota "Detectado: BDSP".
- El botón **Extraer** se deshabilita hasta haber elegido archivo + juego.
- Durante el parseo: spinner/estado "Extrayendo…" (el parseo es síncrono y
  rápido, igual conviene mostrar feedback).
- Resultado:
  - Vista en tabs/panel: **Resumen** (entrenador + conteos), **Equipo**,
    **Cajas**, **Mochila**, **JSON** (árbol/textarea).
  - Botón **Guardar JSON** → `dialog:saveJson`.
  - Botón **Copiar JSON** al portapapeles.
- Errores (juego no soportado, archivo corrupto): banner claro, no crash.

Stack de frontend: **HTML+CSS+JS vanilla** es suficiente y cero dependencias. Si
se quiere algo más rico, **permitido pero justificar**: opciones razonables son
Preact (3KB) o Lit. Evitar frameworks pesados (Angular, etc.) para no inflar el
binario.

---

## 9. Empaquetado y distribución

`package.json` (resumen):
```jsonc
{
  "name": "pokesave-extractor",
  "version": "0.1.0",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test test/",
    "dist": "electron-builder",
    "dist:win": "electron-builder --win portable",
    "dist:win-installer": "electron-builder --win nsis"
  },
  "devDependencies": { "electron": "^34", "electron-builder": "^25" }
}
```

`electron-builder.yml`:
```yaml
appId: com.locketracker.pokesave
productName: PokeSave Extractor
directories: { output: dist }
files: [ "src/**", "data/**", "package.json" ]
win:
  target:
    - target: portable      # prioridad: un solo .exe sin instalar
      arch: [x64]
nsis:
  oneClick: false            # fallback si portable falla
```

> Recordatorio de la decisión del usuario: **portable primero**. Si la toolchain
> del build se rompe por `portable`, usar `npm run dist:win-installer` (nsis) —
> es un fallback aceptable, no bloqueador.

Salida esperada en `dist/`:
- `PokeSave Extractor 0.1.0.exe` (portable, ~80–120 MB por el runtime de Electron).

## 9.1 Track & Overlay (streaming en vivo)

### Objetivo
Mientras se juega, releer el save cada `TICK_MS = 5000ms` y mantener un
**overlay HTML 1920×1080** que se pueda usar como *Browser Source* en OBS para
mostrar el equipo (con sprites desde PokeAPI) sobre el juego + webcam.

### Arquitectura
- **`src/main/tracker.js`**: loop con `setInterval(tick, 5000)`. Cada tick
  llama a `extractNow(filePath, gameKey, toolVersion)` (compartido con el
  handler IPC `extract`) y, si no falla, pisa el overlay. Si la lectura falla
  (ej. el emulador está reescribiendo el save a mitad de camino), **saltea el
  tick y conserva el último dato bueno** — el loop no muere.
- **`src/main/overlay.js`**: escribe en `app.getPath('userData')/overlay/`:
  - `data.js` — `window.__TRACK_DATA = {...};` (pisado cada tick, atómico).
  - `overlay.html` — template standalone 1920×1080. Se escribe **una sola
    vez** (preserva customizaciones del usuario: fondo, layout, webcam).
  - `overlay.template.html` — siempre fresco, por si se quiere restaurar.
- **Renderer**: botón **Track** al lado de **Extraer**. Al presionar:
  - arranca el loop y el botón cambia a **Stop** (rojo);
  - aparece el panel "Overlay en vivo" con el path a `overlay.html` y botones
    **Abrir carpeta** / **Preview** (este último abre una `BrowserWindow`
    1920×1080 escalada a 960×540).

### Cómo se actualiza el overlay sin parpadeo
El overlay se carga como `file://` en OBS (CEF). fetch/XHR a `file://` desde un
page `file://` está bloqueado por Chromium por default. Por eso el overlay usa
un `<script src="data.js?t=...">` que se reemplaza cada 3&nbsp;s
(cache-buster). El script asigna `window.__TRACK_DATA` y el handler `onload`
renderiza. Resultado: sin reload, sin parpadeo, sin CORS.

### Layout del overlay (1920×1080) — **variante por plataforma**
El layout del `.party` se elige automáticamente según `dump.meta.platform`:

- **3DS (XY/ORAS)**: equipo alineado a la **izquierda** (`left: 60px`,
  `justify-content: flex-start`). Deja libre la columna derecha para la
  pantalla táctil de la 3DS u otra source.
- **Switch (BDSP)**: equipo **centrado respecto del game-area**. El party bar
  ocupa `left: 60px; width: 1500px` (= ancho total − webcam − márgenes) y usa
  `justify-content: center`, así el equipo se centra sobre la zona donde va
  el juego y no respecto a los 1920 px totales.

```
3DS:                              Switch:
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ game      │webcam│          │   │        game        │webcam│ │
│           └──────┘          │   │                    └──────┘ │
│ ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐    │   │   ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐ │
│ │p ││p ││p ││p ││p ││p │    │   │   │p ││p ││p ││p ││p ││p │ │
│ └──┘└──┘└──┘└──┘└──┘└──┘    │   │   └──┘└──┘└──┘└──┘└──┘└──┘ │
│ ↑ izquierda      ↑ libre    │   │        ↑ centrado en game    │
└─────────────────────────────┘   └─────────────────────────────┘
```
- Fondo transparente por defecto (game capture va debajo en OBS). El usuario
  puede poner `bg.png` en la carpeta del overlay y descomentar la línea de
  `background` en `body` (documentado en el propio `overlay.html`).
- Sprites: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/
  pokemon/other/official-artwork/[shiny/]{species}.png` (vía species ID).
  Shiny usa subdirectorio. Formas especiales no mapeadas (TODO).
- Versionado del template: `overlay.version` guarda `OVERLAY_VERSION` y
  `overlay.platform` la plataforma. Cuando cambia alguno, se reescribe
  `overlay.html` (con backup `.bak`) para repartir mejoras de layout y
  alternar entre variantes 3DS/Switch al cambiar de juego, sin pisar
  customizaciones dentro de la misma versión+plataforma. El template se
  construye con `buildOverlayHtml(platform)` (`src/main/overlay.js`).

### IPC nuevo (preload expone `window.api`)
```js
trackStart:     (filePath, gameKey) => ipcRenderer.invoke('track:start', ...)
trackStop:      ()                => ipcRenderer.invoke('track:stop')
trackStatus:    ()                => ipcRenderer.invoke('track:status')
trackOpenFolder:()                => ipcRenderer.invoke('track:openFolder')
trackPreview:   ()                => ipcRenderer.invoke('track:preview')
```

### Ubicación de archivos generados
Todo bajo `app.getPath('userData')/overlay/`:
- `overlay.html` (editablhe por el usuario)
- `data.js` (regenerado cada tick, no editar)
- `overlay.template.html`, `overlay.version` (informativos)

### 9.2 Modo servidor (MongoDB)
> Doc de referencia: `plan-data-en-servidor.md`. El frontend consumidor vive en
> el repo aparte `locke-data-viewer`.

El tracker soporta dos **modos de salida**, **mutuamente excluyentes**, elegidos
en la UI (selector `Modo`):

- `local` (default): genera el `overlay.html` local (§9.1). Sin cambios.
- `server`: en cada tick hace **upsert** de la run en MongoDB. El overlay local
  queda deshabilitado en este modo.

En modo `server` el usuario completa:
- **Nombre del jugador** (`player`)
- **Nuzlocke name** (`nuzlocke`) — identifica la run (disambigua cuando un mismo
  jugador lleva varias, ej. `con-amigos` vs `creadores-youtube`).
- **Connection string** de MongoDB — input `type="password"` con **checkbox
  "Mostrar"** que toggglea a `text`.
- Botón **Probar conexión** → `db.ping` (conecta + `ping:1`, no escribe).
- El track arranca con el botón **Track** (como siempre).

#### Identidad y schema del documento
La run se identifica por **`player + nuzlocke`** (`gameLabel` es informativo, no
parte de la clave). DB `locke-tracker`, colección `players`; `_id` =
`` `${player}::${nuzlocke}` ``. El upsert filtra por `_id` y `$set` el resto.

```jsonc
{
  "_id": "leo::con-amigos",
  "player": "leo",
  "nuzlocke": "con-amigos",
  "gameLabel": "Brilliant Diamond / Shining Pearl",  // informativo
  "platform": "Switch",            // layout del overlay del frontend
  "party": [
    { "species": 394, "speciesName": "Prinplup", "nickname": "Pingo", "level": 31, "shiny": false }
  ],
  "deadCount": 5,                  // nuzlocke.deadBox?.count ?? 0
  "updatedAt": "2026-08-06T12:00:00.000Z"
}
```

#### Archivos nuevos / cambiados
- `src/core/slim.js` — `buildSlim(dump, player, nuzlocke)`. Puro Node, testeable.
- `src/main/db.js` — `connect`/`upsertRun`/`ping`/`close`. `MongoClient` cacheado
  por URI.
- `src/main/config.js` — persiste `mode`, `player`, `nuzlocke`, `mongoUri` y
  último `filePath`/`gameKey` en `userData/config.json`.
- `src/main/tracker.js` — `start(filePath, gameKey, toolVersion, options)`; `tick`
  rama por `options.mode` (`local` → `writeOverlay`, `server` →
  `buildSlim` + `db.upsertRun`). Errores de escritura no matan el loop.
  `stop()` cierra el `MongoClient`.
- IPC nuevo: `db:test` (ping), `config:get`, `config:set`. `track:start` ahora
  recibe `options`. `track:stop` es async (cierra la DB).

#### Seguridad
El connection string queda **embebido en el `.exe` portable**. Recomendado:
crear **dos users** en MongoDB Atlas — *read-write* para esta app y **read-only**
para el frontend (`locke-data-viewer`). Network access `0.0.0.0/0` porque el
frontend corre serverless en Vercel.

---

## 10. Mejoras opcionales (backlog, no bloqueantes)
- Tablas de **nombres de ubicaciones** por juego (rellenar `met.locationName`).
  Fuentes: `PKHeX.Core/Resources/text/locations/`.
- **Cálculo de stats** para Pokémon de caja (requiere fórmula de stats + personal
  info base; PKHeX `PKM/Stats/`).
- Tipos del Pokémon (type1/type2 ya están en el personal table; exponerlos).
- **Comparador de saves** (dos archivos → diff de equipo/cajas; útil para
  Nuzlocke, que parece ser el origen del repo "locke-tracker").
- Drag & drop del archivo sobre la ventana.
- Recordar último directorio usado (`electron-store` o un JSON en `app.getPath('userData')`).
- i18n (los `data/*_es.txt` ya existen en PKHeX para localizar nombres).

---

## 11. Testing

- `src/core/**` debe tener **tests unitarios en Node puro** (`node --test`).
  - `crypto.test.js`: descifrar un PB8/PK6 conocido y asertar species/nickname.
    Fixtures: usar los `.pb8` de muestra en
    `PKHeX/Tests/PKHeX.Core.Tests/Legality/Legal/Generation 8/` como vectores
    canónicos.
  - Por adapter: `bdsp.test.js`, `oras.test.js`, `xy.test.js` con un save
    minimalista y aserciones sobre el JSON canonical.
- Test de contrato: que **todos** los adapters devuelvan exactamente las keys del
  schema §5 (un helper `assertPokemonShape(p)`).
- El parser actual ya se probó contra `bdsp-save-example.bin` real de BDSP y produjo datos
  coherentes (entrenador Leo, 6 Pokémon, 43 en cajas, 113 ítems) — usar eso como
  snapshot de regresión para BDSP.

---

## 12. Reglas para futuros agentes (checklist obligatorio)

1. **Leer este spec completo** antes de tocar código.
2. **No hardcoded magic numbers sin cita.** Cada offset/constante de un juego debe
   tener un comentario `// PKHeX: <archivo>:<línea>` o, mínimo, el nombre del
   archivo fuente.
3. **Reutilizar `crypto.js`** para cualquier PKM Gen6+. No reimplementar LCG ni
   tablas de shuffle.
4. **Respetar el schema §5 exacto.** Campo no aplicable → `null`, nunca omitir.
5. **`src/core/` sin imports de Electron.** Si necesitás fs/dialog, es del main.
6. **Probar antes de declarar hecho:** correr `npm test` y, para un adapter
   nuevo, volcar el JSON y verificar a ojo que especie/nivel/movimientos tienen
   sentido (no son basura descifrada mal).
7. **Actualizar este SPEC.md** si cambiás arquitectura, schema o agregás un juego
   (estado ✅/🔴 en §7).

---

## 13. Referencias (source of truth externa)
- PKHeX (C#, GPL-3.0): https://github.com/kwsch/PKHeX — referencia autoritativa
  de offsets, cripto y tamaños. **Citar siempre el archivo fuente.**
  - Cripto PKM: `PKHeX.Core/PKM/Util/PokeCrypto.cs`
  - BDSP save: `PKHeX.Core/Saves/SAV8BS.cs`
  - Gen6 save: `PKHeX.Core/Saves/SAV6AO.cs`, `SAV6XY.cs`, `SAV6.cs`
  - Tablas EXP: `PKHeX.Core/PKM/Util/Experience.cs`
  - LCRNG: `PKHeX.Core/Legality/RNG/Algorithms/LCRNG.cs`
  - Recursos texto: `PKHeX.Core/Resources/text/`
  - Personal tables: `PKHeX.Core/Resources/byte/personal/`
- Electron: https://www.electronjs.org/docs
- electron-builder: https://www.electron.build/
