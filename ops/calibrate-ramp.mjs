#!/usr/bin/env node
// calibrate-ramp.mjs — measure the real ink coverage of every glyph in the
// bake ramp, so the fitter can map source tone → the glyph that actually
// reproduces that tone (glyph coverage is markedly non-linear). Renders the
// ramp once in the same monospace family the page uses and writes
// ops/ramp-coverage.json { char: coverage 0..1 }.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../website/package.json', import.meta.url));
const { chromium } = require('playwright');
const sharp = require('sharp');
const here = dirname(fileURLToPath(import.meta.url));

const RAMP = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. "
  .split('').reverse();
const uniq = [...new Set(RAMP)];

const FS = 48;                 // large cell for accurate measurement
const CW = Math.round(FS * 0.6);
const esc = (c) => c === '<' ? '&lt;' : c === '&' ? '&amp;' : c;
const rows = uniq.map((c) => `<div class="cell">${esc(c)}</div>`).join('');
const html = `<!doctype html><meta charset=utf8><style>
*{margin:0;padding:0} body{background:#fff}
.cell{font-family:'JetBrains Mono',ui-monospace,'DejaVu Sans Mono',monospace;
  font-size:${FS}px;line-height:${FS}px;width:${CW}px;height:${FS}px;color:#000;
  white-space:pre;letter-spacing:0;overflow:hidden}
</style>${rows}`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: CW, height: FS * uniq.length }, deviceScaleFactor: 1 });
await p.setContent(html, { waitUntil: 'networkidle' });
const buf = await p.screenshot({ clip: { x: 0, y: 0, width: CW, height: FS * uniq.length } });
await b.close();

const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const cov = {};
for (let i = 0; i < uniq.length; i++) {
  let sum = 0, n = 0;
  for (let y = i * FS; y < (i + 1) * FS; y++)
    for (let x = 0; x < CW; x++) { sum += 255 - data[y * W + x]; n++; }   // darkness
  cov[uniq[i]] = +(sum / (n * 255)).toFixed(4);
}
// space should be 0
cov[' '] = 0;
const out = resolve(here, 'ramp-coverage.json');
writeFileSync(out, JSON.stringify(cov, null, 0) + '\n');
const max = Math.max(...Object.values(cov));
console.log(`calibrated ${uniq.length} glyphs · maxCoverage=${max} · → ${out}`);
