// Gives the wall page the same `claude.use(...)` services it has online, backed
// by the desktop shell: files in the data folder instead of the shared
// database, and the Anthropic API (with this computer's key) instead of the
// signed-in Claude session. Loaded before app.js.
(() => {
  'use strict';
  const D = window.desktop;
  if (!D) return;
  window.PDF_WORKER_SRC = 'lib/pdf.worker.min.js';

  // ------------------------------------------------------------------ db
  const watchers = new Map(); // collection -> Set of refresh functions
  const watch = (col, fn) => { if (!watchers.has(col)) watchers.set(col, new Set()); watchers.get(col).add(fn); return () => watchers.get(col).delete(fn); };
  D.onDbChanged((col) => { for (const fn of watchers.get(col) || []) fn(); });
  const snapOf = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });

  function docRef(col, id) {
    return {
      id,
      get: async () => { const d = await D.get(col, id); return { exists: !!d, id, data: () => d || undefined }; },
      set: (data) => D.set(col, id, JSON.parse(JSON.stringify(data))),
      update: (patch) => D.update(col, id, JSON.parse(JSON.stringify(patch))),
      delete: () => D.del(col, id),
      onSnapshot(fn, onErr) {
        const run = () => D.get(col, id).then((d) => fn({ exists: !!d, id, data: () => d || undefined }), (e) => onErr && onErr(e));
        run();
        return watch(col, run);
      },
    };
  }
  function collection(col) {
    return {
      doc: (id) => docRef(col, id),
      onSnapshot(fn, onErr) {
        const run = () => D.list(col).then((docs) => fn(snapOf(docs)), (e) => onErr && onErr(e));
        run();
        return watch(col, run);
      },
    };
  }
  const db = { collection, doc: (p) => { const [c, i] = String(p).split('/'); return docRef(c, i); } };

  // -------------------------------------------------------------- sample
  const streams = new Map();
  D.onAskDelta((id, text) => { const fn = streams.get(id); if (fn) fn(text); });
  let seq = 0;
  async function run(input, opts, json) {
    const id = 'a' + (++seq) + Date.now().toString(36);
    let prev = '';
    if (opts?.onText) streams.set(id, (text) => { const delta = text.slice(prev.length); prev = text; opts.onText({ text, delta }); });
    const onAbort = () => D.cancel(id);
    opts?.signal?.addEventListener('abort', onAbort);
    try {
      const r = await D.ask({ id, input, json, tier: opts?.modelTier || 'default' });
      if (r.error) throw Object.assign(new Error(r.error.message), r.error);
      return r;
    } finally { streams.delete(id); opts?.signal?.removeEventListener('abort', onAbort); }
  }
  async function sample(input, opts = {}) {
    const r = await run(input, opts, false);
    return { text: r.text, truncated: r.truncated };
  }
  sample.json = async (input, opts = {}) => {
    const r = await run(input, opts, true);
    let t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch {
      throw Object.assign(new Error(r.truncated ? 'Claude\'s answer was cut off because the report is very long. Split the file into smaller parts and upload them separately.' : 'Claude\'s answer could not be read as data. Try again.'), { code: 'invalid_json', desktop: true, text: r.text });
    }
  };
  sample.limits = async () => ({ images: false });

  // -------------------------------------------------------------- assets
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return D.putBlob(bytes, type);
    },
    delete: (id) => D.delBlob(id),
    list: async () => ({ assets: [], usage: {} }),
  };

  // ---------------------------------------------------------------- user
  const user = { can: async () => true, canEdit: () => true, isOwner: () => true, id: async () => 'local', me: async () => ({ id: 'local', name: 'This computer' }) };

  const services = { db, sample, assets, user };
  window.claude = { use: async (name) => services[name] || null };

  // ----------------------------------------------- "Computer" settings tab
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let cur = null;
  const MODEL_CHOICES = [['auto', 'Automatic (recommended)'], ['claude-opus-5-5', 'Claude Opus 5.5 — most careful, slower'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — balanced'], ['claude-haiku-5-5', 'Claude Haiku 5.5 — fastest']];
  function note(msg, ok) { const n = document.getElementById('dNote'); if (n) { n.textContent = msg; n.style.color = ok ? 'var(--good)' : 'var(--amber)'; } }
  function render() {
    const s = cur;
    if (!s) { D.settings().then((x) => { cur = x; const p = document.getElementById('pane'); if (p && window.__wall?.S.tab === 'computer') { p.innerHTML = render(); wire(p); } }); return '<div style="color:var(--dim)">Loading…</div>'; }
    const shared = s.dataDir !== s.defaultDir;
    return `<div class="rep"><div class="tt"><b>Claude on this computer</b><small>${s.hasKey ? 'Key saved ' + esc(s.keyHint) : 'No key yet'}</small></div>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">Reading reports and the Ask tab use the Anthropic API. Create a key at console.anthropic.com (API keys), then paste it here. It is stored encrypted on this computer only, never in the shared data folder. API use is billed to that Anthropic account.</div>
      <label class="f">Anthropic API key<input id="dKey" type="password" autocomplete="off" placeholder="${s.hasKey ? 'Paste a new key to replace the saved one' : 'sk-ant-…'}"></label>
      <label class="f">Model<select id="dModel">${MODEL_CHOICES.map(([v, l]) => `<option value="${v}" ${s.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row"><button class="btn pri" data-dact="saveKey">Save</button><button class="btn" data-dact="testKey" ${s.hasKey ? '' : 'disabled'}>Test</button>${s.hasKey ? '<button class="btn dng" data-dact="clearKey">Remove key</button>' : ''}</div></div>
    <div class="rep"><div class="tt"><b>Data folder</b><small>${shared ? 'Custom folder' : 'This computer only'}</small></div>
      <div class="mono" style="font-size:12px;color:var(--ink);overflow-wrap:anywhere;background:#071420;border:1px solid var(--line2);border-radius:8px;padding:8px 10px">${esc(s.dataDir)}</div>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">Reports, notices, samples and photos are kept here as ordinary files. To show the same wall on several computers (the big screen and your office laptop), choose a folder they all share, such as a OneDrive or network folder. Each computer checks it every few seconds.</div>
      <div class="row"><button class="btn" data-dact="chooseDir">Choose folder…</button><button class="btn" data-dact="openDir">Open folder</button>${shared ? '<button class="btn" data-dact="resetDir">Use this computer only</button>' : ''}</div></div>
    <div class="rep"><div class="tt"><b>Big-screen behaviour</b></div>
      <label class="switch"><input type="checkbox" id="dFull" ${s.fullscreen ? 'checked' : ''}>Open in full screen</label>
      <label class="switch"><input type="checkbox" id="dAuto" ${s.autostart ? 'checked' : ''}>Start the wall when Windows starts</label>
      <div style="font-size:13px;color:var(--dim);line-height:1.5">The screen is kept awake while the wall is open. Keys: F11 full screen, ← → change slide, space pause, M this panel, F5 reload, Alt+F4 quit.</div></div>
    <div id="dNote" style="font-size:13px" aria-live="polite"></div>
    <div style="font-size:12px;color:var(--dim)">ERRS Lab Wall ${esc(s.version)} · ${esc(s.computer)}</div>`;
  }
  async function refresh(p) { cur = await D.settings(); p.innerHTML = render(); wire(p); }
  function wire(p) {
    p.querySelectorAll('[data-dact]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.dact;
      try {
        if (act === 'saveKey') {
          const k = document.getElementById('dKey').value.trim();
          const patch = { model: document.getElementById('dModel').value };
          if (k) { if (!/^sk-ant-/.test(k)) { note('That does not look like an Anthropic API key (it should start with sk-ant-).'); return; } patch.apiKey = k; }
          await D.setSettings(patch); await refresh(p); note('Saved.', true);
        } else if (act === 'clearKey') { await D.setSettings({ apiKey: '' }); await refresh(p); note('Key removed.', true); }
        else if (act === 'testKey') { b.disabled = true; note('Asking Claude…', true); const r = await D.testKey(); note(`Claude answered: “${r}”. Reading reports will work.`, true); b.disabled = false; }
        else if (act === 'chooseDir') { const d = await D.chooseDir(); if (d) { await refresh(p); note('The wall now uses this folder.', true); } }
        else if (act === 'resetDir') { await D.resetDir(); await refresh(p); note('The wall now uses this computer\'s own folder.', true); }
        else if (act === 'openDir') await D.openDir();
      } catch (e) { b.disabled = false; note(e.message || String(e)); }
    }));
    const full = document.getElementById('dFull'), auto = document.getElementById('dAuto');
    full?.addEventListener('change', () => D.setSettings({ fullscreen: full.checked }).then(() => note('Saved. Applies next time the wall opens.', true)));
    auto?.addEventListener('change', () => D.setSettings({ autostart: auto.checked }).then(() => note(auto.checked ? 'The wall will start with Windows.' : 'The wall will not start with Windows.', true)));
  }
  window.__desktopPane = { render, wire };

  // add the tab once the page markup exists
  document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelector('#manage .tabs');
    if (tabs && !tabs.querySelector('[data-tab="computer"]')) {
      const b = document.createElement('button');
      b.setAttribute('role', 'tab'); b.dataset.tab = 'computer'; b.setAttribute('aria-selected', 'false'); b.textContent = 'Computer';
      tabs.appendChild(b);
    }
  });
})();
