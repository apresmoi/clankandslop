// One-off: render the house mark — the amber ampersand from the CLANK&SLOP
// nameplate — and bake the full favicon set into public/. The glyph is typeset
// with the real DM Serif Display web font via headless Chromium (so it matches
// the masthead exactly), then resized with sharp and packed into a PNG-backed
// .ico. Favicons are committed static assets; this only reruns if the mark
// changes.  Run from website/:  node scripts/make-favicon.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Coal ground + amber accent — reads on both light and dark browser tab bars,
// and ties to the dark-theme paper. The ampersand is the brand's one ornament.
const COAL = '#14110E';
const AMBER = '#D9A441';
const SIZE = 512;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@1&display=swap" rel="stylesheet">
<style>
  html,body{margin:0}
  .tile{width:${SIZE}px;height:${SIZE}px;background:${COAL};display:flex;align-items:center;justify-content:center;overflow:hidden}
  .amp{font-family:'DM Serif Display',serif;font-style:italic;color:${AMBER};
       font-size:430px;line-height:1;transform:translateY(-14px)}
</style></head>
<body><div class="tile"><span class="amp">&amp;</span></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
const base = await page.locator('.tile').screenshot();
await browser.close();

const master = await sharp(base).resize(512, 512, { fit: 'cover' }).png().toBuffer();
writeFileSync(resolve(PUB, 'icon-512.png'), master);

const sizes = { 'icon-192.png': 192, 'apple-touch-icon.png': 180, 'favicon-32x32.png': 32, 'favicon-16x16.png': 16 };
const pngFor = (px) => sharp(master).resize(px, px, { fit: 'cover' }).png().toBuffer();
for (const [name, px] of Object.entries(sizes)) writeFileSync(resolve(PUB, name), await pngFor(px));

// favicon.ico — a PNG-backed ICO (16/32/48). Each directory entry points at a
// full PNG blob, which modern browsers and Windows both accept.
const icoSizes = [16, 32, 48];
const pngs = await Promise.all(icoSizes.map(pngFor));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
let offset = 6 + pngs.length * 16;
const dir = Buffer.concat(pngs.map((png, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(icoSizes[i], 0); e.writeUInt8(icoSizes[i], 1);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
}));
writeFileSync(resolve(PUB, 'favicon.ico'), Buffer.concat([header, dir, ...pngs]));

const manifest = {
  name: 'Clank & Slop',
  short_name: 'Clank & Slop',
  description: 'A daily paper with an all-agent newsroom.',
  theme_color: COAL,
  background_color: COAL,
  display: 'standalone',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};
writeFileSync(resolve(PUB, 'site.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

console.log('favicon set →', PUB);
