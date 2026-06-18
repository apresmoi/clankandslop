// Bake a .glb/.gltf model to ASCII via glyphcss (parseGltf), with AUTO-FRAMING:
// it sweeps the ortho zoom so the model fills ~78% of the grid (no overfill).
// Usage from website/:  node scripts/bake-glb.mjs <glb> <out-name> [rotX] [rotY] [zup]
//   zup=1 rotates Z-up→Y-up (some exporters). Default Y-up (glTF standard).
import { parseGltf, buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const [glb, outName, rotX = '14', rotY = '-28', zup = '0'] = process.argv.slice(2);
const COLS = 72, ROWS = 48, CELL = 1.67;

const buf = readFileSync(glb);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
let raw = parseGltf(ab).polygons;
if (zup === '1') raw = raw.map((p) => ({ ...p, vertices: p.vertices.map(([x, y, z]) => [x, z, -y]) }));      // Z-up → Y-up
if (zup === '2') raw = raw.map((p) => ({ ...p, vertices: p.vertices.map(([x, y, z]) => [-y, x, z]) }));      // stand X-axis upright (+90° about Z)

const b = computeSceneBbox(raw);
const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const k = 2 / (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1);
const polys = raw.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - c[0]) * k, (v[1] - c[1]) * k, (v[2] - c[2]) * k]) }));

function render(zoom) {
  const ctx = buildRasterizeContext({
    camera: createGlyphOrthographicCamera({ rotX: Number(rotX), rotY: Number(rotY), zoom }),
    grid: { cols: COLS, rows: ROWS, cellAspect: CELL },
    polygons: polys, mode: 'solid',
    directionalLight: { direction: [0.45, -0.5, -0.72], intensity: 1, color: '#ffffff' },
    ambientLight: { intensity: 0.4, color: '#ffffff' },
    useColors: false, doubleSided: true, smoothShading: false,
  });
  return rasterize(ctx);
}
function coverage(out) {
  const lines = out.replace(/[ \t]+$/gm, '').split('\n');
  const used = lines.filter((l) => l.trim());
  const h = used.length;
  const w = Math.max(0, ...lines.map((l) => { const t = l.replace(/\s+$/, ''); return t.length - (t.length - t.trimStart().length); }));
  return { cov: Math.max(w / COLS, h / ROWS), w, h };
}

// Auto-frame: start small, scale toward 78% fill.
let zoom = 6, out = render(zoom), info;
for (let i = 0; i < 6; i++) {
  info = coverage(out);
  if (info.cov > 0.72 && info.cov < 0.9) break;
  zoom *= 0.8 / Math.max(info.cov, 0.05);
  out = render(zoom);
}

let L = out.replace(/[ \t]+$/gm, '').split('\n');
while (L.length && !L[0].trim()) L.shift();
while (L.length && !L[L.length - 1].trim()) L.pop();
const indent = Math.min(...L.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
L = L.map((l) => l.slice(isFinite(indent) ? indent : 0));
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', `glyphart-${outName}.txt`);
writeFileSync(OUT, L.join('\n') + '\n');
console.log(`${outName} → glyphart-${outName}.txt  (${Math.max(...L.map((l) => l.length))}x${L.length})  zoom≈${zoom.toFixed(1)} cov${info.cov.toFixed(2)} rotX${rotX} rotY${rotY} zup${zup}`);
