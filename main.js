// ERRS Lab Wall — desktop shell.
// The display itself is the same page as the online wall (renderer/). This
// process gives it what the browser version gets from Claude: a place to keep
// reports (plain JSON files in a data folder, which can be a shared OneDrive or
// network folder so several PCs show the same wall), a store for photos and
// original PDFs, and Claude itself through the Anthropic API with the user's key.
'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, powerSaveBlocker, safeStorage, Menu, session } = require('electron');
const http = require('http');
const { spawn } = require('child_process');
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

// -------------------------------------------------------------------- backup
// One JSON file holding every report, notice, sample, photo and original PDF.
// The Android app reads and writes the same format, so data can move between them.
const BACKUP_FORMAT = 'errs-lab-wall-backup';
async function exportBackup(win) {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save a backup of the wall',
    defaultPath: path.join(app.getPath('documents'), `ERRS-Lab-Wall-backup-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Wall backup', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const out = { format: BACKUP_FORMAT, version: 1, created: new Date().toISOString(), source: os.hostname(), collections: {}, files: [] };
  let docs = 0;
  for (const col of COLLECTIONS) { out.collections[col] = await listDocs(col); docs += out.collections[col].length; }
  let names = [];
  try { names = await fsp.readdir(blobDir()); } catch { /* no files yet */ }
  for (const n of names) {
    const m = n.match(/^([0-9a-f]{32})(\.\w+)$/);
    const type = m && Object.keys(TYPES).find((t) => TYPES[t] === m[2]);
    if (type) out.files.push({ id: m[1], type, data: (await fsp.readFile(path.join(blobDir(), n))).toString('base64') });
  }
  await fsp.writeFile(r.filePath, JSON.stringify(out));
  return { path: r.filePath, docs, files: out.files.length };
}
async function importBackup(win) {
  const r = await dialog.showOpenDialog(win, { title: 'Open a wall backup', properties: ['openFile'], filters: [{ name: 'Wall backup', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  let b;
  try { b = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')); } catch { throw new Error('That file is not a wall backup.'); }
  if (!b || b.format !== BACKUP_FORMAT) throw new Error('That file is not a wall backup.');
  let docs = 0, files = 0;
  for (const col of COLLECTIONS) {
    for (const d of Array.isArray(b.collections?.[col]) ? b.collections[col] : []) {
      if (!d || typeof d.id !== 'string' || !SAFE.test(d.id) || d.id.startsWith('.') || !d.data || typeof d.data !== 'object') continue;
      await writeJson(path.join(dbDir(col), d.id + '.json'), d.data);
      docs++;
    }
    changed(col);
  }
  await fsp.mkdir(blobDir(), { recursive: true });
  for (const f of Array.isArray(b.files) ? b.files : []) {
    if (!f || !/^[0-9a-f]{32}$/.test(f.id) || !TYPES[f.type] || typeof f.data !== 'string') continue;
    const file = path.join(blobDir(), f.id + TYPES[f.type]);
    if (!fs.existsSync(file)) { await fsp.writeFile(file, Buffer.from(f.data, 'base64')); files++; }
  }
  return { docs, files };
}

// ------------------------------------------------------------------- updates
// Checks the GitHub releases page for a newer Windows installer and, when asked,
// downloads it and runs it silently; the app restarts on the new version.
const REPO = 'kingston85/errs-lab-wall';
let update = null; // { version, url, size, notes }
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return false; };
async function checkUpdate() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'ERRS-Lab-Wall', Accept: 'application/vnd.github+json' } });
    if (!res.ok) return update;
    const rel = await res.json();
    for (const a of rel.assets || []) {
      const m = a.name.match(/^ERRS-Lab-Wall-Setup-(\d+\.\d+\.\d+)\.exe$/);
      if (m && newer(m[1], app.getVersion())) { update = { version: m[1], url: a.browser_download_url, size: a.size, page: rel.html_url }; send('update-available', update); }
    }
  } catch { /* offline: try later */ }
  return update;
}
async function installUpdate(evt) {
  if (!update) throw new Error('No update is waiting.');
  if (process.platform !== 'win32') { shell.openExternal(update.page); return 'opened'; }
  const file = path.join(app.getPath('temp'), `ERRS-Lab-Wall-Setup-${update.version}.exe`);
  const res = await net.fetch(update.url, { headers: { 'User-Agent': 'ERRS-Lab-Wall' } });
  if (!res.ok) throw new Error('The download did not start (' + res.status + ').');
  const total = Number(res.headers.get('content-length')) || update.size || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0, last = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > 300) { last = Date.now(); evt.sender.send('update-progress', total ? got / total : 0); }
  }
  await new Promise((r) => out.end(r));
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 800);
  return 'installing';
}

// -------------------------------------------------------------- phone remote
// A small web page on the local network: scan the QR code on the big screen
// with a phone and use it as a remote. Protected by a 4-digit PIN in the link.
let remote = { port: 0, url: '', qr: '', state: { scenes: [], key: '', paused: false, title: '' } };
function lanAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (all.find((i) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address)) || all[0] || { address: '127.0.0.1' }).address;
}
const REMOTE_PAGE = (pin) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wall remote</title>
<style>body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#061019;color:#e8f1f4;padding:16px}h1{font-size:20px;margin:4px 0 2px}p{color:#8fa7b6;margin:0 0 14px;font-size:14px}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}button{font:inherit;border:1px solid #2a4a63;background:#0d1d2a;color:#e8f1f4;border-radius:14px;padding:16px 10px;font-size:17px;font-weight:600}
button.pri{background:#3cc6d8;color:#04121a;border-color:#3cc6d8}.list button{display:block;width:100%;text-align:left;margin-bottom:8px;font-weight:500;font-size:15px;padding:13px 14px}.list button.on{border-color:#3cc6d8;background:#123044}#now{color:#3cc6d8;font-size:14px;margin-bottom:12px}</style></head>
<body><h1>ERRS Lab Wall remote</h1><p>Controls the big screen this page came from.</p><div id="now"></div>
<div class="row"><button data-c="prev">◀ Back</button><button class="pri" data-c="toggle" id="pp">Pause</button><button data-c="next">Next ▶</button></div>
<div class="row" style="grid-template-columns:1fr 1fr"><button data-c="wake">Wake (30 min)</button><button data-c="sleep">Back to schedule</button></div>
<div class="list" id="list"></div>
<script>const PIN=${JSON.stringify(pin)};
async function cmd(c,k){await fetch('/cmd?pin='+PIN+'&cmd='+c+(k?'&key='+encodeURIComponent(k):''),{method:'POST'});setTimeout(load,350)}
document.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>cmd(b.dataset.c));
async function load(){try{const s=await (await fetch('/state?pin='+PIN)).json();document.getElementById('now').textContent='Showing: '+(s.scenes.find(x=>x.key===s.key)||{label:'—'}).label;document.getElementById('pp').textContent=s.paused?'Play':'Pause';
const l=document.getElementById('list');l.innerHTML='';for(const x of s.scenes){const b=document.createElement('button');b.textContent=x.label;if(x.key===s.key)b.className='on';b.onclick=()=>cmd('goto',x.key);l.appendChild(b)}}catch(e){document.getElementById('now').textContent='The wall is not reachable. Is the PC on the same Wi-Fi?'}}
load();setInterval(load,4000);</script></body></html>`;
function startRemote() {
  if (!settings.remotePin) { settings.remotePin = String(Math.floor(1000 + Math.random() * 9000)); saveSettings(); }
  const pin = settings.remotePin;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/' || u.pathname === '/remote') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(u.searchParams.get('pin') === pin ? REMOTE_PAGE(pin) : '<p style="font-family:sans-serif">Scan the QR code on the wall (Reports → Remote) to open the remote.</p>'); return; }
    if (u.searchParams.get('pin') !== pin) { res.writeHead(403); res.end('Wrong PIN'); return; }
    if (u.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(remote.state)); return; }
    if (u.pathname === '/cmd' && req.method === 'POST') {
      const cmd = u.searchParams.get('cmd');
      if (['next', 'prev', 'toggle', 'pause', 'play', 'goto', 'wake', 'sleep'].includes(cmd)) send('remote-cmd', cmd, u.searchParams.get('key') || '');
      res.writeHead(204); res.end(); return;
    }
    res.writeHead(404); res.end();
  });
  let port = 8770;
  server.on('error', () => { if (port < 8779) { port++; server.listen(port, '0.0.0.0'); } });
  server.on('listening', async () => {
    remote.port = port;
    remote.url = `http://${lanAddress()}:${port}/?pin=${pin}`;
    try { remote.qr = await require('qrcode').toDataURL(remote.url, { margin: 1, width: 360, color: { dark: '#061019', light: '#ffffff' } }); } catch { remote.qr = ''; }
    send('remote-info', { url: remote.url, qr: remote.qr });
  });
  server.listen(port, '0.0.0.0');
}

