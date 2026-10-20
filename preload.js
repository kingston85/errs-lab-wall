// Bridge between the wall page and the desktop shell. Only these calls are exposed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(ch, ...args) {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (r && r.err) { const e = new Error(r.err.message); e.code = r.err.code; throw e; }
  return r ? r.ok : undefined;
}

contextBridge.exposeInMainWorld('desktop', {
  list: (col) => call('db:list', col),
  get: (col, id) => call('db:get', col, id),
  set: (col, id, data) => call('db:set', col, id, data),
  update: (col, id, patch) => call('db:update', col, id, patch),
  del: (col, id) => call('db:delete', col, id),
  putBlob: (bytes, type) => call('blob:put', bytes, type),
  delBlob: (id) => call('blob:delete', id),
  openBlob: (id) => call('blob:open', id),
  ask: (req) => call('ask', req),
  cancel: (id) => call('ask:cancel', id),
  settings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),
  testKey: () => call('settings:testKey'),
  chooseDir: () => call('settings:chooseDir'),
  resetDir: () => call('settings:resetDir'),
  openDir: () => call('settings:openDir'),
  exportBackup: () => call('backup:export'),
  importBackup: () => call('backup:import'),
  blobList: () => call('blob:list'),
  blobGet: (id) => call('blob:get', id),
  blobPutId: (id, bytes, type) => call('blob:putId', id, bytes, type),
  saveFile: (name, bytes) => call('file:save', name, bytes),
  checkUpdate: () => call('update:check'),
  getUpdate: () => call('update:get'),
  installUpdate: () => call('update:install'),
  remoteInfo: () => call('remote:info'),
  sendRemoteState: (st) => ipcRenderer.send('remote-state', st),
  onUpdate: (fn) => ipcRenderer.on('update-available', (_, u) => fn(u)),
  onUpdateProgress: (fn) => ipcRenderer.on('update-progress', (_, f) => fn(f)),
  onRemoteCmd: (fn) => ipcRenderer.on('remote-cmd', (_, cmd, key) => fn(cmd, key)),
  onRemoteInfo: (fn) => ipcRenderer.on('remote-info', (_, info) => fn(info)),
  onDbChanged: (fn) => ipcRenderer.on('db-changed', (_, col) => fn(col)),
  onAskDelta: (fn) => ipcRenderer.on('ask-delta', (_, id, text) => fn(id, text)),
});
