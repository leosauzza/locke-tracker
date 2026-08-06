'use strict';

// Generación del overlay para streaming (SPEC §14 — Track & Overlay).
//
// El overlay es un HTML standalone de 1920×1080 pensado para usarse como
// Browser Source en OBS ( cargado vía file:// ). Para esquivar las
// restricciones de CORS de Chromium/CEF sobre file://, en lugar de fetch
// usamos un <script src="data.js"> que se recarga periódicamente y asigna
// `window.__TRACK_DATA`. Cada tick del tracker pisa `data.js` atómicamente.
//
// `overlay.html` se escribe si no existe, y se reescribe (con backup
// `overlay.html.bak`) cuando cambia OVERLAY_VERSION para repartir mejoras de
// layout sin pisar customizaciones dentro de la misma versión. Si se quiere
// resetear manualmente, borrar overlay.html y reiniciar track. También se
// escribe siempre `overlay.template.html` con la versión default.

const fs = require('fs');
const path = require('path');

const OVERLAY_VERSION = '4';

// Sprite artwork oficial desde PokeAPI (repo oficial de sprites).
// Shiny usa subdirectorio `shiny/`. Formas especiales no se mapean (TODO).
function spriteUrl(p) {
  const id = p.species;
  const shiny = p.shiny ? 'shiny/' : '';
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${shiny}${id}.png`;
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function readVersionFile(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'overlay.version'), 'utf8').trim();
  } catch {
    return null;
  }
}

function readPlatformFile(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'overlay.platform'), 'utf8').trim();
  } catch {
    return null;
  }
}

function writeOverlay(dir, dump) {
  fs.mkdirSync(dir, { recursive: true });

  // La variante de layout depende de la plataforma del juego (SPEC §9.1):
  // 3DS = equipo a la izquierda; Switch = centrado en el game-area.
  const platform = dump.meta.platform || '3DS';
  const overlayHtml = buildOverlayHtml(platform);

  // data.js — pisado cada tick (carga vía <script>, ve comentario arriba).
  atomicWrite(
    path.join(dir, 'data.js'),
    `// Generado automáticamente por PokeSave Extractor — ${dump.meta.extractedAt}\n` +
      `window.__TRACK_DATA = ${JSON.stringify(dump)};\n`,
  );

  // overlay.html — se (re)escribe si: no existe, cambió la versión del
  // template, o cambió la plataforma (3DS ↔ Switch). En esos casos se hace
  // backup del custom del usuario (.bak) antes de pisar. Dentro de una misma
  // versión+plataforma, se preservan las ediciones del usuario.
  const overlayPath = path.join(dir, 'overlay.html');
  const existingVersion = readVersionFile(dir);
  const existingPlatform = readPlatformFile(dir);
  const platformChanged = existingPlatform !== null && existingPlatform !== platform;
  const needsWrite =
    !fs.existsSync(overlayPath) ||
    existingVersion !== OVERLAY_VERSION ||
    platformChanged;
  if (needsWrite && fs.existsSync(overlayPath)) {
    try {
      fs.copyFileSync(overlayPath, `${overlayPath}.bak`);
    } catch { /* best-effort */ }
  }
  if (needsWrite) {
    fs.writeFileSync(overlayPath, overlayHtml, 'utf8');
  }

  // template siempre fresco (default 3DS), por si el usuario quiere restaurar.
  fs.writeFileSync(path.join(dir, 'overlay.template.html'), buildOverlayHtml('3DS'), 'utf8');
  fs.writeFileSync(path.join(dir, 'overlay.version'), OVERLAY_VERSION, 'utf8');
  fs.writeFileSync(path.join(dir, 'overlay.platform'), platform, 'utf8');
}

// ---------------------------------------------------------------------------
// Template del overlay (1920×1080).
//
// Layout (común):
//   - Fondo transparente (editable: poner bg.png en la misma carpeta y
//     descomentar la línea de `background` en `body`).
//   - Área central de juego (placeholder — el game capture va encima en OBS).
//   - Webcam arriba a la derecha (círculo).
//   - Equipo (6 slots) abajo, con imagen (PokeAPI) + nombre + nivel.
//
// Variante por plataforma (getPartyCss):
//   - 3DS   : alineado a la IZQUIERDA (deja la derecha para pantalla táctil).
//   - Switch: CENTRADO respecto del game-area
//             (= ancho total − webcam − márgenes = 1500px, de x=60 a x=1560).
// ---------------------------------------------------------------------------

// Game-area: left 60, width 1500 (va de x=60 a x=1560, justo hasta la webcam).
// Para Switch, el party bar ocupa ese mismo ancho y centra dentro de él.
const GAME_AREA_LEFT = 60;
const GAME_AREA_WIDTH = 1500;

function getPartyCss(platform) {
  // Switch (BDSP, etc.): centrado dentro del game-area.
  if (platform === 'Switch') {
    return `    .party {
      position: absolute;
      left: ${GAME_AREA_LEFT}px;
      width: ${GAME_AREA_WIDTH}px; /* = ancho del game-area → centra dentro */
      bottom: 24px;
      display: flex;
      justify-content: center;
      gap: 24px;
    }`;
  }
  // 3DS (XY/ORAS) y default: alineado a la izquierda.
  return `    .party {
      position: absolute;
      left: ${GAME_AREA_LEFT}px;
      bottom: 24px;
      display: flex;
      justify-content: flex-start;
      gap: 24px;
    }`;
}

