#!/usr/bin/env node
// fit-glyph.mjs — auto-tune the bake so the ASCII's per-cell tone matches the
// source image as closely as the ramp allows. Uses the calibrated glyph
// coverage (ops/ramp-coverage.json) to (1) assign each cell the glyph whose
// REAL ink coverage best reproduces the target tone, and (2) grid-search the
// tone curve (gamma × contrast × invert) to minimise the mean-squared error
// between the reconstructed ASCII tone and the source tone.
//
//   node ops/fit-glyph.mjs --src cover.png --name songbook-sosa --cols 96 \
//     --edition 2026-07-12 --caption "…" [--ref E4] [--ab out.png]
//
// Writes the glyph JSON (like bake-image.mjs) and, with --ab, a side-by-side
// PNG (source | ASCII reconstruction) so parity is eyeballable.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../website/package.json', import.meta.url));
const sharp = require('sharp');
const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const src = opt('src'), name = opt('name');
const cols = parseInt(opt('cols', '96'), 10);
const edition = opt('edition'), caption = opt('caption', ''), source = opt('source', ''), ref = opt('ref', null);
const ab = opt('ab', null);
const CELL_ASPECT = 0.52;
if (!src || !name) { console.error('usage: fit-glyph.mjs --src <img> --name <n> --cols N [--edition e]'); process.exit(1); }

const covMap = JSON.parse(readFileSync(resolve(here, 'ramp-coverage.json'), 'utf8'));
// De-duplicated coverage ladder, sorted ascending; ties collapse to one glyph.
const ladder = [...new Set(Object.keys(covMap))]
  .map((c) => [c, covMap[c]]).sort((a, b) => a[1] - b[1]);
const maxCov = ladder[ladder.length - 1][1];
const nearest = (target) => {           // glyph whose coverage is nearest `target`
  let best = ladder[0], bd = Infinity;
  for (const [c, v] of ladder) { const d = Math.abs(v - target); if (d < bd) { bd = d; best = [c, v]; } }
  return best;                          // [char, coverage]
};

const meta = await sharp(src).metadata();
const rows = opt('rows') ? parseInt(opt('rows'), 10) : Math.max(1, Math.round(cols * (meta.height / meta.width) * CELL_ASPECT));
const { data } = await sharp(src).grayscale().resize(cols, rows, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });

// Source tone per cell, auto-levelled to [0,1] with 1 = darkest.
let lo = 255, hi = 0;
for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
const span = Math.max(1, hi - lo);
const srcTone = new Float64Array(data.length);
for (let i = 0; i < data.length; i++) srcTone[i] = 1 - (data[i] - lo) / span;

const clamp = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
function assign(gamma, contrast, invert) {
  const chars = new Array(data.length);
  const asciiTone = new Float64Array(data.length);
  const tone = new Float64Array(data.length);   // curved target tone per cell
  let err = 0;
  for (let i = 0; i < data.length; i++) {
    let t = srcTone[i];
    t = Math.pow(t, gamma);
    t = clamp((t - 0.5) * contrast + 0.5);
    if (invert) t = 1 - t;
    tone[i] = t;
    const [c, v] = nearest(t * maxCov);
    chars[i] = c;
    asciiTone[i] = v / maxCov;
    const d = asciiTone[i] - srcTone[i];
    err += d * d;
  }
  return { err: err / data.length, chars, asciiTone, tone };
}
// Dark-theme variant: glyph tone comes from ink DENSITY, and in dark mode the
// ink is light — so a dense glyph reads bright. Inverting the density per cell
// makes bright source areas dense (bright) and keeps the photo positive.
function charsFor(tone, dark) {
  const out = new Array(tone.length);       // NB: tone is a Float64Array — its .map() coerces chars to NaN
  for (let i = 0; i < tone.length; i++) out[i] = nearest((dark ? 1 - tone[i] : tone[i]) * maxCov)[0];
  return out;
}

const GAMMAS = [0.5, 0.6, 0.7, 0.85, 1.0, 1.2, 1.45, 1.7];
const CONTRASTS = [1.0, 1.2, 1.4, 1.6, 1.9, 2.2, 2.6];
let best = null, baseline = null;
for (const invert of [false, true])
  for (const g of GAMMAS)
    for (const c of CONTRASTS) {
      const r = assign(g, c, invert);
      if (!best || r.err < best.err) best = { ...r, gamma: g, contrast: c, invert };
      if (g === 1.0 && c === 1.0 && !invert) baseline = r.err;
    }

// --punch P: deliberately trade a little parity for display contrast, since the
// ramp tops out at ~29% ink and true darks otherwise read as grey. Applied as
// an extra contrast on top of the parity-optimal curve.
const punch = parseFloat(opt('punch', '1'));
const final = punch === 1 ? best : assign(best.gamma, best.contrast * punch, best.invert);

// Emit glyph JSON: `art` (light theme) + `artDark` (density-inverted for dark theme).
const toText = (chars) => {
  const ls = [];
  for (let y = 0; y < rows; y++) ls.push(chars.slice(y * cols, (y + 1) * cols).join('').replace(/\s+$/, ''));
  return ls.join('\n');
};
const outObj = {
  name, cols, rows,
  art: toText(charsFor(final.tone, false)),
  artDark: toText(charsFor(final.tone, true)),
  source: source || undefined, caption: caption || undefined, ref: ref || undefined,
};
if (edition) {
  const path = `content/editions/${edition}/glyphs/${name}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outObj, null, 2) + '\n');
}
const pct = (x) => (100 * x).toFixed(2);
console.error(`${name}: parity γ=${best.gamma} contrast=${best.contrast} invert=${best.invert}` +
  (punch !== 1 ? ` +punch ${punch}` : '') +
  `  parity-MSE ${best.err.toFixed(5)} (baseline ${baseline.toFixed(5)}, −${pct(1 - best.err / baseline)}%)  ${cols}×${rows}` +
  (edition ? `  → content/editions/${edition}/glyphs/${name}.json` : ''));

// --ab: source | reconstruction, upscaled nearest for eyeballing.
if (ab) {
  const K = 5;
  const up = (toneArr) => {
    const g = Buffer.alloc(cols * rows);
    for (let i = 0; i < g.length; i++) g[i] = Math.round(255 * (1 - toneArr[i]));
    return sharp(g, { raw: { width: cols, height: rows, channels: 1 } }).resize(cols * K, rows * K, { kernel: 'nearest' });
  };
  const [srcPng, recPng] = await Promise.all([up(srcTone).png().toBuffer(), up(final.asciiTone).png().toBuffer()]);
  const W = cols * K, H = rows * K, GAP = 16;
  await sharp({ create: { width: W * 2 + GAP, height: H, channels: 3, background: '#F4EEE0' } })
    .composite([{ input: srcPng, left: 0, top: 0 }, { input: recPng, left: W + GAP, top: 0 }])
    .png().toFile(ab);
  console.error(`  A/B (source | ascii) → ${ab}`);
}
