// Live sync for the Windows and Android apps.
//
// Each device keeps its own copy of the wall (files on Windows, the app's
// database on Android) and this engine mirrors it to a Firestore database the
// department owns, so a sample logged on a phone reaches the big screen in
// seconds. Everything lives under walls/<wallId>/; the wall id is a long random
// secret shared through the "sync code". Deleted items are kept as small
// tombstones so a device that was offline deletes them too.
(() => {
  'use strict';
  const COLS = ['reports', 'config', 'notices', 'photos', 'samples'];
  const MAX_FILE = 700 * 1024; // keeps each Firestore document under its 1 MB limit
  const PREFIX = 'ERRSWALL-';

  const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function makeCode(cfg, wall) { return PREFIX + b64u(JSON.stringify({ c: cfg, w: wall })); }
  function parseCode(code) {
    const t = String(code || '').trim().replace(/\s+/g, '');
    if (!t.startsWith(PREFIX)) throw new Error('That is not a wall sync code. It starts with ERRSWALL-.');
    let o;
    try { o = JSON.parse(unb64u(t.slice(PREFIX.length))); } catch { throw new Error('That sync code is damaged. Copy it again in full.'); }
    if (!o?.c?.apiKey || !o?.c?.projectId || !o?.w) throw new Error('That sync code is incomplete.');
    return { cfg: o.c, wall: o.w };
  }
  // Accepts the "const firebaseConfig = {...}" block from the Firebase console, or plain JSON.
  function parseFirebaseConfig(text) {
    const cfg = {};
    for (const m of String(text || '').matchAll(/["']?(apiKey|authDomain|projectId|storageBucket|messagingSenderId|appId)["']?\s*:\s*["']([^"']+)["']/g)) cfg[m[1]] = m[2];
    if (!cfg.apiKey || !cfg.projectId) throw new Error('Paste the whole firebaseConfig block from the Firebase console (it contains apiKey and projectId).');
    if (!cfg.authDomain) cfg.authDomain = cfg.projectId + '.firebaseapp.com';
    return { apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, appId: cfg.appId || '' };
  }
  function newWallId() { return [...crypto.getRandomValues(new Uint8Array(15))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); }

  const toB64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  const fromB64 = (s, type) => new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type });
  async function shrinkForCloud(blob, type) {
    if (blob.size <= MAX_FILE) return blob;
    if (!/^image\//.test(type)) return null; // large PDFs stay on the device that uploaded them
    try {
      const bmp = await createImageBitmap(blob);
      for (const [px, q] of [[1600, 0.8], [1280, 0.72], [1024, 0.65]]) {
        const k = Math.min(1, px / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
        if (out && out.size <= MAX_FILE) return out;
      }
    } catch { /* fall through */ }
    return null;
  }

  function create(local) {
    // local: { list(col) -> [{id,data}], get(col,id), put(col,id,data), remove(col,id),
    //          fileIds() -> [id], getFile(id) -> {type, blob} | null, putFile(id, type, blob), changed(col) }
    const S = { status: 'off', message: '', last: null, code: '', wall: '', app: null, db: null, unsubs: [], listeners: new Set(), device: Math.random().toString(36).slice(2, 10) };
    const emit = () => { for (const fn of S.listeners) { try { fn(state()); } catch { /* ignore */ } } };
    const state = () => ({ status: S.status, message: S.message, last: S.last, code: S.code });
    const setStatus = (status, message = '') => { S.status = status; S.message = message; emit(); };

    // "dirty" = local changes not yet confirmed by the cloud; they win over cloud copies
    const dirtyKey = () => 'wall.sync.dirty.' + S.wall;
    const loadDirty = () => { try { return JSON.parse(localStorage.getItem(dirtyKey()) || '{}'); } catch { return {}; } };
    const saveDirty = (d) => { try { localStorage.setItem(dirtyKey(), JSON.stringify(d)); } catch { /* storage off */ } };
    const markDirty = (k, v) => { const d = loadDirty(); if (v) d[k] = v; else delete d[k]; saveDirty(d); };

    const ref = (col, id) => S.db.collection('walls').doc(S.wall).collection(col).doc(id);
    const touch = () => { S.last = new Date(); emit(); };

    async function pushDoc(col, id) {
      if (!S.db) return;
      const k = col + '/' + id;
      const data = await local.get(col, id);
      const rec = data ? { j: JSON.stringify(data), t: Date.now(), by: S.device } : { del: true, t: Date.now(), by: S.device };
      markDirty(k, data ? 'set' : 'del');
      try { await ref(col, id).set(rec); markDirty(k, null); touch(); } catch (e) { setStatus('error', 'Could not send a change: ' + (e.message || e.code)); }
    }
    async function pushFile(id) {
      if (!S.db) return;
      const f = await local.getFile(id);
      if (!f) return;
      const small = await shrinkForCloud(f.blob, f.type);
      if (!small) return;
      const type = small === f.blob ? f.type : 'image/jpeg';
      try {
        await ref('files', id).set({ type, d: await toB64(small), size: small.size });
        await ref('fileIdx', id).set({ type, size: small.size, t: Date.now() });
        touch();
      } catch (e) { console.warn('file sync failed', id, e); }
    }

    async function applyRemote(col, change) {
      const id = change.doc.id;
      const k = col + '/' + id;
      if (loadDirty()[k]) return; // our own change is still on its way up
      const rec = change.doc.data() || {};
      const mine = await local.get(col, id);
      if (rec.del) { if (mine) { await local.remove(col, id); local.changed(col); touch(); } return; }
      if (typeof rec.j !== 'string') return;
      if (mine && JSON.stringify(mine) === rec.j) return;
      let data; try { data = JSON.parse(rec.j); } catch { return; }
      await local.put(col, id, data);
      local.changed(col);
      touch();
    }

    async function listen(col) {
      let first = true;
      return new Promise((resolve) => {
        const un = S.db.collection('walls').doc(S.wall).collection(col).onSnapshot(async (snap) => {
          const changes = snap.docChanges();
          for (const ch of changes) { if (ch.type !== 'removed') await applyRemote(col, ch); }
          if (first) {
            first = false;
            // upload what only this device has, and changes made while offline
            const cloud = new Set(snap.docs.map((d) => d.id));
            const dirty = loadDirty();
            for (const d of await local.list(col)) { if (!cloud.has(d.id) || dirty[col + '/' + d.id]) await pushDoc(col, d.id); }
            for (const k of Object.keys(dirty)) { const [c, i] = k.split('/'); if (c === col && dirty[k] === 'del') await pushDoc(col, i); }
            resolve();
          }
        }, (err) => { setStatus('error', 'Live sync stopped: ' + (err.message || err.code)); resolve(); });
        S.unsubs.push(un);
      });
    }
    async function listenFiles() {
      let first = true;
      const un = S.db.collection('walls').doc(S.wall).collection('fileIdx').onSnapshot(async (snap) => {
        const have = new Set(await local.fileIds());
        for (const ch of snap.docChanges()) {
          const id = ch.doc.id;
          if (ch.type === 'removed' || have.has(id)) continue;
          try {
            const f = await ref('files', id).get();
            if (f.exists) { const v = f.data(); await local.putFile(id, v.type, fromB64(v.d, v.type)); local.changed('photos'); touch(); }
          } catch (e) { console.warn('file download failed', id, e); }
        }
        if (first) {
          first = false;
          const cloud = new Set(snap.docs.map((d) => d.id));
          for (const id of have) if (!cloud.has(id)) await pushFile(id);
        }
      }, (err) => console.warn('file sync stopped', err));
      S.unsubs.push(un);
    }

    async function start(code) {
      const fb = window.firebase;
      if (!fb) throw new Error('The sync library did not load.');
      const { cfg, wall } = parseCode(code);
      stop(true);
      S.code = code.trim(); S.wall = wall;
      setStatus('connecting', 'Connecting…');
      try {
        const name = 'wall-' + wall;
        S.app = fb.apps.find((a) => a.name === name) || fb.initializeApp(cfg, name);
        await S.app.auth().signInAnonymously();
        S.db = S.app.firestore();
        try { S.db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch { /* settings already applied */ }
        await Promise.all(COLS.map(listen));
        await listenFiles();
        try { localStorage.setItem('wall.sync.code', S.code); } catch { /* storage off */ }
        setStatus('on', 'Connected');
        touch();
      } catch (e) {
        const msg = /api-key|API key/i.test(e.message || '') ? 'Firebase did not accept the project settings in this code.'
          : /admin-restricted|operation-not-allowed/i.test((e.code || '') + (e.message || '')) ? 'Anonymous sign-in is not turned on in the Firebase project (Authentication → Sign-in method → Anonymous).'
          : /permission/i.test((e.code || '') + (e.message || '')) ? 'The Firestore rules do not allow the wall yet. Paste the rules from the setup steps and publish them.'
          : /network|unavailable|offline/i.test((e.code || '') + (e.message || '')) ? 'No internet connection. Sync will start when the device is online — press Connect again.'
          : (e.message || String(e));
        setStatus('error', msg);
        throw new Error(msg);
      }
    }
    function stop(keepCode) {
      for (const un of S.unsubs) { try { un(); } catch { /* ignore */ } }
      S.unsubs = [];
      S.db = null;
      if (!keepCode) { try { localStorage.removeItem('wall.sync.code'); } catch { /* ignore */ } S.code = ''; }
      setStatus('off');
    }
    async function pushAll() { if (!S.db) return; for (const col of COLS) for (const d of await local.list(col)) await pushDoc(col, d.id); for (const id of await local.fileIds()) await pushFile(id); }
    function resume() { let c = ''; try { c = localStorage.getItem('wall.sync.code') || ''; } catch { /* ignore */ } if (c) start(c).catch(() => {}); }

    return {
      start, stop, resume, pushAll, state,
      onLocalWrite: (col, id) => { if (S.db && COLS.includes(col)) pushDoc(col, id); },
      onLocalFile: (id) => { if (S.db) pushFile(id); },
      onState: (fn) => { S.listeners.add(fn); fn(state()); return () => S.listeners.delete(fn); },
    };
  }

  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /walls/{wall}/{document=**} {
      allow read, write: if request.auth != null && wall.size() >= 16;
    }
  }
}`;

  // Settings block shared by the Windows "Computer" tab and the Android "Device" tab.
  function settingsHtml(sync, esc) {
    const st = sync.state();
    const dot = { off: '#5f7a8c', connecting: '#f5b84a', on: '#3ddc97', error: '#ff6b5e' }[st.status];
    const head = `<div class="tt"><b>Live sync across devices</b><small><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot};margin-right:6px"></span>${esc(st.status === 'on' ? 'Connected' + (st.last ? ' · last change ' + st.last.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '') : st.status === 'connecting' ? 'Connecting…' : st.status === 'error' ? 'Problem' : 'Off')}</small></div>`;
    if (st.status === 'on' || (st.status === 'error' && st.code)) {
      return `<div class="rep" id="syncBox">${head}
        ${st.status === 'error' ? `<div class="note">${esc(st.message)}</div>` : ''}
        <div style="font-size:13px;color:var(--dim);line-height:1.5">Every device with this sync code shows the same wall. To add a phone, PC or Android TV, open Reports → ${window.desktop ? 'Computer' : 'Device'} there and paste this code under "Join".</div>
        <label class="f">Sync code<textarea id="syCode" readonly class="code" style="min-height:70px">${esc(st.code)}</textarea></label>
        <div class="row"><button class="btn" data-sact="copy">Copy code</button>${st.status === 'error' ? '<button class="btn pri" data-sact="retry">Connect again</button>' : ''}<button class="btn dng" data-sact="stop">Stop syncing on this device</button></div></div>`;
    }
    return `<div class="rep" id="syncBox">${head}
      ${st.status === 'error' ? `<div class="note">${esc(st.message)}</div>` : ''}
      <div style="font-size:13px;color:var(--dim);line-height:1.5">Keep the big screen, office PCs, phones and Android TVs showing the same wall: a report, notice, photo or sample added on one appears on the others within seconds. It uses a free Firebase database that the department owns.</div>
      <label class="f">Join: paste the sync code from a device that is already syncing<textarea id="syJoin" class="code" style="min-height:60px" placeholder="ERRSWALL-…"></textarea></label>
      <div class="row"><button class="btn pri" data-sact="join">Join</button></div>
      <details><summary style="cursor:pointer;font-weight:600;font-size:14px">First device: set up the free Firebase database (about 10 minutes)</summary>
        <ol style="font-size:13px;line-height:1.6;color:#cfe0e7;padding-left:18px">
          <li>On a computer, go to <b>console.firebase.google.com</b>, sign in with a Google account, and click <b>Create a project</b> (name it, for example, errs-lab-wall; Google Analytics can be off).</li>
          <li><b>Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.</b></li>
          <li><b>Build → Firestore Database → Create database</b>, choose a location, start in <b>production mode</b>.</li>
          <li>In Firestore, open <b>Rules</b>, replace everything with the rules below, and click <b>Publish</b>.</li>
          <li>Click the gear → <b>Project settings → Your apps → Web (&lt;/&gt;)</b>, register an app (any name), and copy the <b>firebaseConfig</b> block. Paste it below.</li>
        </ol>
        <label class="f">Firestore rules<textarea class="code" readonly style="min-height:150px">${esc(RULES)}</textarea></label>
        <div class="row"><button class="btn" data-sact="copyRules">Copy rules</button></div>
        <label class="f">firebaseConfig block<textarea id="syCfg" class="code" style="min-height:110px" placeholder='const firebaseConfig = { apiKey: "…", authDomain: "…", projectId: "…", … };'></textarea></label>
        <div class="row"><button class="btn pri" data-sact="create">Create the shared wall</button></div>
      </details></div>`;
  }
  // Draws the block into #syncBox (or appends nothing if it is absent) and keeps it current.
  function mountSettings(sync, esc, note) {
    const draw = () => {
      const box = document.getElementById('syncBox');
      if (!box) return;
      const t = document.createElement('div');
      t.innerHTML = settingsHtml(sync, esc);
      const fresh = t.firstElementChild;
      box.replaceWith(fresh);
      wire(fresh);
    };
    const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); note(msg, true); } catch { note('Select the text and copy it by hand.'); } };
    function wire(root) {
      root.querySelectorAll('[data-sact]').forEach((b) => b.addEventListener('click', async () => {
        const act = b.dataset.sact;
        try {
          if (act === 'copy') return copy(sync.state().code, 'Sync code copied. Send it to the other devices (for example by WhatsApp or email).');
          if (act === 'copyRules') return copy(RULES, 'Rules copied.');
          if (act === 'stop') { sync.stop(); note('Live sync is off on this device. Its data stays here.', true); return; }
          b.disabled = true;
          if (act === 'join') { await sync.start(document.getElementById('syJoin').value); note('Joined. This device now shows the shared wall.', true); }
          else if (act === 'retry') { await sync.start(sync.state().code); note('Connected.', true); }
          else if (act === 'create') {
            const cfg = parseFirebaseConfig(document.getElementById('syCfg').value);
            await sync.start(makeCode(cfg, newWallId()));
            note('The shared wall is ready. Copy the sync code and paste it on each other device.', true);
          }
        } catch (e) { b.disabled = false; note(e.message || String(e)); }
      }));
    }
    const box = document.getElementById('syncBox');
    if (box) wire(box);
    return sync.onState(draw);
  }

  window.WallSync = { create, makeCode, parseCode, parseFirebaseConfig, settingsHtml, mountSettings, RULES };
})();
