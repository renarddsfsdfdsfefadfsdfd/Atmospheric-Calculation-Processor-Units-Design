'use strict';
/*
 * preload.js — the only bridge between the renderer and the main process.
 * contextIsolation is on and nodeIntegration is off, so this file defines the
 * entire API surface the UI can touch.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const wrapped = (event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('acpu', {
  // device
  deviceInfo: () => ipcRenderer.invoke('device:info'),
  telemetry: () => ipcRenderer.invoke('device:telemetry'),
  history: () => ipcRenderer.invoke('device:history'),
  onTelemetry: (cb) => subscribe('device:telemetry', cb),
  onReady: (cb) => subscribe('device:ready', cb),

  // formulas
  formulaList: () => ipcRenderer.invoke('formula:list'),
  parse: (text) => ipcRenderer.invoke('formula:parse', text),
  run: (formula, params, animate) => ipcRenderer.invoke('formula:run', { formula, params, animate }),
  onRunStarted: (cb) => subscribe('run:started', cb),
  onRunProgress: (cb) => subscribe('run:progress', cb),
  onRunDone: (cb) => subscribe('run:done', cb),

  // runs
  runsList: () => ipcRenderer.invoke('runs:list'),
  runGet: (id) => ipcRenderer.invoke('run:get', id),
  runDelete: (id) => ipcRenderer.invoke('run:delete', id),
  runsClear: () => ipcRenderer.invoke('runs:clear'),

  // app
  settings: () => ipcRenderer.invoke('app:settings'),
  saveSettings: (patch) => ipcRenderer.invoke('app:settings:set', patch),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  service: () => ipcRenderer.invoke('app:service'),
});
