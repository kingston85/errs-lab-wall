// ERRS Lab Wall — desktop shell.
// The display itself is the same page as the online wall (renderer/). This
// process gives it what the browser version gets from Claude: a place to keep
// reports (plain JSON files in a data folder, which can be a shared OneDrive or
// network folder so several PCs show the same wall), a store for photos and
// original PDFs, and Claude itself through the Anthropic API with the user's key.
'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, powerSaveBlocker, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const RENDERER = path.join(ROOT, 'renderer');
const MODULES = path.join(ROOT, 'node_modules');
const API_URL = process.env.ERRS_WALL_API_URL || 'https://api.anthropic.com/v1/messages'; // override only used by the automated test
const MODELS = { quick: 'claude-haiku-5-5', default: 'claude-sonnet-5-5', complex: 'claude-opus-5-5' };
const COLLECTIONS = ['reports', 'config', 'notices', 'photos', 'samples'];

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (process.env.ERRS_WALL_USERDATA) app.setPath('userData', process.env.ERRS_WALL_USERDATA); // isolated profile for the automated test
if (!app.requestSingleInstanceLock()) { app.quit(); }

// ------------------------------------------------------------------ settings
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { settings = {}; }
  settings.dataDir ||= path.join(app.getPath('userData'), 'wall-data');
  settings.model ||= 'auto';
  if (settings.fullscreen === undefined) settings.fullscreen = true;
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}
function apiKey() {
  if (!settings.apiKey) return '';
  try {
    if (settings.apiKeyEnc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(settings.apiKey, 'base64'));
    return settings.apiKeyEnc ? '' : Buffer.from(settings.apiKey, 'base64').toString('utf8');
  } catch { return ''; }
}
function setApiKey(k) {
  if (!k) { delete settings.apiKey; delete settings.apiKeyEnc; saveSettings(); return; }
  if (safeStorage.isEncryptionAvailable()) { settings.apiKey = safeStorage.encryptString(k).toString('base64'); settings.apiKeyEnc = true; }
  else { settings.apiKey = Buffer.from(k, 'utf8').toString('base64'); settings.apiKeyEnc = false; }
  saveSettings();
}

// ---------------------------------------------------------------- data store
const dbDir = (col) => path.join(settings.dataDir, 'db', col);
const blobDir = () => path.join(settings.dataDir, 'files');
const SAFE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkName(col, id) {
  if (!COLLECTIONS.includes(col)) throw new Error('Unknown collection ' + col);
  if (id !== undefined && (!SAFE.test(id) || id.startsWith('.'))) throw new Error('Bad document id');
}
async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
  await fsp.rename(tmp, file);
}
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}
async function listDocs(col) {
  checkName(col);
  let names = [];
  try { names = (await fsp.readdir(dbDir(col))).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const data = await readJson(path.join(dbDir(col), n));
    if (data && typeof data === 'object') out.push({ id: n.slice(0, -5), data });
  }
  return out;
}
async function getDoc(col, id) { checkName(col, id); return readJson(path.join(dbDir(col), id + '.json')); }
async function setDoc(col, id, data) { checkName(col, id); await writeJson(path.join(dbDir(col), id + '.json'), data); changed(col); }
function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && v.__delete__ === true) delete out[k];
    else out[k] = v;
  }
  return out;
}
async function updateDoc(col, id, patch) {
  checkName(col, id);
  const cur = await getDoc(col, id);
  if (!cur) { const e = new Error('That item no longer exists.'); e.code = 'not_found'; throw e; }
  await setDoc(col, id, deepMerge(cur, patch));
}
async function deleteDoc(col, id) { checkName(col, id); try { await fsp.unlink(path.join(dbDir(col), id + '.json')); } catch { /* already gone */ } changed(col); }

// change detection: the renderer is told whenever a collection's files change,
// whether this PC wrote them or another PC sharing the folder did.
const sigs = {};
async function signature(col) {
  try {
    const names = (await fsp.readdir(dbDir(col))).filter((n) => n.endsWith('.json')).sort();
    const parts = [];
    for (const n of names) { try { const st = await fsp.stat(path.join(dbDir(col), n)); parts.push(n + ':' + st.mtimeMs + ':' + st.size); } catch { /* raced */ } }
    return parts.join('|');
  } catch { return ''; }
}
function changed(col) { signature(col).then((s) => { sigs[col] = s; }); send('db-changed', col); }
async function poll() {
  for (const col of COLLECTIONS) {
    const s = await signature(col);
    if (sigs[col] !== undefined && s !== sigs[col]) send('db-changed', col);
    sigs[col] = s;
  }
}
function send(ch, ...args) { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, ...args); }

