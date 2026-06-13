// One-off: render the glyph-art illustrations to static ASCII with the glyphcss
// rasterizer (headless), and commit the text. Heavy source (the .obj) stays on
// the newsroom machine — only the few-KB ASCII ships. Re-run if a model,
// camera, or built shape changes.  Run from website/:  node scripts/bake-glyphart.mjs
import { parseObj, buildRasterizeContext, rasterize, createGlyphPerspectiveCamera, computeSceneBbox } from 'glyphcss';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OBJ = '/Users/apresmoi/asciss/website/public/gallery/obj/coliseum.obj';
const OUT_DIR = resolve(here, '..', 'src', 'data');
mkdirSync(OUT_DIR, { recursive: true });

function fitToUnitBbox(polys) {
  const b = computeSceneBbox(polys);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const k = 2 / size;
  return polys.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - cx) * k, (v[1] - cy) * k, (v[2] - cz) * k]) }));
}

function bake(name, polygons, camOpts, cols, rows, shadows = false) {
  const camera = createGlyphPerspectiveCamera({ distance: 100, ...camOpts });
  const ctx = buildRasterizeContext({
    camera,
    grid: { cols, rows, cellAspect: 1.67 },
    polygons,
    mode: 'solid',
    directionalLight: { direction: [-0.45, -0.7, 0.6], intensity: 0.6 },
    ambientLight: { intensity: 0.55 },
    useColors: false,
    // Self-shadowing — the mesh casts and receives its own shadows, so the
    // arcades read with real depth.
    ...(shadows ? {
      shadow: { opacity: 0.5 },
      castShadowFlags: polygons.map(() => true),
      receiveShadowFlags: polygons.map(() => true),
    } : {}),
  });
  const ascii = rasterize(ctx).replace(/[ \t]+$/gm, '');
  writeFileSync(resolve(OUT_DIR, `glyphart-${name}.txt`), ascii + '\n');
  console.log(`${name} → src/data/glyphart-${name}.txt (${cols}x${rows}, ${ascii.length} chars)`);
}

// ── Coliseum: the model, zoomed out for margin, self-shadowed ──────────────
bake('coliseum', fitToUnitBbox(parseObj(readFileSync(OBJ, 'utf8')).polygons),
  { rotX: 1.12, rotY: 0.5, zoom: 0.34 }, 104, 56, true);

// ── Play: an extruded triangle inside an extruded ring, angled so the
//    extrusion depth shows. ──────────────────────────────────────────────────
function buildPlay() {
  const polys = [];
  const rz = 0.17, tz = 0.27, ri = 0.58, ro = 0.92, seg = 72;
  const pt = (a, r, z) => [Math.cos(a) * r, Math.sin(a) * r, z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    polys.push({ vertices: [pt(a0, ro, rz), pt(a1, ro, rz), pt(a1, ri, rz), pt(a0, ri, rz)] });      // front
    polys.push({ vertices: [pt(a0, ri, -rz), pt(a1, ri, -rz), pt(a1, ro, -rz), pt(a0, ro, -rz)] });  // back
    polys.push({ vertices: [pt(a0, ro, -rz), pt(a1, ro, -rz), pt(a1, ro, rz), pt(a0, ro, rz)] });     // outer
    polys.push({ vertices: [pt(a0, ri, rz), pt(a1, ri, rz), pt(a1, ri, -rz), pt(a0, ri, -rz)] });     // inner
  }
  const tri = [[-0.32, -0.42], [-0.32, 0.42], [0.46, 0]];
  const f = tri.map(([x, y]) => [x, y, tz]), bk = tri.map(([x, y]) => [x, y, -tz]);
  polys.push({ vertices: f }, { vertices: [...bk].reverse() });
  for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; polys.push({ vertices: [f[i], f[j], bk[j], bk[i]] }); }
  return polys;
}
bake('play', buildPlay(), { rotX: 0.42, rotY: 0.5, zoom: 0.38 }, 56, 36);