function buildOverlayHtml(platform) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>PokéSave Overlay</title>
  <style>
    :root {
      --slot-bg: rgba(8, 12, 28, 0.72);
      --slot-border: rgba(255, 255, 255, 0.28);
      --accent: #4c7cff;
      --text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.95);
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif;
      color: #fff;
      /* Por defecto transparente: el game capture va debajo en OBS.
         Para usar un fondo propio, poné bg.png en esta carpeta y
         descomentá la siguiente línea: */
      /* background: url('bg.png') center/cover no-repeat; */
    }

    .stage {
      position: relative;
      width: 1920px;
      height: 1080px;
    }

    /* Área central del juego — placeholder posicional. El game capture va
       encima en OBS. (Sin borde: es solo una referencia de ubicación.) */
    .game-area {
      position: absolute;
      left: 60px;
      top: 40px;
      width: 1500px;
      height: 800px;
    }

    /* Webcam — círculo arriba a la derecha. Poner la source de la webcam
       encima en OBS (mismo tamaño/posicionamiento). */
    .webcam {
      position: absolute;
      right: 60px;
      top: 50px;
      width: 300px;
      height: 300px;
      border-radius: 50%;
      border: 6px solid var(--accent);
      box-shadow: 0 0 24px rgba(0, 0, 0, 0.6), inset 0 0 12px rgba(0, 0, 0, 0.3);
      background: rgba(0, 0, 0, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.45);
      font-size: 20px;
      letter-spacing: 2px;
    }

    /* Equipo: fila de 6 slots abajo. La alineación depende de la plataforma
       (ver getPartyCss más abajo): 3DS alineado a la izquierda (deja lugar
       para la pantalla táctil), Switch centrado respecto del game-area. */
${getPartyCss(platform)}
    .slot {
      width: 175px;
      background: var(--slot-bg);
      border: 2px solid var(--slot-border);
      border-radius: 14px;
      padding: 8px 6px 10px;
      text-align: center;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    }
    .slot img {
      width: 140px;
      height: 140px;
      object-fit: contain;
      display: block;
      margin: 0 auto;
      /* evita parpadeo al recambiar src */
      background: transparent;
    }
    .slot .img-ph {
      width: 140px;
      height: 140px;
      margin: 0 auto;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
    }
    .slot .name {
      font-size: 18px;
      font-weight: 700;
      margin-top: 5px;
      text-shadow: var(--text-shadow);
      line-height: 1.1;
    }
    .slot .sub {
      font-size: 12px;
      color: #cfd6e6;
      text-shadow: var(--text-shadow);
    }
    .slot .star { color: #ffd24a; }
    .slot.fainted { opacity: 0.55; filter: grayscale(0.6); }
  </style>
</head>
<body>
  <div class="stage">
    <div class="game-area"></div>
    <div class="webcam">WEBCAM</div>
    <div class="party" id="party"></div>
  </div>

  <script>
    // Sprite oficial desde PokeAPI.
    function spriteUrl(p) {
      const shiny = p.shiny ? 'shiny/' : '';
      return 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + shiny + p.species + '.png';
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
      });
    }

    function render(data) {
      var party = (data && data.party) || [];
      var html = '';
      for (var i = 0; i < 6; i++) {
        var p = party[i];
        if (p) {
          var spec = p.speciesName || ('#' + p.species);
          var display = (p.nickname && p.nickname !== spec) ? p.nickname : spec;
          var star = p.shiny ? '<span class="star">★</span>' : '';
          var egg = p.isEgg ? ' [EGG]' : '';
          html +=
            '<div class="slot">' +
              '<img src="' + spriteUrl(p) + '" alt="' + escapeHtml(spec) + '" />' +
              '<div class="name">' + escapeHtml(display) + ' ' + star + egg + '</div>' +
              '<div class="sub">Lv.' + (p.level != null ? p.level : '?') + '</div>' +
            '</div>';
        } else {
          html += '<div class="slot"><div class="img-ph"></div></div>';
        }
      }
      document.getElementById('party').innerHTML = html;
      // Si una sprite falla (ej. forma no mapeada), la ocultamos en vez de
      // mostrar el ícono de "imagen rota".
      var imgs = document.querySelectorAll('#party .slot img');
      for (var j = 0; j < imgs.length; j++) {
        imgs[j].onerror = function () { this.style.visibility = 'hidden'; };
      }
    }

    // Carga data.js (asigna window.__TRACK_DATA). Se reemplaza el <script>
    // cada refresh con query cache-buster para que CEF no cachee file://.
    function refresh() {
      var old = document.getElementById('data-script');
      if (old) old.parentNode.removeChild(old);
      window.__TRACK_DATA = null;
      var s = document.createElement('script');
      s.id = 'data-script';
      s.src = 'data.js?t=' + Date.now();
      s.onload = function () {
        if (window.__TRACK_DATA) render(window.__TRACK_DATA);
      };
      document.body.appendChild(s);
    }

    refresh();
    // Refresco cada 3s (el tracker actualiza cada 5s; eventualmente pisa
    // data.js sin parpadeo del overlay).
    setInterval(refresh, 3000);
  </script>
</body>
</html>
`;
}

module.exports = { writeOverlay, buildOverlayHtml, spriteUrl, OVERLAY_VERSION };
