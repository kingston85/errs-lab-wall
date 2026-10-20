// Builds the wall page from the sources in wall/ (the same page that runs
// online), swapping web fonts and CDN libraries for bundled copies.
//
//   node tools/build-renderer.js           -> renderer/  (Windows app)
//   node tools/build-renderer.js mobile    -> mobile/www (Android app, with the
//                                             libraries, fonts and seed reports copied in)
'use strict';
const fs = require('fs');
const path = require('path');
const R = (...p) => path.join(__dirname, '..', ...p);
const MOBILE = process.argv[2] === 'mobile';

let head = fs.readFileSync(R('wall/head.html'), 'utf8');
const logo = 'data:image/png;base64,' + fs.readFileSync(R('wall/epa-logo.png')).toString('base64');
const body = fs.readFileSync(R('wall/body.html'), 'utf8').replace('__LOGO__', logo);
const geo = fs.readFileSync(R('wall/region.json'), 'utf8').trim();
const app = fs.readFileSync(R('wall/app.js'), 'utf8').replace('__GEO__', () => geo);

const fonts = {
  'barlow-condensed': ['500', '600', '700'],
  'ibm-plex-sans': ['400', '500', '600', '700'],
  'ibm-plex-mono': ['400', '500', '600'],
};
const fontLinks = Object.entries(fonts).flatMap(([f, ws]) => ws.map((w) => `<link rel="stylesheet" href="fonts/${f}/latin-${w}.css">`)).join('\n');
head = head
  .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, fontLinks)
  .replace(/<meta name="claude:[^>]*>\s*/g, '');
if (/googleapis|cdnjs/.test(head)) throw new Error('remote reference left in head');

const connect = MOBILE ? "'self' https://api.anthropic.com" : "'self'";
const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src ${connect}`;
const shim = MOBILE ? 'mobile.js' : 'desktop.js';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${head}
</head>
<body>
${body}
<script src="lib/jszip.min.js"></script>
<script src="lib/pdf.min.js"></script>
<script src="${shim}"></script>
<script src="app.js"></script>
</body>
</html>
`;

if (!MOBILE) {
  fs.mkdirSync(R('renderer'), { recursive: true });
  fs.writeFileSync(R('renderer/index.html'), html);
  fs.writeFileSync(R('renderer/app.js'), app);
  console.log('renderer built:', html.length, 'bytes html,', app.length, 'bytes js');
  process.exit(0);
}

// ----- Android: a self-contained www folder for Capacitor
const OUT = R('mobile/www');
const NM = R('mobile/node_modules');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'app.js'), app);
const version = JSON.parse(fs.readFileSync(R('mobile/package.json'), 'utf8')).version;
fs.writeFileSync(path.join(OUT, 'mobile.js'), fs.readFileSync(R('mobile/src/mobile.js'), 'utf8').replace('__APP_VERSION__', version));
fs.copyFileSync(path.join(NM, 'pdfjs-dist/build/pdf.min.js'), path.join(OUT, 'lib/pdf.min.js'));
fs.copyFileSync(path.join(NM, 'pdfjs-dist/build/pdf.worker.min.js'), path.join(OUT, 'lib/pdf.worker.min.js'));
fs.copyFileSync(path.join(NM, 'jszip/dist/jszip.min.js'), path.join(OUT, 'lib/jszip.min.js'));
for (const [f, ws] of Object.entries(fonts)) {
  const src = path.join(NM, '@fontsource', f);
  fs.mkdirSync(path.join(OUT, 'fonts', f, 'files'), { recursive: true });
  for (const w of ws) {
    const css = fs.readFileSync(path.join(src, `latin-${w}.css`), 'utf8');
    fs.writeFileSync(path.join(OUT, 'fonts', f, `latin-${w}.css`), css);
    for (const m of css.matchAll(/url\(\.\/files\/([^)]+)\)/g)) fs.copyFileSync(path.join(src, 'files', m[1]), path.join(OUT, 'fonts', f, 'files', m[1]));
  }
}
const seed = [];
for (const n of fs.readdirSync(R('seed')).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(fs.readFileSync(R('seed', n), 'utf8'));
  const col = d.__collection || 'reports';
  delete d.__collection;
  seed.push({ collection: col, id: n.slice(0, -5), data: d });
}
fs.writeFileSync(path.join(OUT, 'seed.json'), JSON.stringify(seed));
console.log('mobile www built:', fs.readdirSync(OUT).join(', '), '·', seed.length, 'seed documents');
