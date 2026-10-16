'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  run: () => ipcRenderer.invoke('run'),
  stop: () => ipcRenderer.invoke('stop'),
  setPaused: (p) => ipcRenderer.invoke('set-paused', p),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  importClientSecret: () => ipcRenderer.invoke('import-client-secret'),
  signIn: () => ipcRenderer.invoke('sign-in'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  retryFailed: () => ipcRenderer.invoke('retry-failed'),
  openVideo: (id) => ipcRenderer.invoke('open-external', `https://youtu.be/${encodeURIComponent(id)}`),
});
