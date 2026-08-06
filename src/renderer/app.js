'use strict';

// Renderer (SPEC §8.3). UI vanilla, habla con el main solo vía window.api.

// `api` lo expone el preload vía contextBridge como `window.api` (propiedad
// global). NO declarar `const api = window.api`: chocaría con esa propiedad
// no-configurable y lanzaría un SyntaxError que rompería todo app.js.
const $ = (id) => document.getElementById(id);

const STAT_KEYS = ['HP', 'Atk', 'Def', 'Spe', 'SpA', 'SpD'];
const GENDER_SYM = { Male: '♂', Female: '♀', Genderless: '' };

let lastDump = null;
let lastJson = '';
let tracking = false;
let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await populateGames();
  // Si el tracker ya está corriendo (ej. recarga del renderer), sincronizamos.
  try {
    const s = await api.trackStatus();
    if (s && s.running) {
      $('trackPanel').classList.remove('hidden');
      setTracking(true);
    } else if (s && s.overlayDir) {
      // Mostramos el panel con el path del overlay aunque no esté corriendo,
      // por si ya hay un overlay generado de una sesión previa.
      $('trackPanel').classList.remove('hidden');
      $('overlayPath').value = `${s.overlayDir}\\overlay.html`;
    }
  } catch { /* ignore */ }
});

function bindEvents() {
  $('fileBtn').addEventListener('click', onChooseFile);
  $('gameSel').addEventListener('change', updateExtractEnabled);
  $('extractBtn').addEventListener('click', onExtract);
  $('trackBtn').addEventListener('click', onTrackToggle);
  $('openOverlayBtn').addEventListener('click', () => api.trackOpenFolder());
  $('previewOverlayBtn').addEventListener('click', async () => {
    const r = await api.trackPreview();
    if (r && r.error) toast(r.error);
  });
  $('tabs').addEventListener('click', onTabClick);
  $('copyBtn').addEventListener('click', onCopyJson);
  $('saveBtn').addEventListener('click', onSaveJson);
  $('filePath').addEventListener('change', updateExtractEnabled);
}

async function populateGames() {
  const games = await api.listGames();
  const sel = $('gameSel');
  for (const g of games) {
    const opt = document.createElement('option');
    opt.value = g.gameKey;
    opt.textContent = `${g.gameLabel} (${g.platform})`;
    sel.appendChild(opt);
  }
}

function updateExtractEnabled() {
  const hasFile = $('filePath').value.trim() !== '';
  $('extractBtn').disabled = !hasFile;
  // trackBtn se gestiona en setTracking(); acá solo lo deshabilitamos si no
  // hay archivo y no estamos trackeando.
  if (!tracking) $('trackBtn').disabled = !hasFile;
}

// ---------------------------------------------------------------------------
// Step 1: choose file + autodetect
// ---------------------------------------------------------------------------
async function onChooseFile() {
  const p = await api.openFileDialog();
  if (!p) return;
  $('filePath').value = p;
  $('detectNote').textContent = '';
  $('detectNote').className = 'note';

  try {
    const det = await api.detect(p);
    if (det) {
      $('gameSel').value = det.gameKey;
      $('detectNote').textContent = `Detectado: ${det.gameLabel}`;
    } else {
      $('gameSel').value = 'auto';
      $('detectNote').textContent = 'No detectado — elegí el juego.';
      $('detectNote').className = 'note warn';
    }
  } catch (err) {
    $('detectNote').textContent = '';
  }
  updateExtractEnabled();
}

