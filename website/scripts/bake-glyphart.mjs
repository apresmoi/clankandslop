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

// Crop the rendered grid to the shape's bounding box (+pad cells) so there's
// no dead margin — the illustration then fills its cell tightly.
function trim(ascii, pad = 1) {
  let lines = ascii.split('\n');
  const filled = lines.map((l) => l.search(/\S/));
  const rowsWith = filled.map((i) => i !== -1);
  const top = rowsWith.indexOf(true), bot = rowsWith.lastIndexOf(true);
  if (top === -1) return ascii;
  let minL = Infinity, maxR = 0;
  for (const l of lines) { const i = l.search(/\S/); if (i !== -1) { minL = Math.min(minL, i); maxR = Math.max(maxR, l.replace(/\s+$/, '').length); } }
  minL = Math.max(0, minL - pad); maxR += pad;
  return lines.slice(Math.max(0, top - pad), bot + 1 + pad)
    .map((l) => l.slice(minL, maxR).replace(/\s+$/, '')).join('\n');
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
  const ascii = trim(rasterize(ctx).replace(/[ \t]+$/gm, ''), name === 'play' ? 1 : 0);
  writeFileSync(resolve(OUT_DIR, `glyphart-${name}.txt`), ascii + '\n');
  const w = Math.max(...ascii.split('\n').map((l) => l.length)), h = ascii.split('\n').length;
  console.log(`${name} → src/data/glyphart-${name}.txt (trimmed ${w}x${h}, ${ascii.length} chars)`);
}

// ── Coliseum: the model, zoomed out for margin, self-shadowed ──────────────
bake('coliseum', fitToUnitBbox(parseObj(readFileSync(OBJ, 'utf8')).polygons),
  { rotX: 1.42, rotY: 0.5, zoom: 0.3 }, 120, 56, true);

// ── Play: an extruded ring + a separate, smaller extruded triangle well
//    inside it (a clear gap so the two shapes never fuse), angled for depth. ──
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
  // Triangle kept well within the ring's inner radius (0.6) — corners reach
  // ~0.42 from center, leaving a clear ring of empty space around it.
  const tri = [[-0.26, -0.3], [-0.26, 0.3], [0.34, 0]];
  const f = tri.map(([x, y]) => [x, y, tz]), bk = tri.map(([x, y]) => [x, y, -tz]);
  polys.push({ vertices: f }, { vertices: [...bk].reverse() });
  for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; polys.push({ vertices: [f[i], f[j], bk[j], bk[i]] }); }
  return polys;
}
bake('play', buildPlay(), { rotX: 0.42, rotY: 0.5, zoom: 0.32 }, 60, 40);
