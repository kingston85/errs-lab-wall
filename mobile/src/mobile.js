// ERRS Lab Wall on Android: gives the wall page the same `claude.use(...)`
// services it has online, kept on the device itself — reports, notices,
// samples and photos in the app's own database (IndexedDB), Claude through the
// Anthropic API with a key saved on this device. Loaded before app.js.
(() => {
  'use strict';
  const VERSION = '__APP_VERSION__';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELS = { quick: 'claude-haiku-5-5', default: 'claude-sonnet-5-5', complex: 'claude-opus-5-5' };
  const COLLECTIONS = ['reports', 'config', 'notices', 'photos', 'samples'];
  const BACKUP_FORMAT = 'errs-lab-wall-backup';
  const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const Cap = window.Capacitor;
  const plugin = (name) => (Cap ? (Cap.Plugins && Cap.Plugins[name]) || (Cap.registerPlugin && Cap.registerPlugin(name)) : null);

  window.PDF_WORKER_SRC = 'lib/pdf.worker.min.js';
  window.__noBlobLinks = true;
  window.__toggleFull = () => {}; // the app already runs edge to edge

  // -------------------------------------------------------------- storage
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('errs-lab-wall', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs'); d.createObjectStore('files'); d.createObjectStore('meta'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const st = t.objectStore(store);
      let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage write was cancelled'));
    });
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const key = (col, id) => col + '/' + id;
  const SAFE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function check(col, id) {
    if (!COLLECTIONS.includes(col)) throw new Error('Unknown collection ' + col);
    if (id !== undefined && (!SAFE.test(id) || id.startsWith('.'))) throw new Error('Bad document id');
  }
  async function listDocs(col) {
    check(col);
    return tx('docs', 'readonly', (st) => new Promise((resolve) => {
      const out = [];
      const c = st.openCursor(IDBKeyRange.bound(col + '/', col + '/￿'));
      c.onsuccess = () => { const cur = c.result; if (!cur) { resolve(out); return; } out.push({ id: String(cur.key).slice(col.length + 1), data: cur.value }); cur.continue(); };
      c.onerror = () => resolve(out);
    }));
  }
  const getDoc = (col, id) => { check(col, id); return tx('docs', 'readonly', (st) => req(st.get(key(col, id)))).then((v) => v ?? null); };
  async function setDoc(col, id, data, quiet) { check(col, id); await tx('docs', 'readwrite', (st) => req(st.put(data, key(col, id)))); if (!quiet) changed(col); }
  async function updateDoc(col, id, patch) {
    const cur = await getDoc(col, id);
    if (!cur) throw Object.assign(new Error('That item no longer exists.'), { code: 'not_found' });
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch || {})) { if (v && typeof v === 'object' && v.__delete__ === true) delete next[k]; else next[k] = v; }
    await setDoc(col, id, next);
  }
  async function deleteDoc(col, id) { check(col, id); await tx('docs', 'readwrite', (st) => req(st.delete(key(col, id)))); changed(col); }

  const watchers = new Map();
  const watch = (col, fn) => { if (!watchers.has(col)) watchers.set(col, new Set()); watchers.get(col).add(fn); return () => watchers.get(col).delete(fn); };
  function changed(col) { for (const fn of watchers.get(col) || []) fn(); }

  async function seedIfNew() {
    const done = await tx('meta', 'readonly', (st) => req(st.get('seeded')));
    if (done) return;
    try {
      const res = await fetch('seed.json');
      const seed = await res.json();
      for (const d of seed) await setDoc(d.collection, d.id, d.data, true);
    } catch (e) { console.warn('seed failed', e); }
    await tx('meta', 'readwrite', (st) => req(st.put(new Date().toISOString(), 'seeded')));
  }
  const ready = seedIfNew();

  // ------------------------------------------------------------ db service
  const snapOf = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
  const plain = (v) => JSON.parse(JSON.stringify(v));
  function docRef(col, id) {
    return {
      id,
      get: async () => { await ready; const d = await getDoc(col, id); return { exists: !!d, id, data: () => d || undefined }; },
      set: (data) => setDoc(col, id, plain(data)),
      update: (patch) => updateDoc(col, id, plain(patch)),
      delete: () => deleteDoc(col, id),
      onSnapshot(fn, onErr) {
        const run = () => ready.then(() => getDoc(col, id)).then((d) => fn({ exists: !!d, id, data: () => d || undefined }), (e) => onErr && onErr(e));
        run();
        return watch(col, run);
      },
    };
  }
  const db = {
    collection: (col) => ({
      doc: (id) => docRef(col, id),
      onSnapshot(fn, onErr) {
        const run = () => ready.then(() => listDocs(col)).then((docs) => fn(snapOf(docs)), (e) => onErr && onErr(e));
        run();
        return watch(col, run);
      },
    }),
    doc: (p) => { const [c, i] = String(p).split('/'); return docRef(c, i); },
  };

  // ---------------------------------------------------------------- files
  const urls = new Map();
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  async function putFile(blob, type) {
    if (!TYPES.includes(type)) throw Object.assign(new Error('Only PDF and image files can be stored.'), { code: 'unsupported_type' });
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await tx('files', 'readwrite', (st) => req(st.put({ type, blob }, id)));
    return id;
  }
  const getFile = (id) => tx('files', 'readonly', (st) => req(st.get(id)));
  window.__blobUrl = (id) => {
    if (!id) return BLANK;
    if (urls.has(id)) return urls.get(id) || BLANK;
    urls.set(id, '');
    getFile(id).then((f) => {
      if (!f) return;
      const u = URL.createObjectURL(f.blob);
      urls.set(id, u);
      document.querySelectorAll(`img[data-blob="${id}"]`).forEach((img) => { img.src = u; img.closest('figure')?.classList.remove('broken'); });
    });
    return BLANK;
  };
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type;
      const id = await putFile(blob, type);
      urls.set(id, URL.createObjectURL(blob));
      return { id, url: urls.get(id), sizeBytes: blob.size, contentType: type };
    },
    async delete(id) { await tx('files', 'readwrite', (st) => req(st.delete(id))); },
    list: async () => ({ assets: [], usage: {} }),
  };

  // --------------------------------------------------------------- Claude
  const settings = {
    get key() { try { return localStorage.getItem('wall.apiKey') || ''; } catch { return ''; } },
    set key(v) { try { if (v) localStorage.setItem('wall.apiKey', v); else localStorage.removeItem('wall.apiKey'); } catch { /* storage off */ } },
    get model() { try { return localStorage.getItem('wall.model') || 'auto'; } catch { return 'auto'; } },
    set model(v) { try { localStorage.setItem('wall.model', v); } catch { /* storage off */ } },
  };
  const err = (code, message, extra) => Object.assign(new Error(message), { code, desktop: true }, extra || {});
  async function ask(input, opts, json) {
    const apiKey = settings.key;
    if (!apiKey) throw err('not_granted', 'Claude needs an Anthropic API key on this device. Open Reports → Device and paste the key.');
    const model = settings.model !== 'auto' ? settings.model : (MODELS[opts?.modelTier] || MODELS.default);
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    const body = {
      model, max_tokens: json ? 32000 : 4000, stream: true, messages,
      system: json ? 'You turn reports into data. Reply with one valid JSON value only: no prose, no markdown fences.' : 'You are a careful assistant for the ERRS Department of the Environmental Protection Agency of Liberia.',
    };
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST', signal: opts?.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw err('cancelled', 'Stopped.');
      throw err('network', 'Could not reach Claude. Check the internet connection on this device.');
    }
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json())?.error?.message || ''; } catch { /* no body */ }
      if (res.status === 401 || res.status === 403) throw err('not_granted', 'The Anthropic API key was not accepted. Check it in Reports → Device.');
      if (res.status === 429 || res.status === 529 || res.status === 503) throw err('rate_limited', 'Claude is busy or the API usage limit was reached. Try again in a few minutes.');
      if (res.status === 400 && /too long|too many tokens|context/i.test(msg)) throw err('prompt_too_large', 'This report is too long to read in one go. Split it into smaller files.');
      if (res.status === 400 && /credit|billing|balance/i.test(msg)) throw err('rate_limited', 'The Anthropic account has no API credit left. Add credit in the Anthropic Console.');
      if (res.status === 404 && /model/i.test(msg)) throw err('model_unavailable', `The model "${model}" is not available to this API key. Choose another model in Reports → Device.`);
      throw err('server_error', `Claude could not answer (${res.status}${msg ? ': ' + msg : ''}).`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', stop = null, prev = '';
    try {
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
          else if (ev.type === 'error') throw err(ev.error?.type === 'overloaded_error' ? 'rate_limited' : 'server_error', 'Claude stopped with an error: ' + (ev.error?.message || 'unknown'));
        }
        if (!json && opts?.onText && text !== prev) { opts.onText({ text, delta: text.slice(prev.length) }); prev = text; }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw err('cancelled', 'Stopped.', { text });
      throw e.code ? e : err('network', 'The connection to Claude was lost. Try again.');
    }
    return { text, truncated: stop === 'max_tokens' };
  }
  async function sample(input, opts = {}) { const r = await ask(input, opts, false); return { text: r.text, truncated: r.truncated }; }
  sample.json = async (input, opts = {}) => {
    const r = await ask(input, opts, true);
    let t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch {
      throw err('invalid_json', r.truncated ? 'Claude\'s answer was cut off because the report is very long. Split the file into smaller parts and upload them separately.' : 'Claude\'s answer could not be read as data. Try again.', { text: r.text });
    }
  };
  sample.limits = async () => ({ images: false });

  const user = { can: async () => true, canEdit: () => true, isOwner: () => true, id: async () => 'local', me: async () => ({ id: 'local', name: 'This device' }) };
  const services = { db, sample, assets, user };
  window.claude = { use: async (name) => services[name] || null };

  // --------------------------------------------------------------- backup
  const toB64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  async function buildBackup() {
    const out = { format: BACKUP_FORMAT, version: 1, created: new Date().toISOString(), source: 'Android', collections: {}, files: [] };
    let docs = 0;
    for (const col of COLLECTIONS) { out.collections[col] = await listDocs(col); docs += out.collections[col].length; }
    const ids = await tx('files', 'readonly', (st) => req(st.getAllKeys()));
    for (const id of ids) { const f = await getFile(id); if (f) out.files.push({ id, type: f.type, data: await toB64(f.blob) }); }
    return { json: JSON.stringify(out), docs, files: out.files.length };
  }
  async function exportBackup() {
    const FS = plugin('Filesystem'), Share = plugin('Share');
    const { json, docs, files } = await buildBackup();
    const name = `ERRS-Lab-Wall-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (!FS || !Share) { // fallback outside the app (browser preview)
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.click();
      return { docs, files };
    }
    const CHUNK = 512 * 1024;
    await FS.writeFile({ path: name, data: json.slice(0, CHUNK), directory: 'CACHE', encoding: 'utf8' });
    for (let i = CHUNK; i < json.length; i += CHUNK) await FS.appendFile({ path: name, data: json.slice(i, i + CHUNK), directory: 'CACHE', encoding: 'utf8' });
    const { uri } = await FS.getUri({ path: name, directory: 'CACHE' });
    await Share.share({ title: 'ERRS Lab Wall backup', text: 'Backup of the ERRS Lab Wall', files: [uri], dialogTitle: 'Save or send the backup' });
    return { docs, files };
  }
  async function importBackupText(text) {
    let b;
    try { b = JSON.parse(text); } catch { throw new Error('That file is not a wall backup.'); }
    if (!b || b.format !== BACKUP_FORMAT) throw new Error('That file is not a wall backup.');
    let docs = 0, files = 0;
    for (const col of COLLECTIONS) {
      for (const d of Array.isArray(b.collections?.[col]) ? b.collections[col] : []) {
        if (!d || typeof d.id !== 'string' || !SAFE.test(d.id) || d.id.startsWith('.') || !d.data || typeof d.data !== 'object') continue;
        await setDoc(col, d.id, d.data, true); docs++;
      }
    }
    for (const f of Array.isArray(b.files) ? b.files : []) {
      if (!f || !/^[0-9a-f]{32}$/.test(f.id) || !TYPES.includes(f.type) || typeof f.data !== 'string') continue;
      const have = await getFile(f.id);
      if (have) continue;
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      await tx('files', 'readwrite', (st) => req(st.put({ type: f.type, blob: new Blob([bytes], { type: f.type }) }, f.id)));
      files++;
    }
    for (const col of COLLECTIONS) changed(col);
    return { docs, files };
  }

  // ------------------------------------------------- "Device" settings tab
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MODEL_CHOICES = [['auto', 'Automatic (recommended)'], ['claude-opus-5-5', 'Claude Opus 5.5 — most careful, slower'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — balanced'], ['claude-haiku-5-5', 'Claude Haiku 5.5 — fastest']];
  function note(msg, ok) { const n = document.getElementById('dNote'); if (n) { n.textContent = msg; n.style.color = ok ? 'var(--good)' : 'var(--amber)'; } }
  function render() {
    const k = settings.key;
    return `<div class="rep"><div class="tt"><b>Claude on this device</b><small>${k ? 'Key saved …' + esc(k.slice(-4)) : 'No key yet'}</small></div>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">Reading reports and the Ask tab use the Anthropic API. Create a key at console.anthropic.com (API keys), then paste it here. It is kept in this app on this device only. API use is billed to that Anthropic account.</div>
      <label class="f">Anthropic API key<input id="dKey" type="password" autocomplete="off" placeholder="${k ? 'Paste a new key to replace the saved one' : 'sk-ant-…'}"></label>
      <label class="f">Model<select id="dModel">${MODEL_CHOICES.map(([v, l]) => `<option value="${v}" ${settings.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row"><button class="btn pri" data-dact="saveKey">Save</button><button class="btn" data-dact="testKey" ${k ? '' : 'disabled'}>Test</button>${k ? '<button class="btn dng" data-dact="clearKey">Remove key</button>' : ''}</div></div>
    <div class="rep"><div class="tt"><b>Backup and move data</b></div>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">The wall's reports, notices, samples and photos are kept in this app on this device. To copy them to the Windows app or another Android device, save a backup here and open it there (Windows: Reports → Computer → Open backup). Opening a backup adds its items and replaces items with the same name; nothing else is deleted.</div>
      <div class="row"><button class="btn" data-dact="export">Save or send backup…</button><label class="btn" style="display:inline-block">Open backup…<input id="dImport" type="file" accept=".json,application/json" hidden></label></div></div>
    <div class="rep"><div class="tt"><b>On a TV or tablet</b></div>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">The screen stays on while the wall is open. With a TV remote or keyboard: ← → change slide, OK or space pauses, M opens this panel, Back closes it.</div></div>
    <div id="dNote" style="font-size:13px" aria-live="polite"></div>
    <div style="font-size:12px;color:var(--dim)">ERRS Lab Wall for Android ${esc(VERSION)}</div>`;
  }
  function wire(p) {
    const rerender = () => { p.innerHTML = render(); wire(p); };
    p.querySelectorAll('[data-dact]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.dact;
      try {
        if (act === 'saveKey') {
          const k = document.getElementById('dKey').value.trim();
          if (k && !/^sk-ant-/.test(k)) { note('That does not look like an Anthropic API key (it should start with sk-ant-).'); return; }
          if (k) settings.key = k;
          settings.model = document.getElementById('dModel').value;
          rerender(); note('Saved.', true);
        } else if (act === 'clearKey') { settings.key = ''; rerender(); note('Key removed.', true); }
        else if (act === 'testKey') { b.disabled = true; note('Asking Claude…', true); const r = await sample('Reply with the single word: ready', { modelTier: 'quick' }); b.disabled = false; note(`Claude answered: “${r.text.trim()}”. Reading reports will work.`, true); }
        else if (act === 'export') { b.disabled = true; note('Preparing the backup…', true); const r = await exportBackup(); b.disabled = false; note(`Backup ready: ${r.docs} items and ${r.files} files.`, true); }
      } catch (e) { b.disabled = false; note(e.message || String(e)); }
    }));
    const imp = document.getElementById('dImport');
    imp?.addEventListener('change', async () => {
      const f = imp.files && imp.files[0];
      if (!f) return;
      note('Opening the backup…', true);
      try { const r = await importBackupText(await f.text()); note(`Added ${r.docs} items and ${r.files} files from the backup.`, true); } catch (e) { note(e.message || String(e)); }
      imp.value = '';
    });
  }
  window.__desktopPane = { render, wire };

  // Android back button closes the panel first; TV remote OK/centre = pause
  document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelector('#manage .tabs');
    if (tabs && !tabs.querySelector('[data-tab="computer"]')) {
      const b = document.createElement('button');
      b.setAttribute('role', 'tab'); b.dataset.tab = 'computer'; b.setAttribute('aria-selected', 'false'); b.textContent = 'Device';
      tabs.appendChild(b);
    }
    const st = document.createElement('style');
    st.textContent = '#bFull{display:none!important} body{padding-left:0!important;padding-right:0!important}';
    document.head.appendChild(st);
    const App = plugin('App');
    App?.addListener?.('backButton', () => {
      const m = document.getElementById('manage');
      if (m && !m.hidden) document.getElementById('mClose')?.click();
      else App.exitApp?.();
    });
  });
})();
