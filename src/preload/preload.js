'use strict';

// Preload (SPEC §8.2 + §14). Expone una API mínima y segura vía contextBridge.
// Nunca expone require/fs al renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listGames:      ()           => ipcRenderer.invoke('games:list'),
  openFileDialog: ()           => ipcRenderer.invoke('dialog:openFile'),
  detect:         (filePath)   => ipcRenderer.invoke('detect', filePath),
  extract:        (filePath, gameKey) => ipcRenderer.invoke('extract', filePath, gameKey),
  saveJson:       (defaultName, json) => ipcRenderer.invoke('dialog:saveJson', defaultName, json),

  // Track & Overlay (SPEC §14).
  trackStart:     (filePath, gameKey) => ipcRenderer.invoke('track:start', filePath, gameKey),
  trackStop:      ()           => ipcRenderer.invoke('track:stop'),
  trackStatus:    ()           => ipcRenderer.invoke('track:status'),
  trackOpenFolder:()           => ipcRenderer.invoke('track:openFolder'),
  trackPreview:   ()           => ipcRenderer.invoke('track:preview'),
});
