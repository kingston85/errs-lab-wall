(() => {
'use strict';

// ===================================================================== data
const GEO = __GEO__;
const COUNTY = {
  'Montserrado': [6.30, -10.80], 'Grand Cape Mount': [6.75, -11.37], 'Nimba': [7.36, -8.71], 'Bong': [6.99, -9.47],
  'Grand Bassa': [5.88, -10.05], 'Margibi': [6.52, -10.30], 'Bomi': [6.87, -10.82], 'Maryland': [4.38, -7.72],
  'Lofa': [8.42, -9.75], 'Gbarpolu': [7.07, -10.49], 'Rivercess': [5.45, -9.58], 'River Cess': [5.45, -9.58], 'Grand Gedeh': [6.07, -8.13],
  'Sinoe': [5.01, -9.04], 'River Gee': [5.20, -7.87], 'Grand Kru': [4.67, -8.23],
};
const UNITS = {
  CMU: { name: 'Chemical Management Unit', color: '#f6a26b' },
  EMRU: { name: 'Environmental Monitoring and Research Unit', color: '#3cc6d8' },
  RSU: { name: 'Radiation Safety Unit', color: '#c39bff' },
  WRU: { name: 'Waste and Remediation Unit', color: '#8fd47f' },
  ERRS: { name: 'ERRS Department', color: '#7ba7ff' },
};
const UNIT_ORDER = ['CMU', 'EMRU', 'RSU', 'WRU'];
const STATUS = {
  met: { label: 'Target met', color: '#3ddc97' },
  near: { label: 'Near target (75% or more)', color: '#a8e05f' },
  part: { label: 'Partly achieved (40–74%)', color: '#f5b84a' },
  behind: { label: 'Behind (under 40%)', color: '#ff8a5b' },
  none: { label: 'Not started', color: '#ff5d73' },
  ongoing: { label: 'Ongoing, no numeric target', color: '#5f7a8c' },
};
const DEFAULT_CONFIG = { seconds: 16, hidden: [], ticker: [], title: 'ERRS Laboratory', subtitle: 'Environmental Research and Radiation Safety · EPA Liberia' };

const S = {
  db: null, user: null, assets: null, sample: null, canWrite: null,
  reports: [], notices: [], photos: [], samples: [], config: { ...DEFAULT_CONFIG }, loaded: false,
  scenes: [], idx: 0, key: null, paused: false, timer: 0, tStart: 0, tDur: 0, raf: 0,
  tab: 'upload', jobs: [], wake: null,
};

// ================================================================= helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uc = (u) => (UNITS[u] ? u : 'ERRS');
const ucolor = (u) => UNITS[uc(u)].color;
function nf(v, maxDec) {
  if (!isNum(v)) return v == null ? '—' : String(v);
  const a = Math.abs(v);
  let d = maxDec ?? (a === 0 || a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  if (Number.isInteger(v)) d = 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
function num(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string') {
    const t = v.replace(/,/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  }
  return null;
}
function cellNum(v) { // study values: numbers, "<0.001" strings, null
  if (isNum(v)) return { n: v, lt: false, txt: nf(v) };
  if (typeof v === 'string') {
    const m = v.trim().match(/^<\s*(\d*\.?\d+)/);
    if (m) return { n: parseFloat(m[1]), lt: true, txt: '<' + m[1] };
    const n = num(v);
    if (n != null) return { n, lt: false, txt: nf(n) };
    return { n: null, lt: false, txt: v.trim() || '—' };
  }
  return { n: null, lt: false, txt: '—' };
}
function periodRank(r) {
  const p = r.period || {};
  const y = num(p.year) || (p.start ? +String(p.start).slice(0, 4) : 0);
  const q = num(p.quarter) || (p.start ? Math.ceil((+String(p.start).slice(5, 7) || 1) / 3) : 0);
  const m = p.end ? +String(p.end).slice(5, 7) || 0 : (q ? q * 3 : 0);
  return y * 100 + m + (r.kind === 'quarterly' ? 0.5 : 0) + (r.kind === 'plan' ? -0.2 : 0);
}
function periodSortKey(label) {
  const s = String(label);
  let m = s.match(/Q([1-4])\s*(\d{4})/i);
  if (m) return +m[2] * 10 + +m[1];
  m = s.match(/(\d{4})\s*Q([1-4])/i);
  if (m) return +m[1] * 10 + +m[2];
  m = s.match(/(\d{4})/);
  return m ? +m[1] * 10 : 0;
}
function fmtDate(d, opts) {
  if (!d) return '';
  const t = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
  if (isNaN(t)) return String(d);
  return t.toLocaleDateString('en-GB', opts || { day: 'numeric', month: 'short', year: 'numeric' });
}
function toast(msg, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#app').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UTM zone 29N (WGS84) to latitude / longitude, for coordinates printed in reports.
function utmToLatLon(E, N, zone = 29) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = E - 500000, y = N;
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
  return [lat * 180 / Math.PI, (zone * 6 - 183) + lon * 180 / Math.PI];
}

// ================================================================= model
function enabledReports() {
  return S.reports.filter((r) => r.enabled !== false).sort((a, b) => periodRank(b) - periodRank(a));
}

function buildModel() {
  const rs = enabledReports();
  const M = { rs, count: rs.length };
  M.latest = rs.find((r) => r.kind === 'quarterly' && (r.headline || []).length) || rs.find((r) => (r.headline || []).length) || rs[0] || null;
  M.kpiReport = rs.find((r) => (r.kpis || []).length >= 3) || null;
  M.about = (rs.find((r) => r.about && (r.about.units || []).length) || {}).about || null;

  // series merged across reports: newer reports overwrite the same period
  const ser = new Map();
  for (const r of [...rs].reverse()) {
    for (const s of r.series || []) {
      const k = uc(s.unit) + '|' + String(s.label).toLowerCase();
      if (!ser.has(k)) ser.set(k, { unit: uc(s.unit), label: s.label, pts: new Map() });
      for (const p of s.points || []) if (num(p.value) != null && p.period) ser.get(k).pts.set(String(p.period), num(p.value));
    }
  }
  M.series = [...ser.values()].map((s) => ({ ...s, points: [...s.pts.entries()].sort((a, b) => periodSortKey(a[0]) - periodSortKey(b[0])) }));

  M.breakdowns = [];
  for (const r of rs) for (const b of r.breakdowns || []) if ((b.items || []).length) M.breakdowns.push({ ...b, unit: uc(b.unit), rid: r.id, period: r.period?.label });
  M.studies = [];
  for (const r of rs) (r.studies || []).forEach((st, i) => { if ((st.params || []).length && (st.rows || []).length) M.studies.push({ ...st, rid: r.id, i, report: r }); });
  M.readings = [];
  for (const r of rs) (r.readings || []).forEach((rd, i) => { if ((rd.points || []).length) M.readings.push({ ...rd, rid: r.id, i }); });

  const seen = new Set();
  M.activities = [];
  for (const r of rs) for (const a of r.activities || []) {
    const k = (a.date || '') + '|' + String(a.title).slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    M.activities.push({ ...a, unit: uc(a.unit) });
  }
  M.activities.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  M.highlights = [];
  for (const r of rs) for (const h of r.highlights || []) if (h && !M.highlights.includes(h)) M.highlights.push(h);
  const ch = rs.find((r) => r.kind === 'plan' && (r.challenges || []).length) || rs.find((r) => (r.challenges || []).length);
  M.challenges = ch ? ch.challenges.map((c) => ({ ...c, unit: uc(c.unit) })) : [];
  M.challengeSrc = ch;
  const ac = rs.find((r) => r.kind === 'plan' && (r.actions || []).length) || rs.find((r) => (r.actions || []).length);
  M.actions = ac ? ac.actions.map((c) => ({ ...c, unit: uc(c.unit) })) : [];
  M.milestones = ac ? ac.milestones || [] : [];
  M.actionSrc = ac;
  M.plan = rs.find((r) => r.kind === 'plan') || null;

  // places for the map
  M.points = [];
  for (const st of M.studies) {
    const rows = st.rows.filter((r) => isNum(r.lat) && isNum(r.lon));
    if (rows.length) M.points.push({ name: st.place || st.title, lat: avg(rows.map((r) => r.lat)), lon: avg(rows.map((r) => r.lon)), kind: 'study', n: rows.length, exceed: studyExceedRows(st) });
  }
  for (const rd of M.readings) {
    const pts = rd.points.filter((p) => isNum(p.lat) && isNum(p.lon));
    if (pts.length) M.points.push({ name: rd.place || rd.title, lat: avg(pts.map((p) => p.lat)), lon: avg(pts.map((p) => p.lon)), kind: 'reading', n: pts.length });
  }
  for (const r of rs) for (const p of r.places || []) {
    if (isNum(p.lat) && isNum(p.lon) && !M.points.some((q) => Math.abs(q.lat - p.lat) < 0.05 && Math.abs(q.lon - p.lon) < 0.05)) M.points.push({ name: p.name, lat: p.lat, lon: p.lon, kind: p.kind || 'site' });
  }
  M.byCounty = {};
  for (const a of M.activities) {
    const c = normCounty(a.county);
    if (c) M.byCounty[c] = (M.byCounty[c] || 0) + 1;
  }
  return M;
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function normCounty(c) {
  if (!c) return null;
  const t = String(c).toLowerCase().replace(/county/g, '').trim();
  for (const k of Object.keys(COUNTY)) if (k.toLowerCase() === t) return k === 'River Cess' ? 'Rivercess' : k;
  for (const k of Object.keys(COUNTY)) if (t.includes(k.toLowerCase())) return k === 'River Cess' ? 'Rivercess' : k;
  return null;
}

// KPI status against the expected pace for the report's quarter
function kpiStatus(k) {
  const t = num(k.target), a = num(k.achieved);
  if (t == null || t <= 0 || a == null) return 'ongoing';
  const p = a / t * 100;
  if (a === 0) return 'none';
  if (p >= 100) return 'met';
  if (p >= 75) return 'near';
  if (p >= 40) return 'part';
  return 'behind';
}

// ---- lab study evaluation
function exceeds(v, p) {
  const c = cellNum(v);
  if (c.n == null || c.lt) return false;
  const mn = num(p.min), mx = num(p.max);
  return (mx != null && c.n > mx) || (mn != null && c.n < mn);
}
function studyExceedRows(st) {
  return st.rows.filter((r) => !r.control && (r.values || []).some((v, j) => st.params[j] && exceeds(v, st.params[j]))).length;
}
function studyFindings(st) {
  const out = [];
  const test = st.rows.filter((r) => !r.control);
  const ctrl = st.rows.find((r) => r.control);
  st.params.forEach((p, j) => {
    const mn = num(p.min), mx = num(p.max);
    if (mn == null && mx == null) return;
    const ex = test.filter((r) => exceeds(r.values?.[j], p));
    if (!ex.length) return;
    const vals = ex.map((r) => cellNum(r.values[j]).n);
    const worst = mx != null ? Math.max(...vals) : Math.min(...vals);
    const ratio = mx != null ? worst / mx : null;
    const cv = ctrl ? cellNum(ctrl.values?.[j]) : null;
    out.push({ p, n: ex.length, of: test.length, worst, ratio, ctrl: cv, score: ex.length / test.length * 10 + (ratio || 1) });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}
function limitText(p) {
  const mn = num(p.min), mx = num(p.max);
  if (mn != null && mx != null) return `${nf(mn)}–${nf(mx)}`;
  if (mx != null) return `≤ ${nf(mx)}`;
  if (mn != null) return `≥ ${nf(mn)}`;
  return 'no limit';
}

// ================================================================ scenes
function buildScenes(M) {
  const sc = [];
  const hasNotices = activeNotices().length > 0, hasPhotos = photoList().length > 0, hasSamples = S.samples.length > 0;
  if (!M.count && !hasNotices && !hasPhotos && !hasSamples) {
    sc.push({ key: 'empty', kicker: 'Waiting for reports', title: 'Upload the department\'s reports to begin', unit: 'ERRS', html: sceneEmpty });
    return sc;
  }
  if (M.latest) sc.push({ key: 'hero', kicker: M.latest.period?.label || 'Latest report', title: 'At a glance', unit: 'ERRS', html: () => sceneHero(M) });
  if (hasNotices) sc.push({ key: 'notices', kicker: 'Notice board', title: 'News and what is coming up', unit: 'ERRS', html: sceneNotices });
  if (M.about) sc.push({ key: 'about', kicker: 'Who we are', title: 'Mission and units', unit: 'ERRS', html: () => sceneAbout(M) });
  if (M.kpiReport) {
    sc.push({ key: 'outputs', kicker: 'Annual outputs', title: 'Progress against the annual targets', unit: 'ERRS', dur: 1.3, html: () => sceneOutputs(M) });
    sc.push({ key: 'outlook', kicker: 'The rest of the year', title: 'What the remaining quarter must deliver', unit: 'ERRS', dur: 1.2, html: () => sceneOutlook(M) });
  }
  if (compareData(M)) sc.push({ key: 'compare', kicker: 'Year to date', title: 'Quarter by quarter, all units', unit: 'ERRS', dur: 1.2, html: () => sceneCompare(M) });
  for (const u of UNIT_ORDER) {
    const has = M.series.some((s) => s.unit === u) || M.breakdowns.some((b) => b.unit === u) || (M.latest?.headline || []).some((h) => uc(h.unit) === u);
    if (has) sc.push({ key: 'unit:' + u, kicker: u, title: UNITS[u].name, unit: u, dur: 1.15, html: () => sceneUnit(M, u) });
  }
  for (const st of M.studies) sc.push({ key: `study:${st.rid}:${st.i}`, kicker: st.kind === 'compliance' ? 'Compliance monitoring' : 'Laboratory results', title: st.title, unit: st.report?.unit || 'EMRU', dur: 1.45, html: () => sceneStudy(M, st) });
  for (const rd of M.readings) sc.push({ key: `read:${rd.rid}:${rd.i}`, kicker: 'Field measurements', title: rd.title, unit: 'EMRU', dur: 1.15, html: () => sceneReadings(M, rd) });
  if (hasSamples) sc.push({ key: 'samples', kicker: 'Laboratory', title: 'Samples in the lab', unit: 'EMRU', dur: 1.15, html: sceneSamples });
  if (M.points.length || Object.keys(M.byCounty).length) sc.push({ key: 'map', kicker: 'Where we work', title: 'Field activity by county', unit: 'ERRS', dur: 1.2, html: () => sceneMap(M) });
  if (hasPhotos) { const n = photoList().length; sc.push({ key: 'photos', kicker: 'From the field', title: 'Our work in pictures', unit: 'ERRS', durMs: clamp(n * 7000, 12000, 84000), html: scenePhotos, mount: mountPhotos }); }
  if (M.activities.length) sc.push({ key: 'activity', kicker: 'Recent work', title: 'In the field and in the lab', unit: 'ERRS', dur: 1.1, html: () => sceneActivity(M) });
  if (M.challenges.length) sc.push({ key: 'challenges', kicker: 'Support needed', title: 'What is holding the work back', unit: 'ERRS', html: () => sceneChallenges(M) });
  if (M.actions.length) sc.push({ key: 'actions', kicker: 'Next steps', title: 'The plan from here', unit: 'ERRS', dur: 1.2, html: () => sceneActions(M) });
  const hidden = new Set(S.config.hidden || []);
  const vis = sc.filter((s) => !hidden.has(s.key));
  return vis.length ? vis : sc.slice(0, 1);
}

function head(kicker, title, sub, unit, src) {
  return `<div class="head rise u-${uc(unit)}"><div style="min-width:0"><div class="kicker" style="color:var(--u)"><span class="dot"></span>${esc(kicker)}</div><h1 class="t">${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${src ? `<div class="src">${src}</div>` : ''}</div>`;
}
const srcOf = (r) => (r ? `Source<br>${esc(r.title)}` : '');

function sceneEmpty() {
  return `<div class="hero"><div style="display:flex;flex-direction:column;gap:18px">
    <div class="kicker rise"><span class="dot"></span>Ready</div>
    <h1 class="rise" style="--d:1">The wall fills itself from your reports</h1>
    <div class="lead rise" style="--d:2">Open <b>Reports</b> at the bottom of the screen and drop in quarterly reports, unit reports, investigation reports or plans (PDF, Word or PowerPoint). Claude reads each one and the wall builds its slides: annual outputs, unit performance, laboratory results, maps and next steps.</div>
    <div class="tiles rise" style="--d:3;grid-template-columns:repeat(3,1fr)">
      ${[['1', 'Upload', 'PDF, Word, PowerPoint, Excel or text'], ['2', 'Review', 'Check what Claude extracted and correct it'], ['3', 'Display', 'Slides rotate on the big screen, live']].map(([n, b, s]) => `<div class="tile"><div class="big" style="font-size:72px;color:var(--accent)">${n}</div><b>${b}</b><span>${s}</span></div>`).join('')}
    </div></div><div class="ring-wrap rise" style="--d:2">${flaskArt()}</div></div>`;
}
function flaskArt() {
  return `<svg width="420" height="420" viewBox="0 0 420 420" aria-hidden="true"><circle cx="210" cy="210" r="190" fill="none" stroke="#1d3447" stroke-width="2" stroke-dasharray="4 10"/><path d="M170 80h80M182 80v90L110 300a26 26 0 0 0 23 38h154a26 26 0 0 0 23-38L238 170V80" fill="none" stroke="#3cc6d8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path class="draw" d="M128 280c26-18 52 18 78 0s52-16 84 0" fill="none" stroke="#f5b84a" stroke-width="8" stroke-linecap="round"/></svg>`;
}

function yearRing() {
  const now = new Date();
  const y = now.getFullYear();
  const start = new Date(y, 0, 1), end = new Date(y + 1, 0, 1);
  const f = (now - start) / (end - start);
  const weeksLeft = Math.max(0, Math.ceil((end - now) / (7 * 864e5)));
  const r = 150, c = 2 * Math.PI * r;
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `<div class="ring-wrap"><svg width="400" height="400" viewBox="0 0 400 400" aria-hidden="true">
    <circle cx="200" cy="200" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="26"/>
    ${[0.25, 0.5, 0.75].map((t) => { const a = t * 2 * Math.PI - Math.PI / 2; return `<line x1="${200 + Math.cos(a) * 128}" y1="${200 + Math.sin(a) * 128}" x2="${200 + Math.cos(a) * 172}" y2="${200 + Math.sin(a) * 172}" stroke="#2a4a63" stroke-width="3"/>`; }).join('')}
    <circle cx="200" cy="200" r="${r}" fill="none" stroke="var(--accent)" stroke-width="26" stroke-linecap="round" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 200 200)" class="draw"/>
    <text x="200" y="196" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="112" fill="#e8f1f4" data-count="${weeksLeft}">${weeksLeft}</text>
    <text x="200" y="244" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="24" fill="#8fa7b6">weeks left in ${y}</text>
  </svg><div class="lbl">Quarter ${q} of ${y} · ${Math.round(f * 100)}% of the year gone</div></div>`;
}

function sceneHero(M) {
  const r = M.latest;
  const hl = (r.headline || []).slice(0, 8);
  const cols = hl.length > 4 ? 4 : Math.max(2, hl.length);
  const tiles = hl.map((h, i) => `<div class="tile rise u-${uc(h.unit)}" style="--d:${4 + i}"><div class="big" data-count="${num(h.value) ?? ''}">${esc(nf(num(h.value) ?? h.value))}</div><b>${esc(h.label)}</b><span>${esc(h.note || '')}</span></div>`).join('');
  const size = hl.length > 4 ? 64 : 84;
  return `<div class="hero"><div style="display:flex;flex-direction:column;min-width:0">
      <div class="kicker rise"><span class="dot"></span>${esc(r.title)}</div>
      <h1 class="rise" style="--d:1">${esc(r.period?.label || '')} at a glance</h1>
      <div class="lead rise" style="--d:2">${esc(r.summary || '')}</div>
      <div class="tiles" style="grid-template-columns:repeat(${cols},1fr);margin-top:auto">${tiles.replace(/font-size:84px/g, '')}</div>
    </div>
    <div style="display:flex;flex-direction:column;justify-content:center;gap:24px" class="rise" style="--d:3">${yearRing()}
      <div class="card" style="padding:18px 22px"><h3 style="margin-bottom:8px">On the wall</h3><div style="font-size:21px;line-height:1.5">${M.count} report${M.count === 1 ? '' : 's'} · ${M.studies.length} lab data set${M.studies.length === 1 ? '' : 's'} · ${M.activities.length} activities</div></div>
    </div></div>`.replace('class="tile rise', 'class="tile rise').replace(/<div class="big" data-count/g, `<div class="big" style="font-size:${size}px" data-count`);
}

function sceneAbout(M) {
  const a = M.about;
  const units = (a.units || []).slice(0, 4);
  return `${head('Who we are', 'Environmental Research and Radiation Safety Department', a.director ? `Director: ${a.director}` : '', 'ERRS')}
  <div class="grid" style="grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr">
    <div class="card rise" style="--d:2"><h3>Vision</h3><div style="font-size:27px;line-height:1.45">${esc(a.vision || '')}</div></div>
    <div class="card rise" style="--d:3"><h3>Mission</h3><div style="font-size:27px;line-height:1.45">${esc(a.mission || '')}</div></div>
    <div style="grid-column:1/-1;display:grid;grid-template-columns:repeat(${units.length || 1},1fr);gap:22px">
      ${units.map((u, i) => `<div class="card rise u-${uc(u.code)}" style="--d:${4 + i};border-top:5px solid var(--u)"><div class="big" style="font-size:72px;color:var(--u)">${esc(u.code)}</div><div style="font-size:24px;font-weight:600;margin-top:10px">${esc(u.name)}</div>${u.head ? `<div style="color:var(--dim);font-size:19px;margin-top:6px">Head: ${esc(u.head)}</div>` : ''}<div style="font-size:19px;line-height:1.45;margin-top:14px;color:#cfe0e7">${esc(u.remit || '')}</div></div>`).join('')}
    </div>
  </div>${(a.values || []).length ? `<div class="row rise" style="--d:9;gap:12px">${a.values.map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div>` : ''}`;
}

function sceneOutputs(M) {
  const r = M.kpiReport;
  const q = num(r.period?.quarter) || 3;
  const expected = q / 4 * 100;
  const meas = r.kpis.filter((k) => num(k.target) > 0 && num(k.achieved) != null).map((k) => ({ ...k, pct: num(k.achieved) / num(k.target) * 100, st: kpiStatus(k) }));
  meas.sort((a, b) => b.pct - a.pct);
  const counts = {};
  for (const k of r.kpis) { const s = kpiStatus(k); counts[s] = (counts[s] || 0) + 1; }
  const onPace = meas.filter((k) => k.pct >= expected).length;
  const half = Math.ceil(meas.length / 2);
  const col = (list, off) => list.map((k, i) => {
    const w = clamp(k.pct, 0, 100);
    const qs = ['q1', 'q2', 'q3', 'q4'].map((x) => num(k[x])).filter((v) => v != null);
    return `<div class="orow rise" style="--d:${off + i}"><div class="no">${esc(k.no ?? '')}</div><div style="min-width:0"><div class="nm">${esc(k.name)}<small>${esc(uc(k.unit))} · ${nf(num(k.achieved))} of ${nf(num(k.target))}${qs.length ? ' · by quarter ' + qs.map((v) => nf(v)).join(' / ') : ''}</small></div>
      <div class="track"><i class="grow" style="--d:${off + i};width:${w}%;background:${STATUS[k.st].color}"></i><span class="mark" style="left:calc(${expected}% - 1px)"></span></div></div>
      <div class="pct" style="color:${STATUS[k.st].color}">${Math.round(k.pct)}%<small>${k.pct >= 100 ? 'done' : `${nf(Math.max(0, num(k.target) - num(k.achieved)))} to go`}</small></div></div>`;
  }).join('');
  return `${head('Annual outputs · ' + (r.period?.label || ''), `${onPace} of ${meas.length} measurable outputs are on pace`, `White marker = where each output should be by the end of ${r.period?.label || 'this quarter'} (${Math.round(expected)}% of the annual target). ${counts.ongoing || 0} further outputs are ongoing with no numeric target.`, 'ERRS', srcOf(r))}
  <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px 56px;align-content:start">
    <div>${col(meas.slice(0, half), 2)}</div><div>${col(meas.slice(half), 2 + half)}</div>
  </div>
  <div class="legend rise" style="--d:16">${['met', 'near', 'part', 'behind', 'none', 'ongoing'].map((s) => `<span><i style="background:${STATUS[s].color}"></i>${STATUS[s].label} · <b style="color:var(--ink)">${counts[s] || 0}</b></span>`).join('')}</div>`;
}

function sceneOutlook(M) {
  const r = M.kpiReport;
  const qDone = num(r.period?.quarter) || 3;
  const qLeft = Math.max(1, 4 - qDone);
  const rows = r.kpis.filter((k) => num(k.target) > 0 && num(k.achieved) != null && num(k.achieved) < num(k.target)).map((k) => {
    const done = num(k.achieved), t = num(k.target), left = t - done, per = done / qDone;
    const pace = per > 0 ? left / qLeft / per : Infinity;
    let o = ['Reachable', '#3ddc97'];
    if (pace > 1) o = ['With effort', '#a8e05f'];
    if (pace > 2.5) o = ['Stretch', '#f5b84a'];
    if (pace > 6 || (!isFinite(pace) && left > 2)) o = ['Carry over', '#ff8a5b'];
    if (!isFinite(pace) && left <= 2) o = ['New activity needed', '#f5b84a'];
    return { k, done, t, left, per, pace, o };
  }).sort((a, b) => (isFinite(a.pace) ? a.pace : 99) - (isFinite(b.pace) ? b.pace : 99));
  const plan = M.plan;
  const p1 = M.actions.filter((a) => a.priority === 1).length;
  const maxPace = 8;
  return `${head('The rest of ' + (r.period?.year || 'the year'), 'What the remaining quarter must deliver', `Needed pace = what is left, divided by the average delivered per quarter so far. 1× means the usual pace is enough.`, 'ERRS', srcOf(r))}
  <div class="grid" style="grid-template-columns:1fr 470px">
    <div class="card rise" style="--d:2;padding:18px 28px">
      <div style="display:grid;grid-template-columns:60px 1fr 140px 120px 330px 190px;gap:14px;font-family:var(--f-mono);font-size:15px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;padding-bottom:10px;border-bottom:1px solid var(--line)"><span>No.</span><span>Output</span><span>Done</span><span>Left</span><span>Needed pace</span><span>Outlook</span></div>
      ${rows.slice(0, 12).map((x, i) => `<div class="rise" style="--d:${3 + i};display:grid;grid-template-columns:60px 1fr 140px 120px 330px 190px;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <span class="mono" style="color:var(--dim);font-size:19px">${esc(x.k.no ?? '')}</span>
        <span style="font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.k.name)}</span>
        <span class="mono" style="font-size:19px">${nf(x.done)} / ${nf(x.t)}</span>
        <span class="mono" style="font-size:19px;color:var(--amber)">${nf(x.left)}</span>
        <span style="display:flex;align-items:center;gap:12px"><span class="track" style="flex:1;margin:0;height:12px"><i class="grow" style="--d:${3 + i};width:${clamp((isFinite(x.pace) ? x.pace : maxPace) / maxPace * 100, 2, 100)}%;background:${x.o[1]}"></i><span class="mark" style="left:${100 / maxPace}%;opacity:.6"></span></span><b class="mono" style="font-size:19px;width:78px;text-align:right">${isFinite(x.pace) ? nf(Math.round(x.pace * 10) / 10) + '×' : 'new'}</b></span>
        <span class="chip" style="justify-content:center;border-color:${x.o[1]};color:${x.o[1]}">${x.o[0]}</span></div>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">
      ${(plan?.headline || []).slice(0, 2).map((h, i) => `<div class="card rise" style="--d:${4 + i}"><div class="big" style="font-size:110px;color:${i ? 'var(--good)' : 'var(--amber)'}" data-count="${num(h.value) ?? ''}">${esc(nf(num(h.value)))}</div><div style="font-size:22px;margin-top:8px;line-height:1.35">${esc(h.label)} <span style="color:var(--dim)">${esc(h.note || '')}</span></div></div>`).join('')}
      ${p1 ? `<div class="card rise" style="--d:7"><h3>Within reach first</h3><div style="font-size:21px;line-height:1.5">${M.actions.filter((a) => a.priority === 1).map((a) => esc(a.text.split(':')[0])).join(' · ')}</div></div>` : ''}
    </div>
  </div>`;
}

// ---- small charts
function miniBars(s, color, d0) {
  const pts = s.points.slice(-6);
  const mx = Math.max(1, ...pts.map((p) => p[1]));
  const W = 100 / pts.length;
  return `<div style="display:flex;align-items:flex-end;gap:12px;height:150px;margin-top:6px">${pts.map((p, i) => {
    const last = i === pts.length - 1;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0">
      <div class="mono" style="font-size:${last ? 24 : 18}px;font-weight:600;color:${last ? 'var(--ink)' : 'var(--dim)'};margin-bottom:6px">${nf(p[1])}</div>
      <div class="growy" style="--d:${d0 + i};width:100%;max-width:90px;height:${Math.max(2, p[1] / mx * 100)}px;max-height:100px;border-radius:8px 8px 3px 3px;background:${color};opacity:${last ? 1 : 0.45}"></div>
      <div class="mono" style="font-size:14px;color:var(--dim);margin-top:8px;white-space:nowrap">${esc(String(p[0]).replace(/\s*20(\d\d)$/, " '$1"))}</div></div>`;
  }).join('')}</div>`.replace(/height:(\d+(\.\d+)?)px;max-height:100px/g, (m, h) => `height:${h}px`);
}
function donut(items, size = 250) {
  const tot = items.reduce((s, x) => s + (num(x.value) || 0), 0) || 1;
  const pal = ['#3cc6d8', '#f5b84a', '#c39bff', '#8fd47f', '#ff8a5b', '#7ba7ff', '#f6a26b', '#5f7a8c'];
  const r = size / 2 - 22, c = 2 * Math.PI * r;
  let acc = 0;
  const arcs = items.map((x, i) => {
    const f = (num(x.value) || 0) / tot;
    const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${pal[i % pal.length]}" stroke-width="34" stroke-dasharray="${Math.max(0, c * f - 3)} ${c}" stroke-dashoffset="${-c * acc}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
    acc += f;
    return seg;
  }).join('');
  return { svg: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${arcs}<text x="${size / 2}" y="${size / 2 + 6}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="64" fill="#e8f1f4">${nf(tot)}</text><text x="${size / 2}" y="${size / 2 + 34}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="16" fill="#8fa7b6">total</text></svg>`, pal };
}
function breakdownHtml(b, d0) {
  const items = b.items.filter((x) => num(x.value) != null).slice(0, 7);
  if (b.type === 'parts') {
    const d = donut(items);
    return `<div style="display:flex;gap:26px;align-items:center">${d.svg}<div style="display:flex;flex-direction:column;gap:10px;min-width:0;flex:1">${items.map((x, i) => `<div class="rise" style="--d:${d0 + i};display:flex;gap:12px;align-items:baseline;font-size:19px"><i style="width:14px;height:14px;border-radius:4px;background:${d.pal[i % d.pal.length]};flex:none;transform:translateY(1px)"></i><span style="flex:1;min-width:0;line-height:1.3">${esc(x.label)}</span><b class="mono">${nf(num(x.value))}</b></div>`).join('')}</div></div>`;
  }
  const mx = Math.max(1, ...items.map((x) => num(x.value)));
  const isPipe = b.type === 'pipeline';
  const first = num(items[0]?.value) || 1;
  return `<div style="display:flex;flex-direction:column;gap:${isPipe ? 10 : 14}px">${items.map((x, i) => `<div class="rise" style="--d:${d0 + i}"><div style="display:flex;justify-content:space-between;gap:12px;font-size:19px;margin-bottom:6px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.label)}</span><b class="mono">${nf(num(x.value))}${isPipe && i ? `<span style="color:var(--dim);font-weight:400;font-size:15px"> · ${Math.round(num(x.value) / first * 100)}%</span>` : ''}</b></div><div class="track" style="margin:0;height:${isPipe ? 14 : 18}px"><i class="grow" style="--d:${d0 + i};width:${num(x.value) / mx * 100}%;background:${isPipe ? `rgba(60,198,216,${1 - i * 0.11})` : 'var(--u, var(--accent))'}"></i></div></div>`).join('')}</div>`;
}

function sceneUnit(M, u) {
  const rep = M.latest;
  const hl = (rep?.headline || []).filter((h) => uc(h.unit) === u);
  const ser = M.series.filter((s) => s.unit === u).sort((a, b) => b.points.length - a.points.length || (b.points.at(-1)?.[1] || 0) - (a.points.at(-1)?.[1] || 0));
  const latestLabel = rep?.period?.label;
  const stats = hl.slice(0, 3).map((h) => ({ v: num(h.value), label: h.label, note: h.note }));
  for (const s of ser) {
    if (stats.length >= 4) break;
    const last = s.points.at(-1);
    if (!last || stats.some((x) => x.label.toLowerCase() === String(s.label).toLowerCase())) continue;
    stats.push({ v: last[1], label: s.label, note: last[0] });
  }
  const trends = ser.filter((s) => s.points.length >= 2).slice(0, 4);
  const bds = M.breakdowns.filter((b) => b.unit === u);
  const bdsLatest = bds.filter((b) => b.period === latestLabel);
  const show = (bdsLatest.length ? bdsLatest : bds).slice(0, 2);
  const unitInfo = (M.about?.units || []).find((x) => uc(x.code) === u);
  const kp = (M.kpiReport?.kpis || []).filter((k) => uc(k.unit) === u && num(k.target) > 0 && num(k.achieved) != null);
  const right = show.length ? show.map((b, i) => `<div class="card rise" style="--d:${6 + i * 4};flex:1"><h3>${esc(b.title)}</h3>${breakdownHtml(b, 7 + i * 4)}</div>`).join('')
    : kp.length ? `<div class="card rise" style="--d:6;flex:1"><h3>Annual outputs</h3>${kp.slice(0, 6).map((k, i) => { const p = num(k.achieved) / num(k.target) * 100; const st = kpiStatus(k); return `<div style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;font-size:19px;gap:10px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.name)}</span><b class="mono" style="color:${STATUS[st].color}">${Math.round(p)}%</b></div><div class="track"><i class="grow" style="--d:${7 + i};width:${clamp(p, 0, 100)}%;background:${STATUS[st].color}"></i></div></div>`; }).join('')}</div>`
    : `<div class="card rise" style="--d:6;flex:1"><h3>Recent work</h3>${M.activities.filter((a) => a.unit === u).slice(0, 6).map((a) => `<div style="font-size:19px;line-height:1.4;margin-bottom:10px"><span class="mono" style="color:var(--dim)">${esc(fmtDate(a.date, { day: 'numeric', month: 'short' }))}</span> ${esc(a.title)}</div>`).join('')}</div>`;
  return `<div class="u-${u}" style="display:contents">${head(`${u} · ${latestLabel || ''}`, UNITS[u].name, unitInfo ? `Head of unit: ${unitInfo.head}${unitInfo.remit ? ' · ' + unitInfo.remit : ''}` : '', u, srcOf(rep))}
  <div class="grid" style="grid-template-columns:400px 1fr 1fr">
    <div style="display:flex;flex-direction:column;gap:18px;min-height:0">${stats.slice(0, 4).map((x, i) => `<div class="card rise" style="--d:${2 + i};border-left:5px solid var(--u);padding:18px 22px;flex:1"><div class="big" style="font-size:${stats.length > 3 ? 70 : 88}px" data-count="${x.v ?? ''}">${esc(nf(x.v))}</div><div style="font-size:20px;font-weight:600;margin-top:6px">${esc(x.label)}</div>${x.note ? `<div style="color:var(--dim);font-size:16px;margin-top:4px">${esc(x.note)}</div>` : ''}</div>`).join('')}</div>
    <div class="card rise" style="--d:4"><h3>Quarter by quarter</h3>${trends.length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:26px 30px">${trends.map((s, i) => `<div><div style="font-size:19px;font-weight:600;margin-bottom:4px">${esc(s.label)}</div>${miniBars(s, 'var(--u)', 5 + i * 3)}</div>`).join('')}</div>` : `<div style="color:var(--dim);font-size:20px;line-height:1.5">Trends appear here once reports from two or more quarters are on the wall.</div>`}</div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">${right}</div>
  </div></div>`;
}

function heatColor(v, p) {
  const c = cellNum(v);
  if (c.n == null) return ['rgba(255,255,255,.03)', '#5f7a8c'];
  if (c.lt) return ['rgba(255,255,255,.05)', '#8fa7b6'];
  const mn = num(p.min), mx = num(p.max);
  if (mx == null && mn == null) return ['rgba(255,255,255,.06)', '#cfe0e7'];
  if (mn != null && c.n < mn) return ['rgba(255,107,94,.55)', '#fff'];
  if (mx != null) {
    const r = c.n / mx;
    if (r > 1) return [`rgba(255,107,94,${clamp(0.42 + Math.log10(r) * 0.55, 0.42, 0.95)})`, '#fff'];
    return [`rgba(60,198,216,${(0.08 + r * 0.32).toFixed(3)})`, '#dbeef2'];
  }
  return ['rgba(60,198,216,.22)', '#dbeef2'];
}
function sceneStudy(M, st) {
  let params = st.params.map((p, j) => ({ p, j }));
  if (params.length > 22) {
    params = params.map((x) => ({ ...x, s: (num(x.p.max) != null || num(x.p.min) != null ? 5 : 0) + st.rows.filter((r) => exceeds(r.values?.[x.j], x.p)).length })).sort((a, b) => b.s - a.s).slice(0, 22).sort((a, b) => a.j - b.j);
  }
  const rows = st.rows.slice(0, 18);
  const W = 1920 - 112 - 560 - 26 - 250 - 50;
  const cw = W / params.length;
  const ch = clamp((920 - 36 - 30 - 160 - 120) / (rows.length + 1.2), 30, 46);
  const fs = cw < 54 ? 12 : cw < 66 ? 13.5 : 15;
  const find = studyFindings(st);
  const nEx = studyExceedRows(st);
  const testN = st.rows.filter((r) => !r.control).length;
  const grid = `<div class="hm" style="grid-template-columns:250px repeat(${params.length}, ${cw - 3}px)">
    <div></div>${params.map(({ p }) => `<div class="ch"><b>${esc(shortParam(p.name))}</b>${esc(p.unit || '')}</div>`).join('')}
    <div class="rh"><span style="color:var(--amber)">${st.kind === 'compliance' ? 'Permissible limit' : 'Standard'}</span></div>${params.map(({ p }) => `<div class="lim">${esc(limitText(p))}</div>`).join('')}
    ${rows.map((r, i) => `<div class="rh rise" style="--d:${2 + i};height:${ch}px${r.control ? ';box-shadow:inset 4px 0 0 var(--good);padding-left:10px' : ''}"><b>${esc(r.code || r.label)}${r.control ? ' <span style="color:var(--good);font-size:12px;letter-spacing:.08em">CONTROL</span>' : ''}</b>${r.label && r.label !== r.code ? `<span>${esc(r.label)}</span>` : ''}</div>${params.map(({ p, j }) => { const [bg, fg] = heatColor(r.values?.[j], p); const cnum = cellNum(r.values?.[j]); return `<div class="c rise" style="--d:${2 + i};height:${ch}px;background:${bg};color:${fg};font-size:${fs}px">${esc(cw < 52 && cnum.lt ? 'ND' : cnum.txt)}</div>`; }).join('')}`).join('')}
  </div>`;
  const ctrl = st.rows.find((r) => r.control);
  return `${head(`${st.kind === 'compliance' ? 'Compliance monitoring' : 'Laboratory results'} · ${fmtDate(st.date) || st.report?.period?.label || ''}`, st.title, [st.place, st.matrix, st.standard].filter(Boolean).join(' · '), st.report?.unit || 'EMRU', srcOf(st.report))}
  <div class="grid" style="grid-template-columns:1fr 560px">
    <div class="card rise" style="--d:1;padding:18px 18px 14px;overflow:hidden">${grid}</div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">
      <div class="card rise" style="--d:3;display:flex;gap:26px;align-items:center"><div class="big" style="font-size:118px;color:${nEx ? 'var(--coral)' : 'var(--good)'}" data-count="${nEx}">${nEx}</div><div style="font-size:22px;line-height:1.4">of ${testN} ${st.kind === 'compliance' ? 'facilities' : 'samples'} ${nEx === 1 ? 'has' : 'have'} at least one value outside the ${st.kind === 'compliance' ? 'limit' : 'standard'}${ctrl ? `<div style="color:var(--dim);font-size:17px;margin-top:6px">Compared with control ${esc(ctrl.code || ctrl.label)}</div>` : ''}</div></div>
      <div class="card rise find" style="--d:5;flex:1"><h3 style="margin-bottom:4px">Findings</h3>${find.length ? find.slice(0, 4).map((f) => `<p>${esc(f.p.name)} outside ${esc(limitText(f.p))} ${esc(f.p.unit || '')} at <b>${f.n} of ${f.of}</b> points · worst ${esc(nf(f.worst))}${f.ratio ? ` (${nf(Math.round(f.ratio * 10) / 10)}× the limit)` : ''}${f.ctrl && f.ctrl.n != null ? ` · control ${esc(f.ctrl.txt)}` : ''}</p>`).join('') : '<p class="ok">Every measured value is within its limit.</p>'}${st.note ? `<div style="color:var(--dim);font-size:16px;margin-top:auto">${esc(st.note)}</div>` : ''}</div>
      <div class="legend rise" style="--d:7"><span><i style="background:rgba(60,198,216,.35)"></i>Within limit (darker = closer)</span><span><i style="background:rgba(255,107,94,.8)"></i>Outside limit</span><span><i style="background:rgba(255,255,255,.08)"></i>Not detected / no limit</span></div>
    </div>
  </div>`;
}
function shortParam(n) {
  const m = String(n).match(/\(([A-Za-z0-9₀-₉]+)\)\s*$/);
  if (m && m[1].length <= 4) return m[1];
  const map = { 'electrical conductivity': 'EC', 'total dissolved solids': 'TDS', 'total suspended solids': 'TSS', 'suspended solids': 'SS', 'turbidity': 'Turb.', 'temperature': 'Temp.', 'salinity': 'Sal.', 'hardness (caco3)': 'Hard.', 'phosphate': 'PO₄', 'sulfate': 'SO₄', 'sulphate': 'SO₄', 'chloride': 'Cl', 'ammonia': 'NH₃', 'water ph': 'pH' };
  const k = String(n).toLowerCase();
  if (map[k]) return map[k];
  return n.length > 9 ? n.slice(0, 8) + '.' : n;
}

function sceneReadings(M, rd) {
  const lim = num(rd.limit);
  const pts = rd.points.slice(0, 16);
  const mx = Math.max(lim || 0, ...pts.map((p) => num(p.value) || 0)) * 1.08;
  const over = pts.filter((p) => lim != null && num(p.value) > lim);
  const worst = pts.reduce((a, p) => (num(p.value) > num(a?.value ?? -1e9) ? p : a), null);
  const geo = pts.filter((p) => isNum(p.lat) && isNum(p.lon));
  let mini = '';
  if (geo.length >= 2) {
    const la = geo.map((p) => p.lat), lo = geo.map((p) => p.lon);
    const [a0, a1, o0, o1] = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
    const k = Math.cos(a0 * Math.PI / 180);
    const w = 460, h = 360, pad = 40;
    const sx = (w - 2 * pad) / Math.max(1e-6, (o1 - o0) * k), sy = (h - 2 * pad) / Math.max(1e-6, a1 - a0), s = Math.min(sx, sy);
    const X = (lon) => pad + (lon - o0) * k * s + ((w - 2 * pad) - (o1 - o0) * k * s) / 2;
    const Y = (lat) => h - pad - (lat - a0) * s - ((h - 2 * pad) - (a1 - a0) * s) / 2;
    const metres = Math.round((o1 - o0) * k * 111320);
    mini = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${geo.map((p, i) => { const v = num(p.value); const bad = lim != null && v > lim; return `<circle cx="${X(p.lon)}" cy="${Y(p.lat)}" r="${8 + clamp((v - (lim || 0)) / 3, 0, 18)}" fill="${bad ? 'rgba(255,107,94,.55)' : 'rgba(60,198,216,.5)'}" stroke="${bad ? '#ff6b5e' : '#3cc6d8'}" stroke-width="2"/><text x="${X(p.lon) + 14}" y="${Y(p.lat) - 10}" font-family="IBM Plex Mono, monospace" font-size="15" fill="#cfe0e7">${i + 1}</text>`; }).join('')}<text x="${pad}" y="${h - 10}" font-family="IBM Plex Sans, sans-serif" font-size="14" fill="#8fa7b6">${metres ? `about ${metres} m across` : ''}</text></svg>`;
  }
  return `${head(`Field measurements · ${fmtDate(rd.date)}`, rd.title, [rd.place, rd.limitLabel].filter(Boolean).join(' · '), 'EMRU')}
  <div class="grid" style="grid-template-columns:1fr 520px">
    <div class="card rise" style="--d:1;display:flex;flex-direction:column;gap:${pts.length > 12 ? 6 : 10}px;justify-content:center">
      ${pts.map((p, i) => { const v = num(p.value); const bad = lim != null && v > lim; return `<div style="display:grid;grid-template-columns:40px 470px 1fr 120px;gap:16px;align-items:center"><span class="mono" style="color:var(--dim);font-size:18px">${i + 1}</span><span style="font-size:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.label)}</span><span class="track" style="margin:0;height:22px"><i class="grow" style="--d:${2 + i};width:${clamp(v / mx * 100, 0, 100)}%;background:${bad ? 'var(--coral)' : 'var(--accent)'}"></i>${lim != null ? `<span class="mark" style="left:${lim / mx * 100}%;background:var(--amber)"></span>` : ''}</span><b class="mono" style="font-size:24px;text-align:right;color:${bad ? 'var(--coral)' : 'var(--ink)'}">${nf(v)}</b></div>`; }).join('')}
      ${lim != null ? `<div class="legend" style="margin-top:8px;padding-left:526px"><span><i style="background:var(--amber);width:4px;height:20px"></i>${esc(rd.limitLabel || 'Limit ' + nf(lim) + ' ' + (rd.unitLabel || ''))}</span></div>` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">
      <div class="card rise" style="--d:3"><div class="big" style="font-size:118px;color:${over.length ? 'var(--coral)' : 'var(--good)'}" data-count="${over.length}">${over.length}</div><div style="font-size:22px;line-height:1.4">of ${pts.length} readings above ${lim != null ? `${nf(lim)} ${esc(rd.unitLabel || '')}` : 'the limit'}${worst ? `<div style="color:var(--dim);font-size:18px;margin-top:6px">Highest ${nf(num(worst.value))} ${esc(rd.unitLabel || '')}${lim != null ? `, ${nf(Math.round((num(worst.value) - lim) * 10) / 10)} above the limit` : ''}</div>` : ''}</div></div>
      ${mini ? `<div class="card rise" style="--d:5;flex:1;display:grid;place-items:center"><h3 style="justify-self:start">Where the readings were taken</h3>${mini}</div>` : ''}
    </div>
  </div>`;
}

function sceneMap(M) {
  const L0 = -11.62, L1 = -7.3, A0 = 4.28, A1 = 8.62;
  const k = Math.cos(6.4 * Math.PI / 180);
  const W = 800, H = 668;
  const s = Math.min(W / ((L1 - L0) * k), H / (A1 - A0));
  const ox = (W - (L1 - L0) * k * s) / 2, oy = (H - (A1 - A0) * s) / 2;
  const X = (lon) => ox + (lon - L0) * k * s, Y = (lat) => H - oy - (lat - A0) * s;
  const ring = (r) => 'M' + r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join('L') + 'Z';
  const path = (rings) => rings.map(ring).join('');
  const neigh = ['Sierra Leone', 'Guinea', "Côte d'Ivoire"].filter((n) => GEO[n]).map((n) => `<path d="${path(GEO[n])}" fill="#0d1d2a" stroke="#1d3447" stroke-width="1.5"/>`).join('');
  const counts = M.byCounty;
  const mxc = Math.max(1, ...Object.values(counts));
  const fillFor = (n) => (n ? `rgba(245,184,74,${(0.2 + 0.6 * Math.sqrt(n / mxc)).toFixed(2)})` : '#123044');
  const CTY = GEO.counties || {};
  const LBL = GEO.countyLabels || {};
  const counties = Object.entries(CTY).map(([name, r], i) => `<path class="rise" style="--d:${2 + i * 0.3}" d="${ring(r)}" fill="${fillFor(counts[name] || 0)}" stroke="rgba(60,198,216,.55)" stroke-width="1.2" stroke-linejoin="round"><title>${esc(name)}: ${counts[name] || 0} activities</title></path>`).join('');
  const outline = GEO.Liberia ? `<path d="${path(GEO.Liberia)}" fill="none" stroke="#3cc6d8" stroke-width="2.6" stroke-linejoin="round"/>` : '';
  const CALLOUT = { Montserrado: [-11.12, 6.12], Margibi: [-10.42, 5.93], Bomi: [-10.56, 7.17] }; // small coastal counties: label beside, with a leader line
  const labels = Object.entries(LBL).map(([name, [lo0, la0]]) => {
    const n = counts[name] || 0;
    const co = CALLOUT[name];
    const [lo, la] = co || [lo0, la0];
    const x = X(lo), y = Y(la);
    const halo = 'paint-order="stroke" stroke="#061019" stroke-width="4" stroke-linejoin="round"';
    const lead = co ? `<line x1="${X(lo0)}" y1="${Y(la0)}" x2="${x}" y2="${y - (n ? 10 : 0)}" stroke="#e8f1f4" stroke-width="1.4" opacity=".7"/><circle cx="${X(lo0)}" cy="${Y(la0)}" r="3.5" fill="#e8f1f4"/>` : '';
    return `<g class="rise" style="--d:${6 + (n ? 0 : 2)}">${lead}${n ? `<text x="${x}" y="${y + 4}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="${clamp(22 + Math.sqrt(n / mxc) * 18, 22, 40)}" fill="#fff" ${halo}>${n}</text>` : ''}<text x="${x}" y="${y + (n ? 24 : 5)}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="14" font-weight="${n ? 600 : 400}" fill="${n ? '#e8f1f4' : '#8fa7b6'}" ${halo}>${esc(name)}</text></g>`;
  }).join('');
  const marks = M.points.map((p, i) => { const x = X(p.lon), y = Y(p.lat); const col = p.kind === 'study' ? (p.exceed ? '#ff6b5e' : '#3ddc97') : p.kind === 'reading' ? '#c39bff' : '#3cc6d8'; return `<g class="rise" style="--d:${8 + i}"><path d="M${x} ${y - 14} L${x + 11} ${y + 7} L${x - 11} ${y + 7} Z" fill="${col}" stroke="#061019" stroke-width="2"/></g>`; }).join('');
  const sea = `<text x="${X(-10.2)}" y="${Y(4.75)}" font-family="IBM Plex Mono, monospace" font-size="17" letter-spacing="6" fill="#2a4a63">ATLANTIC OCEAN</text>`
    + `<text x="${X(-11.6)}" y="${Y(8.35)}" font-family="IBM Plex Mono, monospace" font-size="14" letter-spacing="4" fill="#2a4a63">SIERRA LEONE</text>`
    + `<text x="${X(-9.3)}" y="${Y(8.66)}" font-family="IBM Plex Mono, monospace" font-size="14" letter-spacing="4" fill="#2a4a63">GUINEA</text>`
    + `<text x="${X(-7.6)}" y="${Y(7.0)}" font-family="IBM Plex Mono, monospace" font-size="14" letter-spacing="4" fill="#2a4a63" transform="rotate(-72 ${X(-7.6)} ${Y(7.0)})">CÔTE D'IVOIRE</text>`;
  const credit = GEO.counties ? `<text x="8" y="${H - 8}" font-family="IBM Plex Sans, sans-serif" font-size="11" fill="#3d566a">County boundaries: UNMIL, OCHA ROWCA via geoBoundaries (CC BY 3.0 IGO)</text>` : '';
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, x) => a + x[1], 0);
  const scale = `<div style="display:flex;align-items:center;gap:12px;font-size:15px;color:var(--dim);margin-top:4px"><span>0</span><span style="flex:1;height:12px;border-radius:6px;background:linear-gradient(90deg,#123044,rgba(245,184,74,.35),rgba(245,184,74,.8))"></span><span>${mxc} activities</span></div>`;
  return `${head('Where we work', 'Field activity across Liberia\'s 15 counties', `Shading shows activities per county from the reports on the wall. Triangles mark sampling sites.`, 'ERRS')}
  <div class="grid" style="grid-template-columns:${W + 40}px 1fr">
    <div class="card rise" style="--d:1;padding:10px;display:grid;place-items:center;background:#08141e"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-label="Map of Liberia's counties">${neigh}${counties}${outline}${sea}${labels}${marks}${credit}</svg></div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">
      <div class="card rise" style="--d:2"><h3>Activities by county</h3>${ranked.slice(0, 8).map(([c, n], i) => `<div style="display:grid;grid-template-columns:200px 1fr 60px;gap:14px;align-items:center;margin-bottom:12px;font-size:20px"><span>${esc(c)}</span><span class="track" style="margin:0"><i class="grow" style="--d:${3 + i};width:${n / ranked[0][1] * 100}%;background:var(--amber)"></i></span><b class="mono" style="text-align:right">${n}</b></div>`).join('') || '<div style="color:var(--dim)">No county named in the reports yet.</div>'}<div style="color:var(--dim);font-size:16px;margin:6px 0 8px">${total} activities in ${ranked.length} of 15 counties</div>${scale}</div>
      <div class="card rise" style="--d:4;flex:1"><h3>Sampling and measurement sites</h3>${M.points.slice(0, 7).map((p) => `<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px;font-size:19px"><svg width="22" height="22" viewBox="-12 -16 24 26"><path d="M0 -16 L12 8 L-12 8 Z" fill="${p.kind === 'study' ? (p.exceed ? '#ff6b5e' : '#3ddc97') : p.kind === 'reading' ? '#c39bff' : '#3cc6d8'}"/></svg><span style="flex:1;min-width:0">${esc(p.name)}</span><span class="mono" style="color:var(--dim);font-size:16px">${p.kind === 'study' ? `${p.n} samples${p.exceed ? ` · ${p.exceed} over` : ''}` : p.kind === 'reading' ? `${p.n} readings` : ''}</span></div>`).join('') || '<div style="color:var(--dim)">No coordinates in the reports yet.</div>'}
      <div class="legend" style="margin-top:8px"><span><i style="background:#ff6b5e"></i>Results over the standard</span><span><i style="background:#3ddc97"></i>Within standard</span><span><i style="background:#c39bff"></i>Field readings</span></div></div>
    </div>
  </div>`;
}

function sceneActivity(M) {
  const acts = M.activities.filter((a) => a.date).slice(0, 8);
  const byType = {};
  for (const a of M.activities) byType[a.type || 'other'] = (byType[a.type || 'other'] || 0) + 1;
  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const byUnit = {};
  for (const a of M.activities) byUnit[a.unit] = (byUnit[a.unit] || 0) + 1;
  const mx = Math.max(1, ...types.map((t) => t[1]));
  return `${head('Recent work', 'In the field and in the lab', `The latest dated activities from the reports on the wall.`, 'ERRS')}
  <div class="grid" style="grid-template-columns:1fr 560px">
    <div class="card rise" style="--d:1"><div class="tl">${acts.map((a, i) => `<div class="it rise u-${a.unit}" style="--d:${2 + i}"><time>${esc(fmtDate(a.date, { day: 'numeric', month: 'short' }))}</time><span class="pin"></span><div style="min-width:0"><b>${esc(a.title)}</b><span>${esc([a.unit, a.place, a.county].filter(Boolean).join(' · '))}</span></div></div>`).join('')}</div></div>
    <div style="display:flex;flex-direction:column;gap:22px;min-height:0">
      <div class="card rise" style="--d:3"><h3>By type of work</h3>${types.map(([t, n], i) => `<div style="display:grid;grid-template-columns:160px 1fr 50px;gap:14px;align-items:center;margin-bottom:12px;font-size:20px"><span style="text-transform:capitalize">${esc(t)}</span><span class="track" style="margin:0"><i class="grow" style="--d:${4 + i};width:${n / mx * 100}%;background:var(--accent)"></i></span><b class="mono" style="text-align:right">${n}</b></div>`).join('')}</div>
      <div class="card rise" style="--d:5;flex:1"><h3>By unit</h3><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${UNIT_ORDER.concat('ERRS').filter((u) => byUnit[u]).map((u) => `<div class="u-${u}" style="border-left:5px solid var(--u);padding-left:14px"><div class="big" style="font-size:64px">${byUnit[u]}</div><div style="color:var(--dim);font-size:17px">${u}</div></div>`).join('')}</div></div>
    </div>
  </div>`;
}

function sceneChallenges(M) {
  const items = M.challenges.slice(0, 8);
  const cols = items.length > 4 ? Math.ceil(items.length / 2) : items.length;
  return `${head('Support needed', 'What is holding the work back', 'Constraints raised by the units. Resolving them unlocks the outputs that are behind.', 'ERRS', srcOf(M.challengeSrc))}
  <div class="grid" style="grid-template-columns:repeat(${cols},1fr);grid-auto-rows:1fr">
    ${items.map((c, i) => `<div class="card rise u-${c.unit}" style="--d:${2 + i};border-top:5px solid var(--u);display:flex;flex-direction:column;gap:14px"><span class="chip" style="align-self:flex-start;color:var(--u);border-color:var(--u)">${esc(c.unit)}</span><div style="font-size:${items.length > 4 ? 25 : 30}px;line-height:1.35;font-weight:500">${esc(c.text)}</div></div>`).join('')}
  </div>`;
}

function sceneActions(M) {
  const acts = M.actions;
  const prios = [...new Set(acts.map((a) => a.priority).filter((p) => p != null))].sort();
  const names = { 1: 'Priority 1 · close by year end', 2: 'Priority 2 · push hard', 3: 'Priority 3 · show progress' };
  const lanes = prios.length ? prios.map((p) => [names[p] || `Priority ${p}`, acts.filter((a) => a.priority === p)]) : [['Next steps', acts]];
  const ms = M.milestones || [];
  return `${head('Next steps · ' + (M.actionSrc?.period?.label || ''), 'The plan from here', M.actionSrc?.summary || '', 'ERRS', srcOf(M.actionSrc))}
  <div class="grid" style="grid-template-columns:repeat(${lanes.length},1fr)">
    ${lanes.map(([name, list], li) => `<div class="card rise" style="--d:${2 + li};display:flex;flex-direction:column;gap:12px"><h3>${esc(name)}</h3>${list.slice(0, 6).map((a, i) => `<div class="rise u-${a.unit}" style="--d:${3 + li * 2 + i};border-left:4px solid var(--u);padding:4px 0 4px 14px"><div style="font-size:${lanes.length > 2 ? 19 : 22}px;line-height:1.35">${esc(a.text)}</div><div class="mono" style="color:var(--dim);font-size:14px;margin-top:4px">${esc([a.unit, a.output ? 'Output ' + a.output : null, a.due].filter(Boolean).join(' · '))}</div></div>`).join('')}</div>`).join('')}
  </div>
  ${ms.length ? `<div class="card rise" style="--d:10;padding:18px 28px"><div style="display:grid;grid-template-columns:repeat(${ms.length},1fr);gap:18px">${ms.map((m) => `<div style="border-top:3px solid var(--accent);padding-top:10px"><div class="mono" style="color:var(--accent);font-size:17px">${esc(fmtDate(m.date))}</div><div style="font-size:19px;margin-top:4px;line-height:1.35">${esc(m.text)}</div></div>`).join('')}</div></div>` : ''}`;
}

// ======================================================= board content
// Notices, field photos and the lab sample board live in their own
// collections so lab staff can update them without touching reports.
const todayStr = () => new Date().toLocaleDateString('en-CA');
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
function dayDiff(a, b) { // whole days from a to b (YYYY-MM-DD)
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 864e5);
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const NOTICE_KINDS = { notice: 'Notice', event: 'Event', deadline: 'Deadline', visitor: 'Visitor' };
const SAMPLE_STAGES = [
  ['received', 'Received', '#7ba7ff'],
  ['analysis', 'In analysis', '#3cc6d8'],
  ['qc', 'QC review', '#f5b84a'],
  ['reported', 'Reported', '#3ddc97'],
];
const MATRICES = ['Surface water', 'Groundwater', 'Drinking water', 'Wastewater / effluent', 'Soil', 'Sediment', 'Air', 'Other'];

function activeNotices() {
  const t = todayStr();
  return S.notices.filter((n) => {
    if (isDate(n.start) && n.start > t) return false;
    if (isDate(n.end) && n.end < t) return false;
    if (n.kind !== 'notice' && isDate(n.date) && n.date < t && !isDate(n.end)) return false;
    return true;
  });
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
function whenText(d) {
  const n = dayDiff(todayStr(), d);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1) return `In ${n} days`;
  return `${-n} days ago`;
}

function sceneNotices() {
  const all = activeNotices();
  const dated = all.filter((n) => n.kind !== 'notice' && isDate(n.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const plain = all.filter((n) => !dated.includes(n)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 4);
  const col = { event: '#3cc6d8', deadline: '#ff8a5b', visitor: '#c39bff', notice: '#f5b84a' };
  const left = dated.length ? `<div class="card rise" style="--d:2;display:flex;flex-direction:column;gap:14px"><h3>Coming up</h3>${dated.map((n, i) => {
    const d = new Date(n.date + 'T12:00:00');
    const c = col[n.kind] || '#3cc6d8';
    const soon = dayDiff(todayStr(), n.date) <= 2;
    return `<div class="rise" style="--d:${3 + i};display:grid;grid-template-columns:118px 1fr auto;gap:24px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="border-radius:14px;border:2px solid ${c};text-align:center;padding:8px 0;background:${hexA(c, 0.1)}"><div class="big" style="font-size:54px;line-height:1">${d.getDate()}</div><div class="mono" style="font-size:16px;color:${c};letter-spacing:.12em">${d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</div></div>
      <div style="min-width:0"><div class="mono" style="font-size:15px;color:${c};letter-spacing:.1em;text-transform:uppercase">${esc(NOTICE_KINDS[n.kind] || n.kind)}${n.unit && n.unit !== 'ERRS' ? ' · ' + esc(n.unit) : ''}</div><div style="font-size:28px;font-weight:600;line-height:1.25;margin-top:4px">${esc(n.title)}</div>${n.details ? `<div style="color:var(--dim);font-size:19px;margin-top:6px;line-height:1.4">${esc(n.details)}</div>` : ''}</div>
      <span class="chip" style="font-size:18px;${soon ? `background:${c};color:#04121a;border-color:${c};font-weight:700` : `color:${c};border-color:${c}`}">${whenText(n.date)}</span></div>`;
  }).join('')}</div>` : '';
  const right = plain.length ? `<div style="display:grid;grid-template-rows:repeat(${plain.length},1fr);gap:22px;min-height:0">${plain.map((n, i) => `<div class="card rise u-${uc(n.unit)}" style="--d:${4 + i};border-left:6px solid ${col[n.kind] || '#f5b84a'};display:flex;flex-direction:column;justify-content:center;gap:10px"><div class="mono" style="font-size:15px;color:${col[n.kind] || '#f5b84a'};letter-spacing:.1em;text-transform:uppercase">${esc(NOTICE_KINDS[n.kind] || 'Notice')}${n.unit && n.unit !== 'ERRS' ? ' · ' + esc(n.unit) : ''}</div><div style="font-size:${plain.length > 2 ? 28 : 36}px;font-weight:600;line-height:1.25">${esc(n.title)}</div>${n.details ? `<div style="color:#cfe0e7;font-size:${plain.length > 2 ? 19 : 23}px;line-height:1.45">${esc(n.details)}</div>` : ''}</div>`).join('')}</div>` : '';
  const cols = left && right ? '1.25fr 1fr' : '1fr';
  return `${head('Notice board', 'News and what is coming up', `${all.length} item${all.length === 1 ? '' : 's'} on the board · ${fmtDate(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })}`, 'ERRS')}
  <div class="grid" style="grid-template-columns:${cols}">${left}${right}</div>`;
}

function photoList() {
  return [...S.photos].filter((p) => p.assetId).sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || ''))).slice(0, 12);
}
const photoUrl = (p) => (window.__blobUrl ? window.__blobUrl(p.assetId) : '/_blob/' + p.assetId); // the Android app serves stored photos itself
function scenePhotos() {
  const ps = photoList();
  const p = ps[0];
  return `${head('From the field', 'Our work in pictures', `${ps.length} recent photo${ps.length === 1 ? '' : 's'} from sampling, inspections and the lab`, 'ERRS')}
  <div class="grid" style="grid-template-columns:1fr 300px">
    <div class="card rise photo-main" style="--d:1;padding:0" data-photo-main>${photoFigure(p)}</div>
    <div style="display:flex;flex-direction:column;gap:12px;min-height:0;overflow:hidden" data-strip>${ps.map((x, i) => `<div class="thumb${i === 0 ? ' on' : ''}" data-i="${i}"><img src="${esc(photoUrl(x))}" data-blob="${esc(x.assetId)}" alt="" loading="lazy"></div>`).join('')}</div>
  </div>`;
}
function photoFigure(p) {
  if (!p) return '';
  const meta = [p.place, p.date ? fmtDate(p.date) : '', p.unit && p.unit !== 'ERRS' ? p.unit : ''].filter(Boolean).join(' · ');
  return `<figure><img src="${esc(photoUrl(p))}" data-blob="${esc(p.assetId)}" alt="${esc(p.caption || 'Field photo')}" onerror="this.closest('figure').classList.add('broken')"><figcaption><b>${esc(p.caption || '')}</b>${meta ? `<span>${esc(meta)}</span>` : ''}</figcaption><div class="ph-miss">Photo not available on this screen</div></figure>`;
}
function mountPhotos(el, durMs) {
  const ps = photoList();
  if (ps.length < 2) return null;
  const main = el.querySelector('[data-photo-main]');
  const step = Math.max(5000, durMs / ps.length);
  let i = 0;
  const id = setInterval(() => {
    i = (i + 1) % ps.length;
    main.innerHTML = photoFigure(ps[i]);
    el.querySelectorAll('.thumb').forEach((t, k) => t.classList.toggle('on', k === i));
    const on = el.querySelector('.thumb.on');
    if (on) on.parentElement.scrollTo({ top: Math.max(0, on.offsetTop - on.parentElement.offsetTop - 140), behavior: 'smooth' });
  }, step);
  return () => clearInterval(id);
}

function sampleAge(s) {
  const end = s.status === 'reported' && isDate(s.reportedAt) ? s.reportedAt : todayStr();
  return isDate(s.received) ? Math.max(0, dayDiff(s.received, end)) : null;
}
function isOverdue(s) { return s.status !== 'reported' && isDate(s.due) && s.due < todayStr(); }
function boardSamples() {
  const t = todayStr();
  return S.samples.filter((s) => s.status !== 'reported' || !isDate(s.reportedAt) || dayDiff(s.reportedAt, t) <= 30);
}
function sceneSamples() {
  const list = boardSamples();
  const inLab = list.filter((s) => s.status !== 'reported');
  const rep = list.filter((s) => s.status === 'reported');
  const tat = rep.map(sampleAge).filter((v) => v != null);
  const avgTat = tat.length ? Math.round(avg(tat) * 10) / 10 : null;
  const over = inLab.filter(isOverdue).length;
  const cols = SAMPLE_STAGES.map(([k, label, c], ci) => {
    const items = list.filter((s) => (s.status || 'received') === k).sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.received || '').localeCompare(String(b.received || '')));
    if (k === 'reported') items.sort((a, b) => String(b.reportedAt || '').localeCompare(String(a.reportedAt || '')));
    const show = items.slice(0, 5);
    return `<div class="card rise" style="--d:${2 + ci};display:flex;flex-direction:column;gap:12px;border-top:5px solid ${c}">
      <div style="display:flex;align-items:baseline;justify-content:space-between"><h3 style="margin:0;color:${c}">${label}${k === 'reported' ? ' · 30 days' : ''}</h3><span class="big" style="font-size:60px;line-height:1" data-count="${items.length}">${items.length}</span></div>
      ${show.map((s, i) => {
        const age = sampleAge(s);
        const od = isOverdue(s);
        const params = String(s.params || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        return `<div class="rise sbox${od ? ' od' : ''}" style="--d:${4 + ci + i}"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><b class="mono" style="font-size:19px">${esc(s.code)}</b><span class="mono" style="font-size:14px;color:${od ? 'var(--coral)' : 'var(--dim)'}">${k === 'reported' ? (age != null ? `${age} d turnaround` : 'reported') : od ? `overdue ${-dayDiff(todayStr(), s.due)} d` : isDate(s.due) ? `due ${esc(fmtDate(s.due, { day: 'numeric', month: 'short' }))}` : age != null ? `day ${age}` : ''}</span></div>
          <div style="font-size:16px;color:#cfe0e7;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc([s.matrix, s.source].filter(Boolean).join(' · '))}</div>
          ${params.length ? `<div class="mini" style="margin-top:6px">${params.slice(0, 5).map((x) => `<span style="font-size:12px">${esc(x)}</span>`).join('')}${params.length > 5 ? `<span>+${params.length - 5}</span>` : ''}</div>` : ''}</div>`;
      }).join('')}
      ${items.length > show.length ? `<div style="color:var(--dim);font-size:16px;margin-top:auto">+ ${items.length - show.length} more</div>` : ''}
      ${!items.length ? `<div style="color:var(--mute,#5f7a8c);font-size:17px">None</div>` : ''}
    </div>`;
  }).join('');
  const sub = [`${inLab.length} sample${inLab.length === 1 ? '' : 's'} in the lab`, `${rep.length} reported in the last 30 days`, avgTat != null ? `average turnaround ${nf(avgTat)} days` : null, over ? `${over} overdue` : null].filter(Boolean).join(' · ');
  return `${head('Laboratory', 'Samples in the lab', sub, 'EMRU')}
  <div class="grid" style="grid-template-columns:repeat(4,1fr)">${cols}</div>`;
}

// Quarter-by-quarter scorecard for the latest year in the merged series.
function compareData(M) {
  let year = 0;
  for (const s of M.series) for (const [p] of s.points) { const m = String(p).match(/(\d{4})/); if (m) year = Math.max(year, +m[1]); }
  if (!year) return null;
  const rows = [];
  for (const s of M.series) {
    const q = [null, null, null, null];
    for (const [p, v] of s.points) {
      const m = String(p).match(/Q([1-4])\s*(\d{4})/i) || String(p).match(/(\d{4})\s*Q([1-4])/i);
      if (!m) continue;
      const [qq, yy] = /^Q/i.test(m[0]) ? [+m[1], +m[2]] : [+m[2], +m[1]];
      if (yy === year) q[qq - 1] = v;
    }
    const n = q.filter((v) => v != null).length;
    if (n >= 2) rows.push({ unit: s.unit, label: s.label, q, total: q.reduce((a, v) => a + (v || 0), 0) });
  }
  if (rows.length < 2) return null;
  const out = [];
  for (const u of UNIT_ORDER.concat('ERRS')) out.push(...rows.filter((r) => r.unit === u).sort((a, b) => b.total - a.total).slice(0, 4));
  const lastQ = Math.max(...out.map((r) => { let k = -1; r.q.forEach((v, i) => { if (v != null) k = i; }); return k; }));
  return { year, rows: out.slice(0, 16), lastQ };
}
function sceneCompare(M) {
  const C = compareData(M);
  const { year, rows, lastQ } = C;
  const peaks = [0, 0, 0, 0];
  for (const r of rows) { const mx = Math.max(...r.q.map((v) => v ?? -1)); r.q.forEach((v, i) => { if (v === mx && v > 0) peaks[i]++; }); }
  const busiest = peaks.indexOf(Math.max(...peaks));
  const up = rows.filter((r) => r.q[lastQ] != null && r.q[lastQ - 1] != null && r.q[lastQ] > r.q[lastQ - 1]).length;
  const down = rows.filter((r) => r.q[lastQ] != null && r.q[lastQ - 1] != null && r.q[lastQ] < r.q[lastQ - 1]).length;
  const rh = clamp(Math.floor(640 / (rows.length + 1)), 34, 52);
  const grid = '120px minmax(0,1fr) repeat(4, 150px) 150px 190px';
  let prevU = null;
  const body = rows.map((r, i) => {
    const mx = Math.max(1, ...r.q.map((v) => v || 0));
    const col = ucolor(r.unit);
    const first = r.unit !== prevU;
    prevU = r.unit;
    const a = r.q[lastQ], b = lastQ > 0 ? r.q[lastQ - 1] : null;
    let ch = '<span style="color:var(--dim)">—</span>';
    if (a != null && b != null) {
      if (b === 0) ch = a > 0 ? `<span style="color:var(--accent)">▲ new</span>` : '<span style="color:var(--dim)">no change</span>';
      else { const pct = Math.round((a - b) / b * 100); ch = pct === 0 ? '<span style="color:var(--dim)">no change</span>' : `<span style="color:${pct > 0 ? 'var(--accent)' : 'var(--amber)'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`; }
    }
    return `<div class="rise" style="--d:${2 + i};display:grid;grid-template-columns:${grid};gap:8px;align-items:center;height:${rh}px;${first && i ? 'border-top:1px solid var(--line);' : ''}">
      <span class="mono" style="color:${col};font-size:17px;font-weight:600">${first ? esc(r.unit) : ''}</span>
      <span style="font-size:${rh > 42 ? 21 : 19}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.label)}</span>
      ${r.q.map((v, qi) => `<span class="mono" style="height:${rh - 8}px;display:grid;place-items:center;border-radius:8px;font-size:${rh > 42 ? 22 : 19}px;${v == null ? 'color:#3d566a' : `background:${hexA(col, (0.08 + (v / mx) * 0.5).toFixed(2))};${v === mx && v > 0 ? 'font-weight:700;color:#fff;box-shadow:inset 0 0 0 2px ' + col : ''}`}">${v == null ? '·' : nf(v)}</span>`).join('')}
      <b class="mono" style="text-align:right;font-size:${rh > 42 ? 24 : 21}px">${nf(r.total)}</b>
      <span class="mono" style="text-align:right;font-size:18px">${ch}</span></div>`;
  }).join('');
  return `${head('Year to date · ' + year, `${year} quarter by quarter`, `Each measure's best quarter is outlined. Busiest quarter so far: Q${busiest + 1}. Q${lastQ + 1} against Q${lastQ}: ${up} up, ${down} down.`, 'ERRS')}
  <div class="card rise" style="--d:1;padding:18px 28px">
    <div style="display:grid;grid-template-columns:${grid};gap:8px;font-family:var(--f-mono);font-size:15px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;padding-bottom:10px;border-bottom:1px solid var(--line)"><span>Unit</span><span>Measure</span>${[1, 2, 3, 4].map((q) => `<span style="text-align:center${q - 1 === lastQ ? ';color:var(--ink)' : ''}">Q${q}</span>`).join('')}<span style="text-align:right">Total</span><span style="text-align:right">Q${lastQ + 1} vs Q${lastQ || 1}</span></div>
    ${body}
  </div>`;
}

// ------------------------------------------------------------ manage panes
const ro = () => (!S.db || S.canWrite === false ? 'disabled' : '');
function unitOptions(sel) { return Object.keys(UNITS).map((u) => `<option ${sel === u ? 'selected' : ''}>${u}</option>`).join(''); }
function paneNotices() {
  const list = [...S.notices].sort((a, b) => String(a.date || a.start || '9').localeCompare(String(b.date || b.start || '9')));
  const act = new Set(activeNotices().map((n) => n.id));
  return `${capNote()}<div style="color:var(--dim);font-size:14px;line-height:1.5">Notices, events, deadlines and expected visitors. Dated items count down on the wall and drop off after their day.</div>
  <div class="rep">
    <div class="two"><label class="f">Type<select id="nKind">${Object.entries(NOTICE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label><label class="f">Unit<select id="nUnit">${unitOptions('ERRS')}</select></label></div>
    <label class="f">Title<input id="nTitle" maxlength="120" placeholder="IAEA mission visits the laboratory"></label>
    <label class="f">Details (optional)<textarea id="nDetails" maxlength="300" style="min-height:64px" placeholder="Conference room, 10:00. All unit heads attend."></textarea></label>
    <label class="f">Date (for events, deadlines and visitors)<input id="nDate" type="date"></label>
    <div class="two"><label class="f">Show from (optional)<input id="nStart" type="date"></label><label class="f">Show until (optional)<input id="nEnd" type="date"></label></div>
    <div class="row"><button class="btn pri" data-act="addNotice" ${ro()}>Add to the wall</button></div>
  </div>
  ${list.map((n) => `<div class="rep" data-nid="${esc(n.id)}"><div class="tt"><b>${esc(n.title)}</b><small>${esc(NOTICE_KINDS[n.kind] || n.kind)}${n.date ? ' · ' + esc(fmtDate(n.date)) : ''}</small></div>${n.details ? `<div style="font-size:13px;color:var(--dim)">${esc(n.details)}</div>` : ''}<div class="row"><span class="mini"><span>${act.has(n.id) ? 'Showing now' : 'Not showing'}</span>${n.end ? `<span>until ${esc(fmtDate(n.end))}</span>` : ''}</span><span style="flex:1"></span><button class="btn dng" data-act="delNotice" ${ro()}>Delete</button></div></div>`).join('')}`;
}
function panePhotos() {
  const ps = [...S.photos].sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
  return `${capNote()}${!S.assets ? '<div class="note">Only people who can edit the wall can add photos. You can still see and caption the photos below.</div>' : ''}
  <div class="rep">
    <label class="f">Photos (JPEG or PNG; large photos are resized for the screen)<input id="pFiles" type="file" accept="image/*" multiple ${S.assets ? '' : 'disabled'}></label>
    <label class="f">Caption<input id="pCap" maxlength="140" placeholder="Sampling the Gbai River below the Yuelliton slide"></label>
    <div class="two"><label class="f">Place<input id="pPlace" maxlength="80" placeholder="Bonla Town, Nimba"></label><label class="f">Date<input id="pDate" type="date" value="${todayStr()}"></label></div>
    <label class="f">Unit<select id="pUnit">${unitOptions('EMRU')}</select></label>
    <div class="row"><button class="btn pri" data-act="addPhotos" ${S.assets && S.db && S.canWrite !== false ? '' : 'disabled'}>Upload to the wall</button><span id="pStatus" style="font-size:13px;color:var(--dim)"></span></div>
  </div>
  <div class="pgrid">${ps.map((p) => `<div class="rep" data-pid="${esc(p.id)}" style="padding:8px"><img src="${esc(photoUrl(p))}" data-blob="${esc(p.assetId)}" alt="" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#071420"><input data-pcap value="${esc(p.caption || '')}" maxlength="140" style="background:#071420;border:1px solid var(--line2);border-radius:8px;padding:6px 8px;color:var(--ink);font-size:13px" ${ro()}><div class="row" style="gap:6px"><small>${esc(p.date ? fmtDate(p.date) : '')}</small><span style="flex:1"></span><button class="btn" style="padding:6px 10px" data-act="capPhoto" ${ro()}>Save</button><button class="btn dng" style="padding:6px 10px" data-act="delPhoto" ${S.assets ? '' : 'disabled'}>Delete</button></div></div>`).join('')}</div>`;
}
function paneSamples() {
  const order = Object.fromEntries(SAMPLE_STAGES.map(([k], i) => [k, i]));
  const list = [...S.samples].sort((a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0) || String(b.received || '').localeCompare(String(a.received || ''))).slice(0, 80);
  return `${capNote()}<div style="color:var(--dim);font-size:14px;line-height:1.5">Log samples as they arrive and move them along as the work progresses. Reported samples stay on the board for 30 days.</div>
  <div class="rep">
    <div class="two"><label class="f">Sample code<input id="sCode" maxlength="40" placeholder="BT-SW-010"></label><label class="f">Matrix<select id="sMatrix">${MATRICES.map((m) => `<option>${m}</option>`).join('')}</select></label></div>
    <label class="f">Source or client<input id="sSource" maxlength="100" placeholder="Bolo Town investigation, Nimba"></label>
    <label class="f">Parameters (separate with commas)<input id="sParams" maxlength="200" placeholder="pH, EC, TDS, Fe, Mn, Pb"></label>
    <div class="two"><label class="f">Received<input id="sRecv" type="date" value="${todayStr()}"></label><label class="f">Results due<input id="sDue" type="date"></label></div>
    <label class="f">Unit<select id="sUnit">${unitOptions('EMRU')}</select></label>
    <div class="row"><button class="btn pri" data-act="addSample" ${ro()}>Add sample</button></div>
  </div>
  ${list.map((s) => `<div class="rep" data-sid="${esc(s.id)}"><div class="tt"><b class="mono">${esc(s.code)}</b><small>${esc([s.matrix, s.source].filter(Boolean).join(' · '))}</small></div>
    <div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Stage<select data-act="stage" ${ro()}>${SAMPLE_STAGES.map(([k, l]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><span class="mini">${isOverdue(s) ? '<span style="color:#ffb3ab">overdue</span>' : ''}${s.received ? `<span>in ${esc(fmtDate(s.received, { day: 'numeric', month: 'short' }))}</span>` : ''}</span><span style="flex:1"></span><button class="btn dng" data-act="delSample" ${ro()}>Delete</button></div></div>`).join('')}`;
}

async function boardWrite(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(`Could not save: ${e?.message || e?.code || e}`); return false; }
}
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 2.5e6 && /jpe?g|png|webp/.test(file.type)) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    return blob || file;
  } catch { return file; }
}
async function boardClick(act, t) {
  const v = (id) => ($('#' + id)?.value || '').trim();
  if (act === 'addNotice') {
    const title = v('nTitle');
    if (!title) { toast('Give the notice a title.'); return true; }
    const kind = v('nKind');
    if (kind !== 'notice' && !isDate(v('nDate'))) { toast('Add the date for this ' + (NOTICE_KINDS[kind] || '').toLowerCase() + '.'); return true; }
    const doc = { kind, title, details: v('nDetails'), date: v('nDate') || null, start: v('nStart') || null, end: v('nEnd') || null, unit: v('nUnit') || 'ERRS', createdAt: new Date().toISOString() };
    if (await boardWrite(() => S.db.collection('notices').doc(newId()).set(doc), 'Added to the notice board.')) renderPane();
    return true;
  }
  if (act === 'delNotice') { const id = t.closest('[data-nid]').dataset.nid; await boardWrite(() => S.db.collection('notices').doc(id).delete(), 'Deleted.'); return true; }
  if (act === 'addSample') {
    const code = v('sCode');
    if (!code) { toast('Enter the sample code.'); return true; }
    const doc = { code, matrix: v('sMatrix'), source: v('sSource'), params: v('sParams'), received: v('sRecv') || todayStr(), due: v('sDue') || null, unit: v('sUnit') || 'EMRU', status: 'received', createdAt: new Date().toISOString() };
    if (await boardWrite(() => S.db.collection('samples').doc(newId()).set(doc), `${code} added.`)) { document.activeElement?.blur(); S.focusAfter = 'sCode'; renderPane(); }
    return true;
  }
  if (act === 'delSample') { const id = t.closest('[data-sid]').dataset.sid; await boardWrite(() => S.db.collection('samples').doc(id).delete(), 'Deleted.'); return true; }
  if (act === 'capPhoto') { const card = t.closest('[data-pid]'); await boardWrite(() => S.db.collection('photos').doc(card.dataset.pid).update({ caption: card.querySelector('[data-pcap]').value.trim() }), 'Caption saved.'); return true; }
  if (act === 'delPhoto') {
    const card = t.closest('[data-pid]');
    const p = S.photos.find((x) => x.id === card.dataset.pid);
    if (!p) return true;
    if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Confirm'; return true; }
    try { if (p.assetId) await S.assets.delete(p.assetId); } catch (e) { if (e?.code !== 'not_found') { toast(e?.code === 'not_uploader' ? 'Only the person who uploaded this photo can delete it.' : `Could not delete: ${e?.message || e?.code}`); return true; } }
    await boardWrite(() => S.db.collection('photos').doc(p.id).delete(), 'Photo deleted.');
    return true;
  }
  if (act === 'addPhotos') {
    const files = [...($('#pFiles')?.files || [])];
    if (!files.length) { toast('Choose one or more photos first.'); return true; }
    const st = $('#pStatus');
    t.disabled = true;
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      st.textContent = `Uploading ${i + 1} of ${files.length}…`;
      try {
        const blob = await shrinkImage(files[i]);
        const type = blob.type && /^image\/(jpeg|png|webp|gif)$/.test(blob.type) ? blob.type : 'image/jpeg';
        const up = await S.assets.upload(blob, { type });
        await S.db.collection('photos').doc(newId()).set({ assetId: up.id, caption: v('pCap'), place: v('pPlace'), date: v('pDate') || todayStr(), unit: v('pUnit') || 'ERRS', createdAt: new Date().toISOString() });
        ok++;
      } catch (e) { toast(`${files[i].name}: ${e?.code === 'quota_exceeded' ? 'storage is full' : e?.message || e?.code || 'upload failed'}`); }
    }
    st.textContent = '';
    t.disabled = false;
    toast(`${ok} photo${ok === 1 ? '' : 's'} added to the wall.`);
    renderPane();
    return true;
  }
  return false;
}
async function boardChange(t) {
  if (t.dataset?.act !== 'stage') return false;
  const id = t.closest('[data-sid]').dataset.sid;
  const patch = { status: t.value, updatedAt: new Date().toISOString() };
  if (t.value === 'reported') patch.reportedAt = todayStr();
  await boardWrite(() => S.db.collection('samples').doc(id).update(patch), 'Moved to ' + (SAMPLE_STAGES.find(([k]) => k === t.value) || [, ''])[1] + '.');
  return true;
}

// =============================================================== player
function fitStage() {
  const wrap = $('#wrap');
  const s = Math.min(wrap.clientWidth / 1920, wrap.clientHeight / 1080);
  const st = $('#stage');
  st.style.transformOrigin = '50% 50%';
  st.style.transform = `scale(${s})`;
  st.style.marginLeft = '-960px';
  st.style.marginTop = '-540px';
}

let M = null;
function rebuild() {
  M = buildModel();
  const keep = S.scenes[S.idx]?.key;
  S.scenes = buildScenes(M);
  const i = S.scenes.findIndex((s) => s.key === keep);
  renderTicker();
  renderDots();
  $('#wallTitle').textContent = S.config.title || DEFAULT_CONFIG.title;
  $('#wallSub').textContent = S.config.subtitle || DEFAULT_CONFIG.subtitle;
  $('#liveTxt').textContent = `LIVE · ${M.count} REPORT${M.count === 1 ? '' : 'S'}`;
  if (i < 0 || !S.loadedOnce) { S.loadedOnce = true; show(0); } else if (S.scenes[i].key !== S.key) { show(i); } else { S.idx = i; if (S.refreshKey && S.refreshKey === S.key) { S.refreshKey = null; refreshCurrent(); } }
}

function show(i) {
  if (!S.scenes.length) return;
  S.idx = (i + S.scenes.length) % S.scenes.length;
  const sc = S.scenes[S.idx];
  S.key = sc.key;
  const host = $('#host');
  try { S.sceneCleanup?.(); } catch { /* ignore */ }
  S.sceneCleanup = null;
  for (const old of host.querySelectorAll('.scene')) { old.classList.add('out'); setTimeout(() => old.remove(), 560); }
  const el = document.createElement('div');
  el.className = 'scene';
  try { el.innerHTML = sc.html(); } catch (e) { console.error(e); el.innerHTML = `<div class="sub">This slide could not be drawn: ${esc(e.message)}</div>`; }
  host.appendChild(el);
  $('#nowKicker').textContent = sc.kicker;
  $('#nowKicker').style.color = ucolor(sc.unit);
  $('#nowTitle').textContent = sc.title;
  countUp(el);
  renderDots();
  S.tDur = sc.durMs || (S.config.seconds || 16) * (sc.dur || 1) * 1000;
  if (sc.mount) { try { S.sceneCleanup = sc.mount(el, S.tDur); } catch (e) { console.error(e); } }
  S.tStart = performance.now();
  S.elapsedBeforePause = 0;
}
function refreshCurrent() { // redraw the slide on screen in place when its data changed
  const sc = S.scenes[S.idx];
  const el = $('#host .scene:not(.out)');
  if (!sc || !el || sc.mount) return;
  try { el.innerHTML = sc.html(); el.querySelectorAll('.rise,.grow,.growy,.draw').forEach((x) => { x.style.animation = 'none'; }); } catch (e) { console.error(e); }
}
function countUp(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of root.querySelectorAll('[data-count]')) {
    const target = parseFloat(el.getAttribute('data-count'));
    if (!Number.isFinite(target) || reduce) continue;
    const dec = Number.isInteger(target) ? 0 : (String(target).split('.')[1] || '').length;
    const t0 = performance.now() + 250, d = 1100;
    const step = (t) => {
      const f = clamp((t - t0) / d, 0, 1);
      const e = 1 - Math.pow(1 - f, 3);
      el.textContent = (target * e).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
function loop(t) {
  if (!S.paused && S.scenes.length > 1) {
    const f = (t - S.tStart) / S.tDur;
    $('#prog').style.width = clamp(f * 100, 0, 100) + '%';
    if (f >= 1) show(S.idx + 1);
  }
  requestAnimationFrame(loop);
}
function setPaused(p) {
  if (p && !S.paused) S.pausedAt = performance.now();
  if (!p && S.paused) S.tStart += performance.now() - (S.pausedAt || performance.now());
  S.paused = p;
  $('#playIcon').setAttribute('d', p ? 'M8 5l11 7-11 7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
}
function renderDots() {
  const d = $('#dots');
  d.innerHTML = S.scenes.length > 1 ? S.scenes.map((s, i) => `<i class="${i === S.idx ? 'on' : ''}"></i>`).join('') : '';
}
function renderTicker() {
  const items = [...(S.config.ticker || []).filter(Boolean), ...(M?.highlights || [])];
  if (!items.length) items.push('Upload quarterly, unit and investigation reports to fill the wall');
  const html = items.map((t) => `<span>${esc(t)}</span>`).join('');
  const run = $('#tick');
  run.innerHTML = html + html;
  const chars = items.join('').length;
  run.style.setProperty('--tdur', Math.max(40, chars * 0.16) + 's');
}
function tickClock() {
  const d = new Date();
  $('#clkTime').textContent = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('#clkDate').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ================================================================== HUD
let hudT = 0;
function pokeHud() {
  $('#hud').classList.remove('hide');
  document.body.style.cursor = '';
  clearTimeout(hudT);
  hudT = setTimeout(() => { if ($('#manage').hidden) { $('#hud').classList.add('hide'); document.body.style.cursor = 'none'; } }, 3500);
}
async function toggleFull() {
  if (window.__toggleFull) { window.__toggleFull(); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { toast('Full screen is not available here. Use the browser or TV full-screen option instead.'); }
}
async function keepAwake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch { /* not granted */ }
}

// ============================================================== manage UI
function openManage(tab) {
  $('#manage').hidden = false;
  if (tab) S.tab = tab;
  renderPane();
  pokeHud();
}
function closeManage() { $('#manage').hidden = true; pokeHud(); }
function setTab(t) { S.tab = t; renderPane(); }

function renderPane() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  const p = $('#pane');
  if (S.tab === 'upload') p.innerHTML = paneUpload();
  else if (S.tab === 'reports') p.innerHTML = paneReports();
  else if (S.tab === 'display') p.innerHTML = paneDisplay();
  else if (S.tab === 'notices') p.innerHTML = paneNotices();
  else if (S.tab === 'photos') p.innerHTML = panePhotos();
  else if (S.tab === 'samples') p.innerHTML = paneSamples();
  else if (S.tab === 'computer' && window.__desktopPane) { p.innerHTML = window.__desktopPane.render(); window.__desktopPane.wire(p); }
  else p.innerHTML = paneAsk();
  if (S.tab === 'upload') wireDrop();
}
function capNote() {
  const n = [];
  if (!S.db) n.push('Saving is not available in this view, so uploads cannot be kept. Open the wall from Claude while signed in.');
  else if (S.canWrite === false) n.push('You can view the wall but not change it. Ask the owner for edit access to upload reports.');
  return n.map((t) => `<div class="note">${esc(t)}</div>`).join('');
}
function paneUpload() {
  return `${capNote()}
  <div class="drop" id="drop"><b>Drop reports here</b><p>Quarterly and unit reports, investigation reports, work plans and presentations. PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV or text. Claude reads each file and pulls out the numbers for the wall; you check them before they go live.</p>
    <label class="btn pri" style="display:inline-block">Choose files<input id="file" type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.json" hidden></label></div>
  ${!S.sample ? `<div class="note">Reading reports needs Claude, which is not available in this view. You can still add a report by pasting its data in Reports → Add data as JSON.</div>` : ''}
  ${S.jobs.map(jobHtml).join('')}`;
}
function jobHtml(j) {
  const steps = [['read', 'Reading the file'], ['ask', j.parts > 1 ? `Claude is extracting data (${j.part || 1} of ${j.parts} parts)` : 'Claude is extracting data'], ['review', 'Check and publish']];
  const at = { read: 0, ask: 1, review: 2, saved: 3, error: -1 }[j.stage];
  if (j.stage === 'review' && j.doc) {
    const d = j.doc;
    const cnt = counts(d);
    return `<div class="rep" data-job="${j.id}"><div class="tt"><b>${esc(j.file)}</b><small>${esc(j.size)}</small></div>
      <div class="mini">${cnt.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      <label class="f">Title<input data-f="title" value="${esc(d.title)}"></label>
      <div class="two"><label class="f">Period<input data-f="plabel" value="${esc(d.period?.label || '')}" placeholder="Q4 2026"></label>
      <label class="f">Type<select data-f="kind">${['quarterly', 'unit', 'investigation', 'plan', 'other'].map((k) => `<option ${d.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
      <div class="two"><label class="f">Year<input data-f="year" inputmode="numeric" value="${esc(d.period?.year ?? '')}"></label>
      <label class="f">Quarter<select data-f="quarter"><option value="">—</option>${[1, 2, 3, 4].map((q) => `<option ${num(d.period?.quarter) === q ? 'selected' : ''}>${q}</option>`).join('')}</select></label></div>
      <label class="f">Unit<select data-f="unit">${Object.keys(UNITS).map((u) => `<option ${d.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label class="f">Summary shown on the wall<textarea data-f="summary">${esc(d.summary || '')}</textarea></label>
      <details><summary style="cursor:pointer;color:var(--dim);font-size:13px">See or correct everything Claude extracted (JSON)</summary><label class="f" style="margin-top:8px"><textarea class="code" data-f="json">${esc(JSON.stringify(d, null, 1))}</textarea></label></details>
      <div class="row"><button class="btn pri" data-act="publish" ${S.db && S.canWrite !== false ? '' : 'disabled'}>Put on the wall</button><button class="btn" data-act="discard">Discard</button></div></div>`;
  }
  return `<div class="rep" data-job="${j.id}"><div class="tt"><b>${esc(j.file)}</b><small>${esc(j.size)}</small></div>
    ${j.stage === 'error' ? `<div class="note">${esc(j.error)}</div><div class="row"><button class="btn" data-act="retry">Try again</button><button class="btn" data-act="discard">Remove</button></div>`
    : j.stage === 'saved' ? `<div style="color:var(--good);font-size:14px">On the wall · ${esc(j.savedTitle || '')}</div>`
    : `<div class="steps">${steps.map(([k, l], i) => `<div class="${i < at ? 'done' : i === at ? 'on' : ''}">${esc(l)}</div>`).join('')}</div>${j.stage === 'ask' ? `<div class="row"><button class="btn" data-act="stop">Stop</button></div>` : ''}`}</div>`;
}
function counts(d) {
  const c = [];
  const add = (n, s, p) => { if (n) c.push(`${n} ${n === 1 ? s : p}`); };
  add((d.headline || []).length, 'headline number', 'headline numbers');
  add((d.kpis || []).length, 'annual output', 'annual outputs');
  add((d.series || []).length, 'trend', 'trends');
  add((d.breakdowns || []).length, 'breakdown', 'breakdowns');
  add((d.studies || []).reduce((a, s) => a + (s.rows || []).length, 0), 'lab sample', 'lab samples');
  add((d.readings || []).reduce((a, s) => a + (s.points || []).length, 0), 'field reading', 'field readings');
  add((d.activities || []).length, 'activity', 'activities');
  add((d.highlights || []).length, 'highlight', 'highlights');
  add((d.challenges || []).length, 'challenge', 'challenges');
  add((d.actions || []).length, 'next step', 'next steps');
  if (d.about) c.push('mission and units');
  return c.length ? c : ['no data found'];
}
function paneReports() {
  const rs = [...S.reports].sort((a, b) => periodRank(b) - periodRank(a));
  return `${capNote()}<div style="color:var(--dim);font-size:14px">${rs.length} report${rs.length === 1 ? '' : 's'}. Turn a report off to take it off the wall without deleting it.</div>
  ${rs.map((r) => `<div class="rep" data-rid="${esc(r.id)}"><div class="tt"><b>${esc(r.title)}</b><small>${esc(r.period?.label || '')}</small></div>
    <div class="mini"><span>${esc(r.kind || 'other')}</span><span>${esc(r.unit || 'ERRS')}</span>${counts(r).slice(0, 5).map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row"><label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled !== false ? 'checked' : ''} ${S.canWrite === false || !S.db ? 'disabled' : ''}>On the wall</label>
      <span style="flex:1"></span>${r.assetId && !window.__noBlobLinks ? `<a class="btn" href="${esc('/_blob/' + r.assetId)}" target="_blank" rel="noopener">Original</a>` : ''}
      <button class="btn" data-act="edit" ${S.canWrite === false || !S.db ? 'disabled' : ''}>Edit</button><button class="btn dng" data-act="del" ${S.canWrite === false || !S.db ? 'disabled' : ''}>Delete</button></div>
    <div data-slot></div></div>`).join('')}
  <details class="rep"><summary style="cursor:pointer;font-weight:600">Add data as JSON</summary><p style="color:var(--dim);font-size:13px;line-height:1.5">Paste a report in the wall's data format, for example one exported from another wall.</p><label class="f"><textarea class="code" id="pasteJson" placeholder='{"title": "...", "period": {"label": "Q4 2026", "year": 2026, "quarter": 4}, "headline": [...]}'></textarea></label><div class="row"><button class="btn pri" data-act="paste" ${S.db && S.canWrite !== false ? '' : 'disabled'}>Add to the wall</button></div></details>`;
}
function paneDisplay() {
  const all = buildScenesAll();
  const hidden = new Set(S.config.hidden || []);
  return `${capNote()}
  <label class="f">Wall title<input id="cTitle" value="${esc(S.config.title || '')}"></label>
  <label class="f">Subtitle<input id="cSub" value="${esc(S.config.subtitle || '')}"></label>
  <label class="f">Seconds per slide: <b id="secOut" style="color:var(--ink)">${S.config.seconds || 16}</b><input id="cSec" type="range" min="8" max="45" value="${S.config.seconds || 16}"></label>
  <div><div style="font-size:13px;color:var(--dim);margin-bottom:8px">Slides in the rotation</div>${all.map((s) => `<label class="switch" style="margin-bottom:8px"><input type="checkbox" data-scene="${esc(s.key)}" ${hidden.has(s.key) ? '' : 'checked'}>${esc(s.kicker)} · ${esc(s.title)}</label>`).join('')}</div>
  <label class="f">Extra ticker messages, one per line<textarea id="cTick" placeholder="Welcome to the ERRS laboratory">${esc((S.config.ticker || []).join('\n'))}</textarea></label>
  <div class="row"><button class="btn pri" data-act="saveDisplay" ${S.db && S.canWrite !== false ? '' : 'disabled'}>Save for every screen</button></div>
  <div class="note" style="background:rgba(60,198,216,.08);border-color:rgba(60,198,216,.35);color:#bfeaf0">${window.desktop ? 'On the big screen: leave the app running in full screen. It updates by itself when a report is added, including from other computers that share the same data folder.' : 'On the big screen: open this page in the TV or PC browser, press Full screen, and leave it. It updates by itself when someone uploads a report.'} Keys: ← → change slide, space pauses, F full screen.</div>`;
}
function buildScenesAll() {
  const keep = S.config.hidden;
  S.config.hidden = [];
  const all = buildScenes(M || buildModel());
  S.config.hidden = keep;
  return all;
}
function paneAsk() {
  return `${capNote()}<div style="color:var(--dim);font-size:14px;line-height:1.5">Ask Claude about the reports on the wall: comparisons between quarters, which outputs need attention, what the lab results show.</div>
  <label class="f">Question<textarea id="askQ" placeholder="Which annual outputs are furthest behind, and what would close the gap?"></textarea></label>
  <div class="row"><button class="btn pri" data-act="ask" ${S.sample ? '' : 'disabled'}>Ask</button><button class="btn" data-act="brief" ${S.sample ? '' : 'disabled'}>Write ticker headlines</button><button class="btn" data-act="stopAsk">Stop</button></div>
  ${S.sample ? '' : '<div class="note">Claude is not available in this view.</div>'}
  <div class="answer" id="askOut" aria-live="polite">${esc(S.lastAnswer || '')}</div>
  <div class="row" id="askAct" ${S.lastLines?.length ? '' : 'hidden'}><button class="btn" data-act="addTicker" ${S.db && S.canWrite !== false ? '' : 'disabled'}>Add these to the ticker</button></div>`;
}

function wireDrop() {
  const d = $('#drop');
  if (!d) return;
  d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', (e) => { e.preventDefault(); d.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
}

// ========================================================== file reading
async function readFileText(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.pdf')) return readPdf(buf);
  if (name.endsWith('.docx')) return readDocx(buf);
  if (name.endsWith('.pptx')) return readPptx(buf);
  if (name.endsWith('.xlsx')) return readXlsx(buf);
  return new TextDecoder().decode(buf);
}
async function readPdf(buf) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('The PDF reader did not load. Check the internet connection and reload the page.');
  lib.GlobalWorkerOptions.workerSrc = window.PDF_WORKER_SRC || 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const lines = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    const ys = [...lines.keys()].sort((a, b) => b - a);
    out.push(`--- page ${n} ---`);
    for (const y of ys) {
      const parts = lines.get(y).sort((a, b) => a.x - b.x);
      let line = '', end = null;
      for (const p of parts) {
        if (end != null) line += p.x - end > 14 ? ' | ' : (p.x - end > 1.5 ? ' ' : '');
        line += p.s;
        end = p.x + p.w;
      }
      out.push(line.trim());
    }
  }
  return out.join('\n');
}
async function zipOf(buf) {
  if (!window.JSZip) throw new Error('The Office file reader did not load. Check the internet connection and reload the page.');
  return window.JSZip.loadAsync(buf);
}
function xmlDoc(s) { return new DOMParser().parseFromString(s, 'application/xml'); }
async function readDocx(buf) {
  const z = await zipOf(buf);
  const f = z.file('word/document.xml');
  if (!f) throw new Error('This Word file has no document body.');
  const doc = xmlDoc(await f.async('string'));
  const body = doc.getElementsByTagName('w:body')[0];
  const out = [];
  const ptext = (p) => [...p.getElementsByTagName('w:t')].map((t) => t.textContent).join('');
  for (const el of body ? [...body.children] : []) {
    if (el.tagName === 'w:p') { const t = ptext(el); if (t.trim()) out.push(t); }
    else if (el.tagName === 'w:tbl') {
      for (const tr of el.getElementsByTagName('w:tr')) out.push([...tr.getElementsByTagName('w:tc')].map((tc) => [...tc.getElementsByTagName('w:p')].map(ptext).join(' ').trim()).join(' | '));
      out.push('');
    }
  }
  return out.join('\n');
}
async function readPptx(buf) {
  const z = await zipOf(buf);
  const names = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  const out = [];
  for (const n of names) {
    const d = xmlDoc(await z.file(n).async('string'));
    out.push(`--- slide ${n.match(/(\d+)\.xml/)[1]} ---`);
    for (const p of d.getElementsByTagName('a:p')) { const t = [...p.getElementsByTagName('a:t')].map((x) => x.textContent).join(''); if (t.trim()) out.push(t); }
  }
  return out.join('\n');
}
async function readXlsx(buf) {
  const z = await zipOf(buf);
  const ss = z.file('xl/sharedStrings.xml') ? [...xmlDoc(await z.file('xl/sharedStrings.xml').async('string')).getElementsByTagName('si')].map((si) => si.textContent) : [];
  const out = [];
  const sheets = Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  for (const n of sheets) {
    out.push(`--- ${n.split('/').pop()} ---`);
    const d = xmlDoc(await z.file(n).async('string'));
    for (const row of d.getElementsByTagName('row')) {
      out.push([...row.getElementsByTagName('c')].map((c) => { const v = c.getElementsByTagName('v')[0]?.textContent ?? c.textContent; return c.getAttribute('t') === 's' ? ss[+v] ?? '' : v; }).join(' | '));
    }
  }
  return out.join('\n');
}
function compact(t) {
  return t.replace(/\r/g, '').replace(/[ \t]{3,}/g, ' | ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\.{5,}/g, '…').trim();
}
function chunkText(t, max = 140000) {
  if (t.length <= max) return [t];
  const parts = [];
  let i = 0;
  while (i < t.length && parts.length < 4) {
    let j = Math.min(t.length, i + max);
    if (j < t.length) { const nl = t.lastIndexOf('\n', j); if (nl > i + max * 0.6) j = nl; }
    parts.push(t.slice(i, j));
    i = j;
  }
  return parts;
}

// ============================================================ extraction
const SCHEMA = `{
 "title": string,
 "kind": "quarterly" | "unit" | "investigation" | "plan" | "other",
 "unit": "ERRS" | "CMU" | "EMRU" | "RSU" | "WRU",
 "period": {"label": "Q3 2026" or "Aug 2026" or "2026", "year": number, "quarter": 1-4 or null, "start": "YYYY-MM-DD" or null, "end": "YYYY-MM-DD" or null},
 "summary": "two or three plain sentences on what the report shows",
 "headline": [{"label": string, "value": number, "note": string, "unit": unit code}],
 "kpis": [{"no": number, "unit": unit code, "name": string, "target": number or null, "targetLabel": string, "q1": number or null, "q2": number or null, "q3": number or null, "q4": number or null, "achieved": number or null, "note": string}],
 "series": [{"unit": unit code, "label": string, "points": [{"period": "Q1 2026", "value": number}]}],
 "breakdowns": [{"unit": unit code, "title": string, "type": "parts" | "pipeline" | "bars", "items": [{"label": string, "value": number}]}],
 "studies": [{"title": string, "place": string, "date": "YYYY-MM-DD" or null, "matrix": string, "standard": string, "note": string, "kind": "lab" | "compliance",
   "params": [{"name": string, "unit": string, "min": number or null, "max": number or null}],
   "rows": [{"code": string, "label": string, "control": boolean, "lat": number or null, "lon": number or null, "utmE": number or null, "utmN": number or null, "values": [number or "<0.001"-style string or null, one per param]}]}],
 "readings": [{"title": string, "place": string, "date": "YYYY-MM-DD" or null, "unitLabel": string, "limit": number or null, "limitLabel": string, "points": [{"label": string, "value": number, "lat": number or null, "lon": number or null}]}],
 "activities": [{"date": "YYYY-MM-DD" or null, "unit": unit code, "title": string, "place": string, "county": string, "type": "investigation" | "inspection" | "sampling" | "lab" | "licence" | "escort" | "remediation" | "training" | "outreach" | "meeting" | "regulation"}],
 "places": [{"name": string, "county": string, "lat": number or null, "lon": number or null, "kind": string}],
 "highlights": [string],
 "challenges": [{"unit": unit code, "text": string}],
 "actions": [{"unit": unit code, "text": string, "due": string, "priority": 1 | 2 | 3 | null, "output": number or null}],
 "milestones": [{"date": "YYYY-MM-DD", "text": string}],
 "about": {"vision": string, "mission": string, "values": [string], "director": string, "units": [{"code": unit code, "name": string, "head": string, "remit": string}]} or null
}`;
function extractPrompt(text, file, part, parts) {
  return `You are reading a report from the Environmental Research and Radiation Safety (ERRS) Department of the Environmental Protection Agency of Liberia, to feed a big-screen dashboard in the department's laboratory. Units: CMU = Chemical Management Unit, EMRU = Environmental Monitoring and Research Unit (also written EMR), RSU = Radiation Safety Unit, WRU = Waste and Remediation Unit, ERRS = the whole department.

Reply with ONLY one JSON object in exactly this shape:
${SCHEMA}

Rules:
- Copy numbers exactly as printed. Never estimate or invent a number; leave a key as [] or null when the report has nothing for it.
- headline: up to 8 of the most important counts for the reporting period (licences issued, investigations, samples analysed, certificates, trucks escorted...).
- kpis: only from an annual key-performance-indicator / output tracking table. "achieved" is the cumulative figure; "target" is the numeric annual target (null when the target is not a number).
- series: recurring counts with one point per period the report states (for example Quarter I, II and III columns become "Q1 2026", "Q2 2026", "Q3 2026").
- breakdowns: "parts" = shares of one total, "pipeline" = successive stages of a process (applications → responses → certificates), "bars" = categories or months.
- studies: tables of laboratory or monitoring results (samples or facilities × parameters). "values" must line up with "params". Take min/max from the standard or permissible-limit column (pH 6.5–8.5 → min 6.5, max 8.5; NS/NG → null). Mark control / background samples with control: true. Coordinates: decimal degrees in lat/lon, or UTM (zone 29N) in utmE/utmN.
- readings: one measured quantity at several points compared with one limit (noise in dBA, dose rate...).
- activities: at most 40 dated field, laboratory and regulatory activities; merge repetitive entries into one line with a count. County must be one of Liberia's 15 counties when known.
- highlights: up to 8 one-line facts with numbers for a news ticker, each under 110 characters.
- challenges up to 8; actions (planned or recommended next steps) up to 12.
${parts > 1 ? `- This is part ${part} of ${parts} of a long report. Extract only what appears in this part; use [] for anything not in it.\n` : ''}
FILE NAME: ${file}
REPORT TEXT:
<<<
${text}
>>>`;
}

async function addFiles(list) {
  for (const f of [...list]) {
    const j = { id: Math.random().toString(36).slice(2), file: f.name, size: `${(f.size / 1024 / 1024).toFixed(1)} MB`, stage: 'read', f };
    S.jobs.unshift(j);
    renderPane();
    runJob(j);
  }
}
async function runJob(j) {
  try {
    j.stage = 'read'; j.error = null; renderPane();
    const raw = await readFileText(j.f);
    const text = compact(raw);
    if (text.length < 40) throw new Error('No readable text was found in this file. If it is a scanned document, export it with text (OCR) first.');
    if (!S.sample) throw new Error('Claude is not available in this view, so the report cannot be read automatically.');
    const parts = chunkText(text);
    j.parts = parts.length; j.stage = 'ask'; renderPane();
    j.ctl = new AbortController();
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      j.part = i + 1; renderPane();
      const r = await S.sample.json(extractPrompt(parts[i], j.file, i + 1, parts.length), { signal: j.ctl.signal, modelTier: 'default' });
      if (r && typeof r === 'object') results.push(r);
    }
    if (!results.length) throw new Error('Claude did not return any data for this file.');
    j.doc = normalizeDoc(mergeParts(results), j.f);
    j.stage = 'review';
    renderPane();
  } catch (e) {
    j.stage = 'error';
    j.error = errText(e);
    renderPane();
  }
}
function errText(e) {
  if (e?.desktop && e.message) return e.message;
  const c = e?.code;
  if (c === 'cancelled') return 'Stopped.';
  if (c === 'not_granted') return 'Claude was not allowed for this page. Allow it when asked, or upload from a view where Claude is enabled.';
  if (c === 'rate_limited') return 'Claude is busy or your usage limit was reached. Try again in a little while.';
  if (c === 'invalid_json') return 'Claude\'s answer could not be read as data. Try again; very long reports sometimes need a second attempt.';
  if (c === 'prompt_too_large') return 'This report is too long to read in one go. Split it into smaller files and upload them separately.';
  if (c === 'refused') return 'Claude declined to read this file.';
  if (c) return `Claude could not finish (${c}). Try again.`;
  return e?.message || String(e);
}
function mergeParts(rs) {
  if (rs.length === 1) return rs[0];
  const out = { ...rs[0] };
  const arrKeys = ['headline', 'series', 'breakdowns', 'studies', 'readings', 'activities', 'places', 'highlights', 'challenges', 'actions', 'milestones'];
  for (const k of arrKeys) out[k] = rs.flatMap((r) => (Array.isArray(r[k]) ? r[k] : []));
  const kp = new Map();
  for (const r of rs) for (const k of r.kpis || []) { const key = k.no ?? k.name; kp.set(key, { ...(kp.get(key) || {}), ...Object.fromEntries(Object.entries(k).filter(([, v]) => v != null && v !== '')) }); }
  out.kpis = [...kp.values()];
  out.about = rs.find((r) => r.about)?.about || null;
  for (const k of ['title', 'summary', 'kind', 'unit']) out[k] = rs.find((r) => r[k])?.[k] ?? out[k];
  out.period = rs.find((r) => r.period?.label)?.period || out.period;
  out.headline = out.headline.slice(0, 8);
  out.highlights = [...new Set(out.highlights)].slice(0, 10);
  return out;
}
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v, max = 400) { return v == null ? '' : String(v).slice(0, max); }
function normUnit(u) {
  const t = String(u || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (t === 'EMR') return 'EMRU';
  return UNITS[t] ? t : 'ERRS';
}
function normalizeDoc(d, file) {
  const p = d.period || {};
  const out = {
    title: str(d.title, 200) || file?.name || 'Report',
    kind: ['quarterly', 'unit', 'investigation', 'plan', 'other'].includes(d.kind) ? d.kind : 'other',
    unit: normUnit(d.unit),
    period: { label: str(p.label, 40), year: num(p.year), quarter: num(p.quarter), start: str(p.start, 10) || null, end: str(p.end, 10) || null },
    summary: str(d.summary, 900),
    headline: arr(d.headline).filter((h) => num(h.value) != null).slice(0, 8).map((h) => ({ label: str(h.label, 80), value: num(h.value), note: str(h.note, 120), unit: normUnit(h.unit) })),
    kpis: arr(d.kpis).slice(0, 40).map((k) => ({ no: num(k.no), unit: normUnit(k.unit), name: str(k.name, 160), target: num(k.target), targetLabel: str(k.targetLabel, 80), q1: num(k.q1), q2: num(k.q2), q3: num(k.q3), q4: num(k.q4), achieved: num(k.achieved), note: str(k.note, 200) })),
    series: arr(d.series).slice(0, 40).map((s) => ({ unit: normUnit(s.unit), label: str(s.label, 80), points: arr(s.points).filter((x) => num(x.value) != null && x.period).slice(0, 12).map((x) => ({ period: str(x.period, 20), value: num(x.value) })) })).filter((s) => s.points.length),
    breakdowns: arr(d.breakdowns).slice(0, 20).map((b) => ({ unit: normUnit(b.unit), title: str(b.title, 120), type: ['parts', 'pipeline', 'bars'].includes(b.type) ? b.type : 'bars', items: arr(b.items).filter((x) => num(x.value) != null).slice(0, 10).map((x) => ({ label: str(x.label, 90), value: num(x.value) })) })).filter((b) => b.items.length),
    studies: arr(d.studies).slice(0, 8).map((st) => {
      const params = arr(st.params).slice(0, 40).map((x) => ({ name: str(x.name, 60), unit: str(x.unit, 20), min: num(x.min), max: num(x.max) }));
      return {
        title: str(st.title, 160), place: str(st.place, 120), date: str(st.date, 10) || null, matrix: str(st.matrix, 60), standard: str(st.standard, 160), note: str(st.note, 300), kind: st.kind === 'compliance' ? 'compliance' : 'lab', params,
        rows: arr(st.rows).slice(0, 40).map((r) => {
          let lat = num(r.lat), lon = num(r.lon);
          const E = num(r.utmE), N = num(r.utmN);
          if ((lat == null || lon == null) && E != null && N != null && E > 100000 && N > 100000) [lat, lon] = utmToLatLon(E, N);
          if (lat != null && Math.abs(lat) > 90) { const ll = utmToLatLon(lat, lon); lat = ll[0]; lon = ll[1]; }
          return { code: str(r.code, 40), label: str(r.label, 120), control: !!r.control, lat, lon, values: params.map((_, i) => { const v = arr(r.values)[i]; return isNum(v) ? v : typeof v === 'string' ? v.slice(0, 16) : null; }) };
        }),
      };
    }).filter((s) => s.params.length && s.rows.length),
    readings: arr(d.readings).slice(0, 6).map((r) => ({ title: str(r.title, 120), place: str(r.place, 120), date: str(r.date, 10) || null, unitLabel: str(r.unitLabel, 20), limit: num(r.limit), limitLabel: str(r.limitLabel, 80), points: arr(r.points).filter((x) => num(x.value) != null).slice(0, 24).map((x) => ({ label: str(x.label, 90), value: num(x.value), lat: num(x.lat), lon: num(x.lon) })) })).filter((r) => r.points.length),
    activities: arr(d.activities).slice(0, 60).map((a) => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(String(a.date)) ? a.date : null, unit: normUnit(a.unit), title: str(a.title, 160), place: str(a.place, 100), county: normCounty(a.county) || str(a.county, 40), type: str(a.type, 20) || 'investigation' })),
    places: arr(d.places).slice(0, 30).map((x) => ({ name: str(x.name, 100), county: str(x.county, 40), lat: num(x.lat), lon: num(x.lon), kind: str(x.kind, 20) })),
    highlights: arr(d.highlights).map((h) => str(h, 140)).filter(Boolean).slice(0, 10),
    challenges: arr(d.challenges).slice(0, 10).map((c) => ({ unit: normUnit(c.unit), text: str(c.text, 220) })),
    actions: arr(d.actions).slice(0, 16).map((a) => ({ unit: normUnit(a.unit), text: str(a.text, 220), due: str(a.due, 40), priority: [1, 2, 3].includes(num(a.priority)) ? num(a.priority) : null, output: num(a.output) })),
    milestones: arr(d.milestones).slice(0, 6).map((m) => ({ date: str(m.date, 10), text: str(m.text, 160) })),
    about: d.about && typeof d.about === 'object' ? { vision: str(d.about.vision, 500), mission: str(d.about.mission, 500), values: arr(d.about.values).map((v) => str(v, 40)).slice(0, 8), director: str(d.about.director, 80), units: arr(d.about.units).slice(0, 6).map((u) => ({ code: normUnit(u.code), name: str(u.name, 80), head: str(u.head, 80), remit: str(u.remit, 220) })) } : null,
  };
  if (!out.period.label) out.period.label = out.period.quarter && out.period.year ? `Q${out.period.quarter} ${out.period.year}` : String(out.period.year || '');
  out.fileName = file?.name || '';
  out.enabled = true;
  return out;
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'report'; }

async function publishJob(j, card) {
  let d = j.doc;
  const val = (f) => card.querySelector(`[data-f="${f}"]`)?.value;
  try {
    const edited = JSON.parse(val('json'));
    if (edited && typeof edited === 'object') d = normalizeDoc(edited, j.f);
  } catch { toast('The JSON has an error, so only the fields above were used.'); }
  d.title = val('title') || d.title;
  d.period = { ...d.period, label: val('plabel') || d.period.label, year: num(val('year')) ?? d.period.year, quarter: num(val('quarter')) };
  d.kind = val('kind') || d.kind;
  d.unit = val('unit') || d.unit;
  d.summary = val('summary') ?? d.summary;
  d.uploadedAt = new Date().toISOString();
  d.extractedBy = 'Claude';
  const id = `${slug(d.title)}-${Date.now().toString(36)}`;
  if (S.assets && /\.pdf$/i.test(j.file) && j.f.size <= 20 * 1024 * 1024) {
    try { const up = await S.assets.upload(j.f, { type: 'application/pdf' }); d.assetId = up.id; } catch (e) { console.warn('original not stored', e); }
  }
  const size = JSON.stringify(d).length;
  if (size > 240000) { d.activities = d.activities.slice(0, 20); for (const st of d.studies) st.rows = st.rows.slice(0, 24); }
  try {
    await S.db.collection('reports').doc(id).set(d);
    j.stage = 'saved'; j.savedTitle = d.title; j.doc = null;
    renderPane();
    toast(`“${d.title}” is on the wall.`);
  } catch (e) {
    toast(e?.code === 'quota_exceeded' ? 'The wall\'s storage is full. Delete old reports first.' : `Could not save: ${e?.message || e?.code || e}`);
  }
}

// ================================================================ ask
function askContext() {
  const rs = enabledReports();
  const slim = rs.map((r) => ({
    title: r.title, period: r.period?.label, kind: r.kind, unit: r.unit, summary: r.summary, headline: r.headline,
    kpis: (r.kpis || []).map((k) => ({ no: k.no, unit: k.unit, name: k.name, target: k.target, achieved: k.achieved, q1: k.q1, q2: k.q2, q3: k.q3 })),
    series: r.series, highlights: r.highlights, challenges: r.challenges, actions: r.actions,
    studies: (r.studies || []).map((st) => ({ title: st.title, place: st.place, date: st.date, samples: st.rows.length, findings: studyFindings(st).slice(0, 6).map((f) => `${f.p.name}: ${f.n} of ${f.of} outside ${limitText(f.p)} ${f.p.unit}, worst ${f.worst}`) })),
    readings: (r.readings || []).map((x) => ({ title: x.title, limit: x.limit, values: x.points.map((p) => p.value) })),
  }));
  return JSON.stringify(slim).slice(0, 180000);
}
async function ask(brief) {
  const q = brief ? 'Write 6 short news-ticker headlines (each under 100 characters, each with a number) about the most important facts on this wall, one per line, no bullets or numbering.' : ($('#askQ')?.value || '').trim();
  if (!q) { toast('Type a question first.'); return; }
  const out = $('#askOut');
  out.textContent = 'Thinking…';
  S.askCtl?.abort();
  S.askCtl = new AbortController();
  try {
    const prompt = `You answer questions for staff of the ERRS Department (EPA Liberia) about the reports shown on their laboratory wall. Use only the data below; say so when the data does not answer the question. Be specific and brief; plain text, no markdown headings.\n\nDATA (JSON):\n${askContext()}\n\nQUESTION: ${q}`;
    const r = await S.sample(prompt, { signal: S.askCtl.signal, cache: false, onText: ({ text }) => { out.textContent = text; } });
    S.lastAnswer = r.text;
    S.lastLines = brief ? r.text.split('\n').map((l) => l.replace(/^[\s•\-*\d.]+/, '').trim()).filter(Boolean).slice(0, 8) : [];
    const a = $('#askAct');
    if (a) a.hidden = !S.lastLines.length;
  } catch (e) {
    out.textContent = (e.text ? e.text + '\n\n' : '') + errText(e);
  }
}

// ============================================================ db wiring
async function saveConfig(patch) {
  if (!S.db) return;
  S.config = { ...S.config, ...patch };
  try { await S.db.doc('config/wall').set(S.config); toast('Saved. Every screen showing the wall will update.'); } catch (e) { toast(`Could not save: ${e?.message || e?.code}`); }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-tab]');
  if (!t) return;
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  const act = t.dataset.act;
  if (t.tagName !== 'SELECT' && await boardClick(act, t)) return;
  const card = t.closest('[data-job],[data-rid]');
  if (act === 'publish' || act === 'discard' || act === 'retry' || act === 'stop') {
    const j = S.jobs.find((x) => x.id === card?.dataset.job);
    if (!j) return;
    if (act === 'publish') { t.disabled = true; t.textContent = 'Saving…'; await publishJob(j, card); }
    if (act === 'discard') { S.jobs = S.jobs.filter((x) => x !== j); renderPane(); }
    if (act === 'retry') runJob(j);
    if (act === 'stop') j.ctl?.abort();
    return;
  }
  if (card?.dataset.rid) {
    const r = S.reports.find((x) => x.id === card.dataset.rid);
    const slot = card.querySelector('[data-slot]');
    if (!r) return;
    if (act === 'del') {
      slot.innerHTML = `<div class="note">Delete “${esc(r.title)}” from the wall for everyone?<div class="row" style="margin-top:8px"><button class="btn dng" data-act="delYes">Delete</button><button class="btn" data-act="delNo">Keep</button></div></div>`;
    } else if (act === 'delNo') slot.innerHTML = '';
    else if (act === 'delYes') {
      try { await S.db.collection('reports').doc(r.id).delete(); toast('Deleted.'); } catch (er) { toast(`Could not delete: ${er?.message || er?.code}`); }
    } else if (act === 'edit') {
      const { id, ...body } = r;
      slot.innerHTML = `<label class="f">Report data (JSON)<textarea class="code" data-edit>${esc(JSON.stringify(body, null, 1))}</textarea></label><div class="row"><button class="btn pri" data-act="editSave">Save</button><button class="btn" data-act="delNo">Cancel</button></div>`;
    } else if (act === 'editSave') {
      try {
        const body = JSON.parse(slot.querySelector('[data-edit]').value);
        const doc = { ...normalizeDoc(body, { name: body.fileName || '' }), uploadedAt: body.uploadedAt || null, extractedBy: body.extractedBy || 'edited', assetId: body.assetId || null, milestones: body.milestones || [], enabled: body.enabled !== false };
        await S.db.collection('reports').doc(r.id).set(doc);
        toast('Saved.');
      } catch (er) { toast(er instanceof SyntaxError ? 'That is not valid JSON. Check commas and brackets.' : `Could not save: ${er?.message || er?.code}`); }
    }
    return;
  }
  if (act === 'paste') {
    try {
      const body = JSON.parse($('#pasteJson').value);
      const doc = normalizeDoc(body, { name: body.fileName || 'pasted data' });
      doc.uploadedAt = new Date().toISOString();
      doc.extractedBy = 'pasted';
      await S.db.collection('reports').doc(`${slug(doc.title)}-${Date.now().toString(36)}`).set(doc);
      toast(`“${doc.title}” is on the wall.`);
    } catch (er) { toast(er instanceof SyntaxError ? 'That is not valid JSON.' : `Could not save: ${er?.message || er?.code}`); }
  }
  if (act === 'saveDisplay') {
    const hidden = [...document.querySelectorAll('[data-scene]')].filter((c) => !c.checked).map((c) => c.dataset.scene);
    await saveConfig({ title: $('#cTitle').value.trim() || DEFAULT_CONFIG.title, subtitle: $('#cSub').value.trim(), seconds: +$('#cSec').value, hidden, ticker: $('#cTick').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20) });
  }
  if (act === 'ask') ask(false);
  if (act === 'brief') ask(true);
  if (act === 'stopAsk') S.askCtl?.abort();
  if (act === 'addTicker' && S.lastLines?.length) await saveConfig({ ticker: [...(S.config.ticker || []), ...S.lastLines].slice(-20) });
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (await boardChange(t)) return;
  if (t.dataset?.act === 'toggle') {
    const id = t.closest('[data-rid]')?.dataset.rid;
    try { await S.db.collection('reports').doc(id).update({ enabled: t.checked }); } catch (er) { t.checked = !t.checked; toast(`Could not change: ${er?.message || er?.code}`); }
  }
});
document.addEventListener('input', (e) => { if (e.target.id === 'cSec') $('#secOut').textContent = e.target.value; });

// ================================================================= boot
function wireHud() {
  $('#bPrev').onclick = () => show(S.idx - 1);
  $('#bNext').onclick = () => show(S.idx + 1);
  $('#bPlay').onclick = () => setPaused(!S.paused);
  $('#bFull').onclick = () => { toggleFull(); keepAwake(); };
  $('#bManage').onclick = () => ($('#manage').hidden ? openManage() : closeManage());
  $('#mClose').onclick = closeManage;
  addEventListener('pointermove', pokeHud, { passive: true });
  addEventListener('pointerdown', () => { pokeHud(); keepAwake(); }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select')) return;
    if (e.key === 'ArrowRight') show(S.idx + 1);
    else if (e.key === 'ArrowLeft') show(S.idx - 1);
    else if (e.key === ' ') { e.preventDefault(); setPaused(!S.paused); }
    else if (e.key === 'f' || e.key === 'F') toggleFull();
    else if (e.key === 'm' || e.key === 'M') ($('#manage').hidden ? openManage() : closeManage());
    else if (e.key === 'Escape') closeManage();
    pokeHud();
  });
  document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('kiosk', !!document.fullscreenElement); fitStage(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.wake === null) keepAwake(); });
}