async function seedIfEmpty() {
  const marker = path.join(settings.dataDir, '.created');
  if (fs.existsSync(marker)) return;
  const hasReports = fs.existsSync(dbDir('reports')) && fs.readdirSync(dbDir('reports')).some((n) => n.endsWith('.json'));
  if (!hasReports) {
    const seed = path.join(ROOT, 'seed');
    for (const f of fs.existsSync(seed) ? fs.readdirSync(seed) : []) {
      if (!f.endsWith('.json')) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(seed, f), 'utf8'));
      const col = doc.__collection || 'reports';
      delete doc.__collection;
      await writeJson(path.join(dbDir(col), f), doc);
    }
  }
  await fsp.mkdir(settings.dataDir, { recursive: true });
  await fsp.writeFile(marker, new Date().toISOString());
}

// --------------------------------------------------------------------- files
const TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
async function putBlob(bytes, type) {
  if (!TYPES[type]) { const e = new Error('Only PDF and image files can be stored.'); e.code = 'unsupported_type'; throw e; }
  const id = crypto.randomBytes(16).toString('hex');
  await fsp.mkdir(blobDir(), { recursive: true });
  await fsp.writeFile(path.join(blobDir(), id + TYPES[type]), Buffer.from(bytes));
  return { id, url: '/_blob/' + id, sizeBytes: bytes.byteLength, contentType: type };
}
function findBlob(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  for (const ext of Object.values(TYPES)) { const f = path.join(blobDir(), id + ext); if (fs.existsSync(f)) return f; }
  return null;
}

// ------------------------------------------------------------------- protocol
function resolveAsset(p) {
  const clean = path.posix.normalize('/' + decodeURIComponent(p)).replace(/^\/+/, '');
  const inside = (base, rel) => { const f = path.join(base, rel); return f.startsWith(base) ? f : null; };
  if (clean.startsWith('_blob/')) return findBlob(clean.slice(6));
  if (clean === 'lib/pdf.min.js') return path.join(MODULES, 'pdfjs-dist/build/pdf.min.js');
  if (clean === 'lib/pdf.worker.min.js') return path.join(MODULES, 'pdfjs-dist/build/pdf.worker.min.js');
  if (clean === 'lib/jszip.min.js') return path.join(MODULES, 'jszip/dist/jszip.min.js');
  if (clean.startsWith('fonts/')) return inside(path.join(MODULES, '@fontsource'), clean.slice(6));
  return inside(RENDERER, clean || 'index.html');
}
function registerProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    const file = resolveAsset(u.pathname);
    if (!file) return new Response('Not found', { status: 404 });
    try { return await net.fetch(pathToFileURL(file).toString()); } catch { return new Response('Not found', { status: 404 }); }
  });
}

// --------------------------------------------------------------------- Claude
const running = new Map();
function claudeError(code, message) { return { code, message, desktop: true }; }
async function ask(evt, { id, input, json, tier }) {
  const key = apiKey();
  if (!key) return { error: claudeError('not_granted', 'Claude needs an Anthropic API key on this computer. Open Reports → Computer and paste the key.') };
  const model = settings.model && settings.model !== 'auto' ? settings.model : (MODELS[tier] || MODELS.default);
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const body = {
    model, max_tokens: json ? 32000 : 4000, stream: true, messages,
    system: json ? 'You turn reports into data. Reply with one valid JSON value only: no prose, no markdown fences.' : 'You are a careful assistant for the ERRS Department of the Environmental Protection Agency of Liberia.',
  };
  const ctl = new AbortController();
  running.set(id, ctl);
  let text = '', stop = null;
  try {
    const res = await fetch(API_URL, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json())?.error?.message || ''; } catch { /* no body */ }
      if (res.status === 401 || res.status === 403) return { error: claudeError('not_granted', 'The Anthropic API key was not accepted. Check it in Reports → Computer.') };
      if (res.status === 429 || res.status === 529 || res.status === 503) return { error: claudeError('rate_limited', 'Claude is busy or the API usage limit was reached. Try again in a few minutes.') };
      if (res.status === 400 && /too long|too many tokens|context/i.test(msg)) return { error: claudeError('prompt_too_large', 'This report is too long to read in one go. Split it into smaller files.') };
      if (res.status === 400 && /credit|billing|balance/i.test(msg)) return { error: claudeError('rate_limited', 'The Anthropic account has no API credit left. Add credit in the Anthropic Console.') };
      if (res.status === 404 && /model/i.test(msg)) return { error: claudeError('model_unavailable', `The model "${model}" is not available to this API key. Choose another model in Reports → Computer.`) };
      return { error: claudeError('server_error', `Claude could not answer (${res.status}${msg ? ': ' + msg : ''}).`) };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', last = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
        else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason || stop;
        else if (ev.type === 'error') return { error: claudeError(ev.error?.type === 'overloaded_error' ? 'rate_limited' : 'server_error', 'Claude stopped with an error: ' + (ev.error?.message || 'unknown')) };
      }
      if (!json && Date.now() - last > 120) { last = Date.now(); evt.sender.send('ask-delta', id, text); }
    }
    if (!json) evt.sender.send('ask-delta', id, text);
    return { text, truncated: stop === 'max_tokens' };
  } catch (e) {
    if (e.name === 'AbortError') return { error: { code: 'cancelled', message: 'Stopped.', text } };
    return { error: claudeError('network', 'Could not reach Claude. Check the internet connection on this computer.') };
  } finally { running.delete(id); }
}

