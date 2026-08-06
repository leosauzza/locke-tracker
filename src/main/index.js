'use strict';

// Electron main process (SPEC §8.1).
// Crea la ventana y registra los handlers IPC. El parseo corre acá (tiene fs).

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpc } = require('./ipc');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 600,
    title: 'PokéSave Extractor',
    backgroundColor: '#0f1320',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerIpc(() => win);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
