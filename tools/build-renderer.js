// Builds renderer/index.html and renderer/app.js from the wall sources in wall/
// (the same page that runs online), swapping web fonts and CDN libraries for
// the copies bundled with the desktop app.
'use strict';
const fs = require('fs');
const path = require('path');
const R = (...p) => path.join(__dirname, '..', ...p);

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

const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${head}
</head>
<body>
${body}
<script src="lib/jszip.min.js"></script>
<script src="lib/pdf.min.js"></script>
<script src="desktop.js"></script>
<script src="app.js"></script>
</body>
</html>
`;
fs.mkdirSync(R('renderer'), { recursive: true });
fs.writeFileSync(R('renderer/index.html'), html);
fs.writeFileSync(R('renderer/app.js'), app);
console.log('renderer built:', html.length, 'bytes html,', app.length, 'bytes js');