async function connect() {
  const use = window.claude?.use;
  if (!use) { S.loaded = true; rebuild(); return; }
  const [db, user, assets, sample] = await Promise.all(['db', 'user', 'assets', 'sample'].map((n) => use(n).catch(() => null)));
  S.db = db; S.user = user; S.assets = assets; S.sample = sample;
  if (user) { try { S.canWrite = await user.can('data.write'); } catch { S.canWrite = null; } }
  if (!db) { S.loaded = true; rebuild(); renderIfOpen(); return; }
  db.collection('reports').onSnapshot((snap) => {
    S.reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.loaded = true;
    rebuild();
    renderIfOpen();
  }, (err) => { console.warn('reports feed stopped', err); });
  for (const name of ['notices', 'photos', 'samples']) {
    db.collection(name).onSnapshot((snap) => {
      S[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (name === 'samples' || name === 'notices') S.refreshKey = name;
      if (S.loaded) rebuild();
      if (!$('#manage').hidden && S.tab === name) { const p = $('#pane'); const f = p.querySelector('input:focus,textarea:focus'); if (!f || !f.value) { renderPane(); if (S.focusAfter) { $('#' + S.focusAfter)?.focus(); S.focusAfter = null; } } }
    }, (err) => console.warn(name + ' feed stopped', err));
  }
  db.doc('config/wall').onSnapshot((snap) => {
    S.config = { ...DEFAULT_CONFIG, ...(snap.exists ? snap.data() : {}) };
    if (S.loaded) rebuild();
  }, () => {});
}
function renderIfOpen() { if (S.tab === 'computer') return; if (!$('#manage').hidden && S.tab !== 'upload') renderPane(); else if (!$('#manage').hidden) { const p = $('#pane'); if (!p.querySelector('textarea:focus,input:focus')) renderPane(); } }

addEventListener('resize', fitStage);
try { new ResizeObserver(fitStage).observe($('#wrap')); } catch { /* older browser */ }
fitStage();
tickClock();
setInterval(tickClock, 1000 * 15);
wireHud();
rebuild();
requestAnimationFrame(loop);
pokeHud();
connect();
window.__wall = { S, buildModel, buildScenes, show };
})();
