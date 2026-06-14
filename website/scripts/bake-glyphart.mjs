// One-off: render the glyph-art illustrations to static ASCII with the glyphcss
// rasterizer (headless), and commit the text. Heavy source (the .obj) stays on
// the newsroom machine — only the few-KB ASCII ships. Re-run if a model,
// camera, or built shape changes.  Run from website/:  node scripts/bake-glyphart.mjs
//
// Imports the LOCALLY-BUILT glyphcss source, not the published 0.0.3 package:
// self-shadows (castShadow/receiveShadow) only exist in source. Build it first:
//   (cd /Users/apresmoi/glyphcss/packages/glyphcss && npm run build)
// The site never ships glyphcss — only the committed ASCII — so its own
// dependency is untouched.
//
// Camera note: the source build's createGlyphPerspectiveCamera defaults to
// ORTHOGRAPHIC and projects the coliseum disc flat (top-down) at any rotX. To
// get the recognizable oblique amphitheatre we tip the MESH up (rotate about X)
// so its height becomes screen-vertical and the bowl faces the camera; the
// camera then only needs a small downward tilt. Tipping the bowl toward the
// camera is also what makes the wall's self-shadow fall on a visible surface.
import { parseObj, buildRasterizeContext, rasterize, createGlyphPerspectiveCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OBJ = '/Users/apresmoi/asciss/website/public/gallery/obj/coliseum.obj';
const OUT_DIR = resolve(here, '..', 'src', 'data');
mkdirSync(OUT_DIR, { recursive: true });

const DEG = Math.PI / 180;

function fitToBbox(polys, size = 2) {
  const b = computeSceneBbox(polys);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const k = size / span;
  return polys.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - cx) * k, (v[1] - cy) * k, (v[2] - cz) * k]) }));
}

// Rotate the mesh about the world X axis (used to stand the coliseum up).
function meshRotX(polys, deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return polys.map((p) => ({ ...p, vertices: p.vertices.map(([x, y, z]) => [x, y * c - z * s, y * s + z * c]) }));
}

// Light direction from azimuth/elevation (degrees), matching the glyphcss
// workbench: [cosEl·sin(az), cosEl·cos(az), sin(el)].
function lightDir(azDeg, elDeg) {
  const az = azDeg * DEG, el = elDeg * DEG, ce = Math.cos(el);
  return [ce * Math.sin(az), ce * Math.cos(az), Math.sin(el)];
}

// Crop the rendered grid to the shape's bounding box (+pad cells) so there's
// no dead margin — the illustration then fills its cell tightly.
function trim(ascii, pad = 1) {
  let lines = ascii.split('\n');
  const rowsWith = lines.map((l) => l.search(/\S/) !== -1);
  const top = rowsWith.indexOf(true), bot = rowsWith.lastIndexOf(true);
  if (top === -1) return ascii;
  let minL = Infinity, maxR = 0;
  for (const l of lines) { const i = l.search(/\S/); if (i !== -1) { minL = Math.min(minL, i); maxR = Math.max(maxR, l.replace(/\s+$/, '').length); } }
  minL = Math.max(0, minL - pad); maxR += pad;
  return lines.slice(Math.max(0, top - pad), bot + 1 + pad)
    .map((l) => l.slice(minL, maxR).replace(/\s+$/, '')).join('\n');
}

function bake(name, polygons, cam, grid, opts = {}) {
  const camera = createGlyphPerspectiveCamera({
    distance: 100, perspective: 0,
    rotX: cam.rotX * DEG, rotY: cam.rotY * DEG, zoom: cam.zoom,
  });
  const ctx = buildRasterizeContext({
    camera,
    grid: { cols: grid.cols, rows: grid.rows, cellAspect: 1.67 },
    polygons,
    mode: 'solid',
    directionalLight: opts.light ?? { direction: [-0.45, -0.7, 0.6], intensity: 0.6 },
    ambientLight: { intensity: opts.ambient ?? 0.55 },
    useColors: false,
    ...(opts.shadow ? {
      shadow: opts.shadow,
      castShadowFlags: polygons.map(() => true),
      receiveShadowFlags: polygons.map(() => true),
    } : {}),
  });
  const ascii = trim(rasterize(ctx).replace(/[ \t]+$/gm, ''), name === 'play' ? 1 : 0);
  writeFileSync(resolve(OUT_DIR, `glyphart-${name}.txt`), ascii + '\n');
  const w = Math.max(...ascii.split('\n').map((l) => l.length)), h = ascii.split('\n').length;
  console.log(`${name} → src/data/glyphart-${name}.txt (trimmed ${w}x${h}, ${ascii.length} chars)`);
}

// ── Coliseum: mesh tipped up 75° so the arched wall stands and the bowl faces
//    the camera; light az 50 / el 35, key 1, ambient 0.4; self-shadow (cast +
//    receive) opacity 0.3 / lift 0.05, no floor. The wall casts into the bowl. ─
bake('coliseum',
  fitToBbox(meshRotX(parseObj(readFileSync(OBJ, 'utf8')).polygons, 75), 2),
  { rotX: 25, rotY: 0, zoom: 38 }, { cols: 150, rows: 96 }, {
    light: { direction: lightDir(50, 35), intensity: 1, color: '#ffffff' },
    ambient: 0.4,
    shadow: { opacity: 0.3, lift: 0.05 },
  });

// ── Play: an extruded ring + a separate, smaller extruded triangle well inside
//    it (a clear gap so the two shapes never fuse), a small tilt for depth. ────
function buildPlay() {
  const polys = [];
  const rz = 0.16, tz = 0.24, ri = 0.6, ro = 0.92, seg = 80;
  const pt = (a, r, z) => [Math.cos(a) * r, Math.sin(a) * r, z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    polys.push({ vertices: [pt(a0, ro, rz), pt(a1, ro, rz), pt(a1, ri, rz), pt(a0, ri, rz)] });      // front
    polys.push({ vertices: [pt(a0, ri, -rz), pt(a1, ri, -rz), pt(a1, ro, -rz), pt(a0, ro, -rz)] });  // back
    polys.push({ vertices: [pt(a0, ro, -rz), pt(a1, ro, -rz), pt(a1, ro, rz), pt(a0, ro, rz)] });     // outer
    polys.push({ vertices: [pt(a0, ri, rz), pt(a1, ri, rz), pt(a1, ri, -rz), pt(a0, ri, -rz)] });     // inner
  }
  const tri = [[-0.26, -0.3], [-0.26, 0.3], [0.34, 0]];
  const f = tri.map(([x, y]) => [x, y, tz]), bk = tri.map(([x, y]) => [x, y, -tz]);
  polys.push({ vertices: f }, { vertices: [...bk].reverse() });
  for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; polys.push({ vertices: [f[i], f[j], bk[j], bk[i]] }); }
  return polys;
}
bake('play', fitToBbox(buildPlay(), 2), { rotX: 15, rotY: 10, zoom: 18 }, { cols: 70, rows: 48 });