// ---------------------------------------------------------------------- IPC
function handle(ch, fn) {
  ipcMain.handle(ch, async (evt, ...args) => {
    try { return { ok: await fn(evt, ...args) }; } catch (e) { return { err: { code: e.code || 'failed', message: e.message } }; }
  });
}
function wireIpc() {
  handle('db:list', (_, col) => listDocs(col));
  handle('db:get', (_, col, id) => getDoc(col, id));
  handle('db:set', (_, col, id, data) => setDoc(col, id, data));
  handle('db:update', (_, col, id, patch) => updateDoc(col, id, patch));
  handle('db:delete', (_, col, id) => deleteDoc(col, id));
  handle('blob:put', (_, bytes, type) => putBlob(bytes, type));
  handle('blob:delete', async (_, id) => { const f = findBlob(id); if (f) await fsp.unlink(f); });
  handle('blob:open', async (_, id) => { const f = findBlob(id); if (!f) throw new Error('The original file is not in the data folder.'); const err = await shell.openPath(f); if (err) throw new Error(err); });
  handle('ask', (evt, req) => ask(evt, req));
  handle('ask:cancel', (_, id) => { running.get(id)?.abort(); });
  handle('settings:get', () => ({
    dataDir: settings.dataDir, model: settings.model, hasKey: !!apiKey(), keyHint: apiKey() ? '…' + apiKey().slice(-4) : '',
    fullscreen: !!settings.fullscreen, autostart: app.getLoginItemSettings().openAtLogin, version: app.getVersion(),
    defaultDir: path.join(app.getPath('userData'), 'wall-data'), computer: os.hostname(),
  }));
  handle('settings:set', async (_, patch) => {
    if ('apiKey' in patch) setApiKey(String(patch.apiKey || '').trim());
    if ('model' in patch) settings.model = patch.model;
    if ('fullscreen' in patch) settings.fullscreen = !!patch.fullscreen;
    if ('autostart' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.autostart });
    saveSettings();
  });
  handle('settings:testKey', async () => {
    const r = await ask({ sender: { send() {} } }, { id: 'test', input: 'Reply with the single word: ready', json: false, tier: 'quick' });
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.text.trim();
  });
  handle('settings:chooseDir', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose the wall\'s data folder', properties: ['openDirectory', 'createDirectory'], defaultPath: settings.dataDir });
    if (r.canceled || !r.filePaths[0]) return null;
    return switchDataDir(r.filePaths[0]);
  });
  handle('settings:resetDir', () => switchDataDir(path.join(app.getPath('userData'), 'wall-data')));
  handle('settings:openDir', async () => { await fsp.mkdir(settings.dataDir, { recursive: true }); await shell.openPath(settings.dataDir); });
}
async function switchDataDir(dir) {
  settings.dataDir = dir;
  saveSettings();
  await seedIfEmpty();
  for (const col of COLLECTIONS) { delete sigs[col]; send('db-changed', col); }
  return dir;
}

// -------------------------------------------------------------------- window
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 960, minHeight: 540,
    backgroundColor: '#061019', fullscreen: !!settings.fullscreen, autoHideMenuBar: true,
    title: 'ERRS Lab Wall', icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL('app://wall/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    const m = url.match(/\/_blob\/([0-9a-f]{32})/);
    if (m) { const f = findBlob(m[1]); if (f) shell.openPath(f); return { action: 'deny' }; }
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://wall/')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'F5') { win.reload(); e.preventDefault(); }
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  loadSettings();
  await seedIfEmpty();
  registerProtocol();
  wireIpc();
  createWindow();
  powerSaveBlocker.start('prevent-display-sleep');
  setInterval(poll, 3000);
});
app.on('window-all-closed', () => app.quit());
