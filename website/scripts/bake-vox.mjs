// Bakes a voxcss .vox model to ASCII via the glyphcss rasterizer (parseVox).
// Usage from website/:  node scripts/bake-vox.mjs <vox-path> <out-name> [rotX] [rotY] [zoom]
// MagicaVoxel .vox is Z-up; we rotate to Y-up so the camera reads it upright.
import { parseVox, buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const [voxPath, outName, rotX = '18', rotY = '-28', zoom = '30'] = process.argv.slice(2);
const buf = readFileSync(voxPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const raw = parseVox(ab).polygons;

// Z-up → Y-up: (x,y,z) → (x, z, -y)
const up = raw.map((p) => ({ ...p, vertices: p.vertices.map(([x, y, z]) => [x, z, -y]) }));
const b = computeSceneBbox(up);
const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const k = 2 / (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1);
const polys = up.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - c[0]) * k, (v[1] - c[1]) * k, (v[2] - c[2]) * k]) }));

const ctx = buildRasterizeContext({
  camera: createGlyphOrthographicCamera({ rotX: Number(rotX), rotY: Number(rotY), zoom: Number(zoom) }),
  grid: { cols: 80, rows: 48, cellAspect: 1.67 },
  polygons: polys,
  mode: 'solid',
  directionalLight: { direction: [0.45, -0.55, -0.7], intensity: 1, color: '#ffffff' },
  ambientLight: { intensity: 0.4, color: '#ffffff' },
  useColors: false,
  doubleSided: true,
  smoothShading: false,
});

let L = rasterize(ctx).replace(/[ \t]+$/gm, '').split('\n');
while (L.length && !L[0].trim()) L.shift();
while (L.length && !L[L.length - 1].trim()) L.pop();
const indent = Math.min(...L.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
L = L.map((l) => l.slice(isFinite(indent) ? indent : 0));
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', `glyphart-${outName}.txt`);
writeFileSync(OUT, L.join('\n') + '\n');
console.log(`${outName} → glyphart-${outName}.txt  (${Math.max(...L.map((l) => l.length))}x${L.length})  polys:${polys.length} rotX${rotX} rotY${rotY} zoom${zoom}`);
