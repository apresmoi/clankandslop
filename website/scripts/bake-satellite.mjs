// Bakes the "satellite" glyph: a procedural satellite (bus body + two solar
// wings + a comms dish) built from box primitives and rasterized to ASCII by
// the glyphcss renderer — the SpaceX/space house illustration. Pure Node, no
// shipped model; only the few-KB ASCII (src/data/glyphart-satellite.txt) ships.
//   Run from website/:  node scripts/bake-satellite.mjs
import { buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CFG = {
  rotX: 58, rotY: 36, zoom: 30,           // gallery's proven top-down-3/4 preset
  cols: 108, rows: 46, cellAspect: 1.67,   // 1.67 ≈ line-height 1 ÷ 0.6 (GlyphArt default)
  lightDirection: [0.4, -0.7, -0.55], lightIntensity: 1, ambientIntensity: 0.4,
};

// A box as 6 quad faces (CCW). doubleSided render, so winding is forgiving.
function box(cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const f = [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[3,2,6,7],[4,5,1,0]];
  return f.map((idx) => ({ vertices: idx.map((i) => v[i]) }));
}

// Satellite: central bus, two solar wings spanning x, a small dish off the front.
// Wings are HORIZONTAL (broad in X & Z, thin in Y); the bus is tall in Y so it
// stands up toward the top-down camera. Two panels spread flat to either side.
const raw = [
  ...box(0, 0, 0, 0.85, 0.95, 0.74),         // bus body — tallest in Y
  ...box(-1.5, 0, 0, 1.8, 0.06, 0.74),       // left solar panel (flat)
  ...box(1.5, 0, 0, 1.8, 0.06, 0.74),        // right solar panel (flat)
  ...box(-0.72, 0, 0, 0.5, 0.06, 0.12),      // left boom
  ...box(0.72, 0, 0, 0.5, 0.06, 0.12),       // right boom
  ...box(0, -0.66, 0, 0.34, 0.4, 0.34),      // comms dish/sensor below the bus
];

// Normalize to a 2-unit box so the camera zoom frames it predictably.
const b = computeSceneBbox(raw);
const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const k = 2 / (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1);
const polys = raw.map((p) => ({ ...p, vertices: p.vertices.map((vv) => [(vv[0] - c[0]) * k, (vv[1] - c[1]) * k, (vv[2] - c[2]) * k]) }));

const ctx = buildRasterizeContext({
  camera: createGlyphOrthographicCamera({ rotX: CFG.rotX, rotY: CFG.rotY, zoom: CFG.zoom }),
  grid: { cols: CFG.cols, rows: CFG.rows, cellAspect: CFG.cellAspect },
  polygons: polys,
  mode: 'solid',
  directionalLight: { direction: CFG.lightDirection, intensity: CFG.lightIntensity, color: '#ffffff' },
  ambientLight: { intensity: CFG.ambientIntensity, color: '#ffffff' },
  useColors: false,
  doubleSided: true,
  smoothShading: false,
});

let L = rasterize(ctx).replace(/[ \t]+$/gm, '').split('\n');
while (L.length && !L[0].trim()) L.shift();
while (L.length && !L[L.length - 1].trim()) L.pop();
const indent = Math.min(...L.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
L = L.map((l) => l.slice(isFinite(indent) ? indent : 0));
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'glyphart-satellite.txt');
writeFileSync(OUT, L.join('\n') + '\n');
console.log(`satellite → glyphart-satellite.txt  (${Math.max(...L.map((l) => l.length))}x${L.length})  rotX${CFG.rotX} rotY${CFG.rotY} zoom${CFG.zoom}`);
