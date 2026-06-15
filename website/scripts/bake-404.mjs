// Bakes the 404 glyph: the literal text "404" extruded into a 3D mesh (via
// @layoutit/polycss-fonts) and rasterized to ASCII by the glyphcss renderer.
// Runs in pure Node — fetches the TTF, extrudes, rasterizes, writes the
// committed ASCII to src/data/glyphart-404.txt.  Run from website/:
//   node scripts/bake-404.mjs          (needs network: the Google Fonts TTF)
//
// To iterate live, run `npm run watch:404` in a second terminal and edit the
// TUNABLES below — every save re-bakes and reloads the 404 page.
import { parseFont, composeText } from '/Users/apresmoi/Documents/voxcss/packages/fonts/dist/index.js';
import { buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ─── TUNABLES — edit, save, and (with the watcher) the 404 reloads. ──────────
const CFG = {
  text: '404',
  // Any .ttf/.otf URL. DM Serif Display = the nameplate font (brand match).
  font: 'https://raw.githubusercontent.com/google/fonts/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf',
  depth: 12,           // extrusion depth in glyph units (chunkier 3D = larger)
  letterSpacing: 14,   // gap between digits so the tilted 3D bodies don't overlap

  // Camera (degrees + ortho zoom). The text faces the camera at rotX0/rotY0
  // (flat, readable, no depth); a little rotX + negative rotY turns it so the
  // extruded side walls show. zoom frames it (mesh normalized to a 2-unit box).
  rotX: 12,
  rotY: -16,
  zoom: 30,

  // Directional light = the direction light TRAVELS. Lower ambient = the side
  // walls read darker (more 3D); higher = flatter/solid.
  lightDirection: [0.4, -0.5, -0.6],
  lightIntensity: 1,
  ambientIntensity: 0.4,

  // Grid + proportion. cellAspect ≈ display line-height ÷ 0.6 (the display
  // line-height lives in GlyphArt.astro, `.glyphart-404 .glyphart-pre`).
  cols: 130,
  rows: 44,
  cellAspect: 1.28,
};
// ───────────────────────────────────────────────────────────────────────────

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'glyphart-404.txt');

const ttf = await (await fetch(CFG.font)).arrayBuffer();
const font = parseFont(new Uint8Array(ttf));
const raw = composeText(font, CFG.text, { size: 100, depth: CFG.depth, letterSpacing: CFG.letterSpacing, curveSteps: 6 });

// Normalize to a 2-unit box (center + uniform scale), so the camera zoom frames
// it predictably regardless of the font's own units.
const b = computeSceneBbox(raw);
const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const k = 2 / (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1);
const polys = raw.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - c[0]) * k, (v[1] - c[1]) * k, (v[2] - c[2]) * k]) }));

const ctx = buildRasterizeContext({
  camera: createGlyphOrthographicCamera({ rotX: CFG.rotX, rotY: CFG.rotY, zoom: CFG.zoom }),
  grid: { cols: CFG.cols, rows: CFG.rows, cellAspect: CFG.cellAspect },
  polygons: polys,
  mode: 'solid',
  directionalLight: { direction: CFG.lightDirection, intensity: CFG.lightIntensity, color: '#ffffff' },
  ambientLight: { intensity: CFG.ambientIntensity, color: '#ffffff' },
  useColors: false,
  // Extruded text from polycss-fonts isn't wound for glyphcss's backface cull
  // (polycss's DOM renderer doesn't need it), so cull would drop the wrong
  // faces — render two-sided. Smooth shading keeps the "0" curve seam-free.
  doubleSided: true,
  smoothShading: true,
  creaseAngle: 50,
});

// Crop to the glyph's bounds: drop empty top/bottom rows AND the common left
// indent (strip trailing ws), so GlyphArt's margin:auto centers the actual art.
let L = rasterize(ctx).replace(/[ \t]+$/gm, '').split('\n');
while (L.length && !L[0].trim()) L.shift();
while (L.length && !L[L.length - 1].trim()) L.pop();
const indent = Math.min(...L.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
L = L.map((l) => l.slice(indent));
writeFileSync(OUT, L.join('\n') + '\n');
console.log(`404 → glyphart-404.txt  (${Math.max(...L.map((l) => l.length))}x${L.length})  rotX${CFG.rotX} rotY${CFG.rotY} zoom${CFG.zoom} depth${CFG.depth}`);
