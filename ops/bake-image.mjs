#!/usr/bin/env node
// bake-image.mjs — rasterise a source image to committed ASCII glyph art,
// using glyphcss's own dense luminance ramp so it matches the house glyphs.
// Output is a JSON block { name, cols, rows, art, source, caption } read at build.
//
//   node ops/bake-image.mjs --src cover.png --name sosa-record \
//     --cols 48 --edition 2026-07-12 --caption "after ..." --ref E4
//
// Flags: --src (file path), --name, --cols, --rows (auto if omitted),
//        --edition (writes content/editions/<e>/glyphs/<name>.json; else stdout),
//        --gamma 1.0, --contrast 1.0, --invert, --caption, --ref, --source.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
// sharp lives in website/node_modules; anchor the require there so this runs from ops/.
const require = createRequire(new URL('../website/package.json', import.meta.url));
const sharp = require('sharp');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i === -1 ? d : argv[i + 1];
};
const flag = (k) => argv.includes(`--${k}`);

const src = opt('src');
const name = opt('name');
const cols = parseInt(opt('cols', '48'), 10);
const gamma = parseFloat(opt('gamma', '1.0'));
const contrast = parseFloat(opt('contrast', '1.0'));
const invert = flag('invert');
const edition = opt('edition');
const caption = opt('caption', '');
const ref = opt('ref', null);
const source = opt('source', '');
// Monospace cells are ~0.5 as wide as tall; correct rows so the image isn't squashed.
const CELL_ASPECT = 0.52;

if (!src || !name) {
  console.error('usage: bake-image.mjs --src <img> --name <n> --cols N [--edition <e>]');
  process.exit(1);
}

// glyphcss "detail" solid ramp (QUAKE_DETAIL_SOLID), dark → bright.
const RAMP = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. "
  .split('').reverse();

const meta = await sharp(src).metadata();
const aspect = meta.height / meta.width;
const rows = opt('rows') ? parseInt(opt('rows'), 10) : Math.max(1, Math.round(cols * aspect * CELL_ASPECT));

const { data } = await sharp(src)
  .grayscale()
  .resize(cols, rows, { fit: 'fill' })
  .raw()
  .toBuffer({ resolveWithObject: true });

// Normalise to the actual min/max so low-contrast scans still use the full ramp.
let lo = 255, hi = 0;
for (let i = 0; i < data.length; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > hi) hi = data[i]; }
const span = Math.max(1, hi - lo);

const lines = [];
for (let y = 0; y < rows; y++) {
  let line = '';
  for (let x = 0; x < cols; x++) {
    let v = (data[y * cols + x] - lo) / span;         // 0..1
    v = Math.pow(v, gamma);                             // gamma
    v = Math.min(1, Math.max(0, (v - 0.5) * contrast + 0.5)); // contrast around mid
    if (invert) v = 1 - v;
    line += RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))];
  }
  lines.push(line.replace(/\s+$/, ''));
}

const land = 100 * (data.filter((v, i) => ((v - lo) / span) > 0.15).length / data.length);
const out = {
  name, cols, rows,
  art: lines.join('\n'),
  source: source || undefined,
  caption: caption || undefined,
  ref: ref || undefined,
};

if (edition) {
  const path = `content/editions/${edition}/glyphs/${name}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.error(`baked ${cols}×${rows}  ink≈${land.toFixed(0)}%  → ${path}`);
} else {
  console.log(lines.join('\n'));
  console.error(`\n${cols}×${rows}  ink≈${land.toFixed(0)}%`);
}