// ------------------------------------------------------------------- protocol
function resolveAsset(p) {
  const clean = path.posix.normalize('/' + decodeURIComponent(p)).replace(/^\/+/, '');
  const inside = (base, rel) => { const f = path.join(base, rel); return f.startsWith(base) ? f : null; };
  if (clean.startsWith('_blob/')) return findBlob(clean.slice(6));
  if (clean === 'lib/pdf.min.js') return path.join(MODULES, 'pdfjs-dist/build/pdf.min.js');
  if (clean === 'lib/pdf.worker.min.js') return path.join(MODULES, 'pdfjs-dist/build/pdf.worker.min.js');
  if (clean === 'lib/jszip.min.js') return path.join(MODULES, 'jszip/dist/jszip.min.js');
  if (clean === 'lib/html2canvas.min.js') return path.join(MODULES, 'html2canvas/dist/html2canvas.min.js');
  if (clean === 'lib/jspdf.umd.min.js') return path.join(MODULES, 'jspdf/dist/jspdf.umd.min.js');
  if (clean === 'sync.js') return path.join(ROOT, 'shared', 'sync.js');
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
  handle('backup:export', (evt) => exportBackup(BrowserWindow.fromWebContents(evt.sender)));
  handle('backup:import', (evt) => importBackup(BrowserWindow.fromWebContents(evt.sender)));
  handle('blob:list', async () => { try { return (await fsp.readdir(blobDir())).map((n) => n.match(/^([0-9a-f]{32})\./)?.[1]).filter(Boolean); } catch { return []; } });
  handle('blob:get', async (_, id) => { const f = findBlob(id); if (!f) return null; const type = Object.keys(TYPES).find((t) => f.endsWith(TYPES[t])); return { type, bytes: new Uint8Array(await fsp.readFile(f)) }; });
  handle('blob:putId', async (_, id, bytes, type) => { if (!/^[0-9a-f]{32}$/.test(id) || !TYPES[type]) throw new Error('Bad file'); await fsp.mkdir(blobDir(), { recursive: true }); await fsp.writeFile(path.join(blobDir(), id + TYPES[type]), Buffer.from(bytes)); });
  handle('file:save', async (evt, name, bytes) => {
    const ext = path.extname(name).slice(1);
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(evt.sender), { title: 'Save the slide', defaultPath: path.join(app.getPath('pictures'), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, Buffer.from(bytes));
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('update:check', () => checkUpdate());
  handle('update:get', () => update);
  handle('update:install', (evt) => installUpdate(evt));
  handle('remote:info', () => ({ url: remote.url, qr: remote.qr, pin: settings.remotePin }));
  ipcMain.on('remote-state', (_, st) => { remote.state = st; });
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
  startRemote();
  setTimeout(checkUpdate, 20000);
  setInterval(checkUpdate, 6 * 3600 * 1000);
  // Live sync talks to Firestore from the app:// page; make sure the browser's
  // cross-origin checks accept Google's answers for this custom origin.
  const GOOGLE = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|firebaseio\.com|firebaseapp\.com)\//;
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    if (!GOOGLE.test(d.url)) return cb({});
    const h = { ...d.responseHeaders };
    const has = (name) => Object.keys(h).some((k) => k.toLowerCase() === name);
    if (has('access-control-allow-origin') && d.statusCode < 400) return cb({}); // Google already allowed it
    for (const k of Object.keys(h)) if (/^access-control-allow-/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['app://wall'];
    h['Access-Control-Allow-Credentials'] = ['true'];
    h['Access-Control-Allow-Headers'] = ['content-type, authorization, x-goog-api-client, x-goog-api-key, x-firebase-gmpid, x-firebase-client, x-client-data, x-goog-request-params, x-firebase-appcheck, x-goog-user-project, google-cloud-resource-prefix, x-firebase-locale, x-client-version'];
    h['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
    cb(d.method === 'OPTIONS' ? { responseHeaders: h, statusLine: 'HTTP/1.1 200 OK' } : { responseHeaders: h });
  });
});
app.on('window-all-closed', () => app.quit());
