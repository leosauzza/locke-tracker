'use strict';

// Estadísticas derivadas para Nuzlocke (SPEC §5.2).
//
// Es lógica de presentación sobre el dump ya parseado: no toca el save ni
// depende de Electron, así que corre en Node puro y es trivial de testear
// (`node --test`). Se calcula en `extractNow` (tracker.js) a partir del
// resultado de `Adapter.readBoxes()`.

// Nombres que cuentan como "caja de muertos" (Nuzlocke). El match es
// case-insensitive, con trim, y por **igualdad exacta** (no subcadena) para no
// colisionar con nombres como "no muertos" o "muertos2".
const DEAD_BOX_NAMES = ['muertos', 'dead'];

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Devuelve { index, name, count } de la primera caja cuyo nombre matchea, o
// `null` si ninguna coincide.
//
// @param {Array<{box:number,name:string,count:number}>} boxes
// @param {Iterable<string>} [deadBoxNames]  override de la lista de nombres
// @returns {{index:number,name:string,count:number}|null}
function findDeadBox(boxes, deadBoxNames) {
  if (!Array.isArray(boxes)) return null;
  const names = new Set(
    (deadBoxNames ? [...deadBoxNames] : DEAD_BOX_NAMES).map(norm)
  );
  for (const b of boxes) {
    if (b && names.has(norm(b.name))) {
      return { index: b.box, name: b.name, count: b.count };
    }
  }
  return null;
}

// Sección `nuzlocke` del dump canónico (SPEC §5.2).
function summarize(boxes, deadBoxNames) {
  return { deadBox: findDeadBox(boxes, deadBoxNames) };
}

module.exports = { findDeadBox, summarize, DEAD_BOX_NAMES };