// ---------------------------------------------------------------------------
// Step 3: extract
// ---------------------------------------------------------------------------
async function onExtract() {
  const filePath = $('filePath').value.trim();
  if (!filePath) return;
  const gameKey = $('gameSel').value;

  hideError();
  $('busy').classList.remove('hidden');
  $('extractBtn').disabled = true;
  $('result').classList.add('hidden');

  try {
    const dump = await api.extract(filePath, gameKey);
    if (!dump || dump.error) {
      showError(dump ? dump.error : 'Error desconocido en la extracción.');
      return;
    }
    lastDump = dump;
    lastJson = JSON.stringify(dump, null, 2);
    render(dump);
    $('result').classList.remove('hidden');
    $('versionTag').textContent = `v${dump.meta.toolVersion} · ${dump.meta.gameLabel}`;
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  } finally {
    $('busy').classList.add('hidden');
    $('extractBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Track & Overlay (SPEC §14)
// ---------------------------------------------------------------------------
async function onTrackToggle() {
  if (tracking) {
    await api.trackStop();
    setTracking(false);
    return;
  }
  const filePath = $('filePath').value.trim();
  if (!filePath) return;
  const gameKey = $('gameSel').value;

  hideError();
  const r = await api.trackStart(filePath, gameKey);
  if (!r || r.error) {
    showError(r ? r.error : 'No se pudo iniciar el track.');
    return;
  }
  setTracking(true);
}

function setTracking(on) {
  tracking = on;
  const btn = $('trackBtn');
  if (on) {
    btn.textContent = 'Stop';
    btn.classList.add('stop');
    $('trackLiveBadge').classList.remove('hidden');
    $('trackPanel').classList.remove('hidden');
    $('overlayPath').value = '';
    pollStatus();
  } else {
    btn.textContent = 'Track';
    btn.classList.remove('stop');
    $('trackLiveBadge').classList.add('hidden');
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }
  // Siempre habilitado para poder detener; si no está corriendo, requiere file.
  btn.disabled = !on && !$('filePath').value.trim();
  // extractBtn permanece habilitado mientras no esté corriendo el extract
  updateExtractEnabled();
}

async function pollStatus() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  const update = async () => {
    if (!tracking) return;
    const s = await api.trackStatus();
    if (!s) return;
    if (s.overlayDir) {
      $('overlayPath').value = `${s.overlayDir}\\overlay.html`;
    }
    const parts = [];
    if (s.running) {
      parts.push('Trackeando');
      if (s.lastUpdatedAt) {
        const ago = relTime(s.lastUpdatedAt);
        parts.push(`actualizado ${ago}`);
      }
      if (s.lastError) parts.push(`error: ${s.lastError}`);
    }
    $('trackStatus').textContent = parts.join(' · ');
    $('trackStatus').classList.remove('hidden');
    $('trackStatus').className = 'note' + (s.lastError ? ' warn' : '');
  };
  await update();
  statusTimer = setInterval(update, 2000);
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return 'ahora';
  if (diff < 60) return `hace ${Math.floor(diff)}s`;
  return `hace ${Math.floor(diff / 60)}min`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render(dump) {
  renderSummary(dump);
  renderParty(dump.party);
  renderBoxes(dump.boxes);
  renderBag(dump.bag);
  $('jsonView').value = lastJson;
  activateTab('summary');
}

function renderSummary(dump) {
  const m = dump.meta;
  const t = dump.trainer || {};
  const boxTotal = (dump.boxes || []).reduce((a, b) => a + b.count, 0);
  const dead = dump.nuzlocke && dump.nuzlocke.deadBox;
  const deadTxt = dead ? `${dead.count} · ${escapeHtml(dead.name)}` : '—';
  const hashTxt = m.hashValid === null ? '—' : (m.hashValid ? 'OK (informativo)' : 'no coincide (informativo)');

  const head = `
    <div class="summary-head">
      <div class="stat"><div class="n">${escapeHtml(t.name || '—')}</div><div class="l">Entrenador</div></div>
      <div class="stat"><div class="n">${(dump.party || []).length}/6</div><div class="l">Equipo</div></div>
      <div class="stat"><div class="n">${boxTotal}</div><div class="l">En cajas</div></div>
      <div class="stat"><div class="n">${deadTxt}</div><div class="l">Muertos (caja)</div></div>
      <div class="stat"><div class="n">${(dump.bag || []).length}</div><div class="l">Tipos de ítem</div></div>
    </div>`;

  const trainer = `
    <h2>Entrenador</h2>
    <div class="card">
      <div class="kv">
        <span class="k">Nombre</span><span>${escapeHtml(t.name || '—')}</span>
        <span class="k">Juego</span><span>${escapeHtml(t.game || m.gameLabel || '—')}</span>
        <span class="k">TID / SID</span><span>${t.tid ?? '—'} / ${t.sid ?? '—'} <span class="note">(ID32 ${t.id32 ?? '—'})</span></span>
        <span class="k">Género</span><span>${escapeHtml(t.gender || '—')}</span>
        <span class="k">Dinero</span><span>${t.money ?? '—'}</span>
        <span class="k">Medallas</span><span>${t.badges ?? '—'} · Campeón: ${t.champion ? 'sí' : 'no'}</span>
        <span class="k">Rival</span><span>${escapeHtml(t.rival || '—')}</span>
        <span class="k">Tiempo jugado</span><span>${escapeHtml(t.playtime || '—')}</span>
      </div>
    </div>`;

  const meta = `
    <h2>Archivo</h2>
    <div class="card">
      <div class="kv">
        <span class="k">Archivo</span><span>${escapeHtml(m.file || '—')}</span>
        <span class="k">Tamaño</span><span>${m.fileSize ?? '—'} bytes</span>
        <span class="k">Plataforma</span><span>${escapeHtml(m.platform || '—')}</span>
        <span class="k">Revisión</span><span>${escapeHtml(String(m.revision ?? '—'))}</span>
        <span class="k">Hash MD5</span><span>${escapeHtml(hashTxt)}</span>
        <span class="k">Extraído</span><span>${escapeHtml(m.extractedAt || '—')}</span>
      </div>
    </div>`;

  $('tab-summary').innerHTML = head + trainer + meta;
}

function renderParty(party) {
  const el = $('tab-party');
  if (!party || party.length === 0) { el.innerHTML = '<p class="note">(equipo vacío)</p>'; return; }
  el.innerHTML = `<div class="party-grid">${party.map(pkCard).join('')}</div>`;
}

function renderBoxes(boxes) {
  const el = $('tab-boxes');
  if (!boxes || boxes.length === 0) { el.innerHTML = '<p class="note">(sin cajas)</p>'; return; }
  const html = boxes
    .filter((b) => b.count > 0)
    .map((b) => `
      <h2>${escapeHtml(b.name)} — ${b.count}</h2>
      <div class="box-grid">${b.slots.map(boxSlot).join('')}</div>`)
    .join('');
  el.innerHTML = html || '<p class="note">(todas las cajas vacías)</p>';
}

function renderBag(bag) {
  const el = $('tab-bag');
  if (!bag || bag.length === 0) { el.innerHTML = '<p class="note">(mochila vacía)</p>'; return; }
  el.innerHTML = `<div class="bag-grid">${bag.map((it) => `
    <div class="box-slot">
      <span>${escapeHtml(it.name || `#${it.id}`)}${it.favorite ? ' ♥' : ''}</span>
      <span>×${it.count}</span>
    </div>`).join('')}</div>`;
}

function boxSlot(p) {
  const spec = p.speciesName || `#${p.species}`;
  const star = p.shiny ? '<span class="star">★</span>' : '';
  const gsym = GENDER_SYM[p.gender] || '';
  const egg = p.isEgg ? ' [EGG]' : '';
  return `<div class="box-slot">
    <span>Lv.${p.level} ${escapeHtml(spec)}${gsym ? ' ' + gsym : ''} ${star}${egg}</span>
    <span class="note">${escapeHtml(p.nickname && p.nickname !== spec ? '"' + p.nickname + '"' : '')}</span>
  </div>`;
}

function pkCard(p) {
  const spec = p.speciesName || `#${p.species}`;
  const formTag = p.form ? `-${p.form}` : '';
  const star = p.shiny ? '<span class="star">★</span>' : '';
  const egg = p.isEgg ? ' [EGG]' : '';
  const held = p.heldItem ? ` · ${escapeHtml(p.heldItemName || '#' + p.heldItem)}` : '';
  const ha = p.isHiddenAbility ? ' (HA)' : '';

  const statRow = p.stats
    ? `<table><tr>${STAT_KEYS.map((k) => `<th>${k}</th>`).join('')}</tr>
         <tr>${STAT_KEYS.map((k) => `<td>${p.stats[k] ?? '—'}</td>`).join('')}</tr></table>`
    : '<p class="note">(stats sólo para equipo)</p>';

  return `<div class="pk">
    <div class="name">${escapeHtml(p.nickname || spec)} ${star}${egg}</div>
    <div class="sub">${escapeHtml(spec)}${formTag} · Lv.${p.level} · ${escapeHtml(p.gender || '—')} · ${escapeHtml(p.natureName || '—')}</div>
    <div class="sub">Habilidad: ${escapeHtml(p.abilityName || '#' + p.ability)}${ha}${held} · Ball: ${escapeHtml(p.ballName || '—')}</div>
    <div class="sub">PID ${escapeHtml(p.pid)} · OT: ${escapeHtml(p.ot?.name || '—')} (TID ${p.tid}/SID ${p.sid})</div>
    ${statRow}
    <div class="iv-ev">
      <div class="group">
        ${STAT_KEYS.map((k) => `<div class="h">${k}</div>`).join('')}
        ${STAT_KEYS.map((k) => `<div class="v">IV ${p.ivs?.[k] ?? '—'}</div>`).join('')}
      </div>
      <div class="group">
        ${STAT_KEYS.map((k) => `<div class="h">${k}</div>`).join('')}
        ${STAT_KEYS.map((k) => `<div class="v">EV ${p.evs?.[k] ?? '—'}</div>`).join('')}
      </div>
    </div>
    <div class="moves"><table><tr><th>Movimientos</th></tr>
      ${p.moves.filter((m) => m.id).map((m) => `<tr><td>${escapeHtml(m.name || '#' + m.id)} <span class="note">(PP ${m.pp}${m.maxPp != null ? '/' + m.maxPp : ''})</span></td></tr>`).join('')}
    </table></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Tabs + JSON actions
// ---------------------------------------------------------------------------
function onTabClick(e) {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  activateTab(btn.dataset.tab);
}

function activateTab(name) {
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  const panel = $(`tab-${name}`);
  if (panel) panel.classList.remove('hidden');
}

async function onCopyJson() {
  if (!lastJson) return;
  try {
    await navigator.clipboard.writeText(lastJson);
    toast('JSON copiado al portapapeles');
  } catch {
    toast('No se pudo copiar');
  }
}

async function onSaveJson() {
  if (!lastDump) return;
  const name = `${lastDump.meta.file || 'save'}.json`;
  const saved = await api.saveJson(name, lastJson);
  if (saved) toast(`Guardado: ${saved}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function showError(msg) { const e = $('errorBanner'); e.textContent = msg; e.classList.remove('hidden'); }
function hideError() { $('errorBanner').classList.add('hidden'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
