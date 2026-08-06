'use strict';

// Handlers IPC (SPEC §8.2 + §14 Track & Overlay). El parseo corre en main.

const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { detectGame, getAdapter, listGames } = require('../core');

const TOOL_VERSION = require('../../package.json').version;
const tracker = require('./tracker');

function registerIpc(getWin) {
  // Lista de juegos soportados (para el dropdown del renderer).
  ipcMain.handle('games:list', () => listGames());

  // Diálogo nativo de selección de archivo.
  ipcMain.handle('dialog:openFile', async () => {
    const win = getWin();
    const opts = {
      title: 'Seleccionar archivo de guardado',
      filters: [{ name: 'Pokémon Save', extensions: ['bin', 'dat', 'main', 'sav', '*'] }],
      properties: ['openFile'],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });

  // Autodetección sin extracción completa: devuelve {gameKey,gameLabel,platform}
  // o null para que la UI pre-seleccione (o pida al usuario).
  ipcMain.handle('detect', async (_e, filePath) => {
    if (!filePath) return null;
    const buf = fs.readFileSync(filePath);
    const Adapter = detectGame(buf);
    if (!Adapter) return null;
    return { gameKey: Adapter.gameKey, gameLabel: Adapter.gameLabel, platform: Adapter.platform };
  });

  // Extracción completa → dump JSON canónico (SPEC §5).
  ipcMain.handle('extract', async (_e, filePath, gameKey) => {
    if (!filePath) return { error: 'No se seleccionó un archivo.' };
    try {
      return tracker.extractNow(filePath, gameKey, TOOL_VERSION);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  });

  // Guardar JSON a disco (diálogo nativo save).
  ipcMain.handle('dialog:saveJson', async (_e, defaultName, json) => {
    const win = getWin();
    const opts = {
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, json);
    return r.filePath;
  });

  // --- Track & Overlay (SPEC §14) -------------------------------------------

  // Inicia el loop de 5s. Devuelve {ok} o {error}.
  ipcMain.handle('track:start', (_e, filePath, gameKey) => {
    if (!filePath) return { error: 'No se seleccionó un archivo.' };
    try {
      tracker.start(filePath, gameKey, TOOL_VERSION);
      return { ok: true, status: tracker.status() };
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  });

  // Detiene el loop.
  ipcMain.handle('track:stop', () => {
    tracker.stop();
    return { ok: true };
  });

  // Estado actual del tracker + path del overlay.
  ipcMain.handle('track:status', () => tracker.status());

  // Abre la carpeta del overlay en el explorador de archivos.
  ipcMain.handle('track:openFolder', async () => {
    const dir = tracker.getOverlayDir();
    try {
      // ensure dir exists so the OS doesn't open a nonexistent path
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  // Abre una ventana de preview del overlay (1920×1080 escalado).
  ipcMain.handle('track:preview', () => {
    const { BrowserWindow } = require('electron');
    const overlayPath = path.join(tracker.getOverlayDir(), 'overlay.html');
    if (!fs.existsSync(overlayPath)) {
      return { error: 'overlay.html todavía no existe. Iniciá Track primero.' };
    }
    const preview = new BrowserWindow({
      width: 960,
      height: 540,
      title: 'Overlay Preview (1920×1080)',
      backgroundColor: '#000000',
      resizable: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    preview.setMenuBarVisibility(false);
    preview.loadFile(overlayPath);
    return { ok: true };
  });
}

module.exports = { registerIpc };
