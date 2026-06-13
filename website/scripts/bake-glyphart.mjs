// One-off: render the glyph-art illustrations to static ASCII with the glyphcss
// rasterizer (headless), and commit the text. Heavy source (the .obj) stays on
// the newsroom machine — only the few-KB ASCII ships. Re-run if a model,
// camera, or built shape changes.  Run from website/:  node scripts/bake-glyphart.mjs
// Import the locally-built glyphcss source, not the published 0.0.3 package —
// shadows (castShadow/receiveShadow) landed in source but aren't in the npm
// build yet. This is a newsroom-machine bake step; the site only ships the
// committed ASCII, so the website's own glyphcss dep is untouched.
import { parseObj, buildRasterizeContext, rasterize, createGlyphPerspectiveCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OBJ = '/Users/apresmoi/asciss/website/public/gallery/obj/coliseum.obj';
const OUT_DIR = resolve(here, '..', 'src', 'data');
mkdirSync(OUT_DIR, { recursive: true });

// Center the mesh at the origin but KEEP its raw scale — the source glyphcss
// projection treats `zoom` as a CSS scale multiplier on world coords (same as
// the workbench), so normalizing to a unit box would throw the zoom off and
// also flatten self-shadow biasing. Center only; size via the camera zoom.
function center(polys) {
  const b = computeSceneBbox(polys);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  return polys.map((p) => ({ ...p, vertices: p.vertices.map((v) => [v[0] - cx, v[1] - cy, v[2] - cz]) }));
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

const DEG = Math.PI / 180;
// Light direction from azimuth/elevation — same mapping as the glyphcss
// workbench: [cosEl·sin(az), cosEl·cos(az), sin(el)].
function lightDir(azDeg, elDeg) {
  const az = azDeg * DEG, el = elDeg * DEG, ce = Math.cos(el);
  return [ce * Math.sin(az), ce * Math.cos(az), Math.sin(el)];
}

function bake(name, polygons, cam, cols, rows, opts = {}) {
  // cam.rotX/rotY in degrees (workbench convention) → radians.
  const camera = createGlyphPerspectiveCamera({ distance: 100, rotX: cam.rotX * DEG, rotY: cam.rotY * DEG, zoom: cam.zoom });
  const ctx = buildRasterizeContext({
    camera,
    grid: { cols, rows, cellAspect: 1.67 },
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

// ── Coliseum: workbench camera + lighting (az 50 / el 30, key 1, ambient 0.4,
//    shadow opacity 0.35, cast+receive self-shadow, no floor). zoom is a CSS
//    scale on the raw ~60-unit mesh; lift is in those world units (≈2). ──────
bake('coliseum', center(parseObj(readFileSync(OBJ, 'utf8')).polygons),
  { rotX: 63, rotY: 350, zoom: 1.4 }, 150, 120, {
    light: { direction: lightDir(50, 30), intensity: 1, color: '#ffffff' },
    ambient: 0.4,
    shadow: { opacity: 0.35, lift: 2 },
  });

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
// play coords are ~unit-scale; source zoom is a CSS multiplier so it needs a
// much larger zoom than the raw-mesh coliseum to fill the grid.
bake('play', center(buildPlay()), { rotX: 24, rotY: 29, zoom: 26 }, 60, 40);
