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
// CAMERA UNITS: the source build's camera takes rotX/rotY in DEGREES (the
// published 0.0.3 build took radians — that unit switch is why a straight
// port flattened the model to a top-down view). We use createGlyphOrthographic-
// Camera with the same rotX 65 / rotY 45 the glyphcss gallery preset uses, so
// the bake matches what the gallery shows.
import { parseObj, buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OBJ = '/Users/apresmoi/asciss/website/public/gallery/obj/coliseum.obj';
const OUT_DIR = resolve(here, '..', 'src', 'data');
mkdirSync(OUT_DIR, { recursive: true });

const DEG = Math.PI / 180;

// Center the mesh at the origin, keeping its raw scale (zoom sizes it).
function center(polys) {
  const b = computeSceneBbox(polys);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  return polys.map((p) => ({ ...p, vertices: p.vertices.map((v) => [v[0] - cx, v[1] - cy, v[2] - cz]) }));
}

// Light direction from azimuth/elevation (degrees). glyphcss's
// directionalLight.direction is the direction the light TRAVELS (into the
// scene), so a lamp positioned up at (az, el) shines the opposite way — negate,
// or the lit and shadowed faces swap and the model looks flat/wrong.
function lightDir(azDeg, elDeg) {
  const az = azDeg * DEG, el = elDeg * DEG, ce = Math.cos(el);
  return [-ce * Math.sin(az), -ce * Math.cos(az), -Math.sin(el)];
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

// cam.rotX / cam.rotY in DEGREES (source-build convention).
function bake(name, polygons, cam, grid, opts = {}) {
  const camera = createGlyphOrthographicCamera({ rotX: cam.rotX, rotY: cam.rotY, zoom: cam.zoom });
  const ctx = buildRasterizeContext({
    camera,
    grid: { cols: grid.cols, rows: grid.rows, cellAspect: grid.cellAspect ?? 1.67 },
    polygons,
    mode: 'solid',
    directionalLight: opts.light ?? { direction: [-0.45, -0.7, 0.6], intensity: 0.6 },
    ambientLight: { intensity: opts.ambient ?? 0.55 },
    // false → mono glyphs, colored by CSS (theme-aware). true → bake the light's
    // actual color shading like the gallery (colors fixed in the file, no theme
    // switch). Toggle per illustration via opts.useColors.
    useColors: opts.useColors ?? false,
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

// ── Coliseum: the gallery's oblique view (rotX 65 / rotY 45, orthographic);
//    light az 50 / el 35; self-shadow (cast + receive) opacity 0.3 / lift 0.05,
//    no floor. Key is 0.6, not the gallery's 1: the gallery shades in COLOR,
//    but this bake is monochrome (single CSS ink so it can theme-switch), where
//    tone is glyph DENSITY. A key of 1 saturates every lit cell to the densest
//    glyph and flattens the curved wall; 0.6 keeps the gradient (the textured
//    contrast the print had before). Ambient 0.5 holds the coverage solid. ─────
bake('coliseum', center(parseObj(readFileSync(OBJ, 'utf8')).polygons),
  { rotX: 55, rotY: 337, zoom: 1.15 }, { cols: 160, rows: 120 }, {
    light: { direction: lightDir(45, 35), intensity: 0.5, color: '#ffffff' },
    ambient: 0.5,
    shadow: { opacity: 0.2, lift: 1 },
    useColors: false,
  });

// The 404 flying saucer is baked separately by scripts/bake-saucer.mjs — its
// poly-pizza .glb needs a browser to decode (texture atlas) and the published
// glyphcss build reads cleaner than this local source build.

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
// Near face-on with a small tilt for depth (degrees). Explicit light (same
// negated convention as the coliseum) so the ring lights evenly and the
// triangle keeps a little depth.
bake('play', center(buildPlay()), { rotX: 0, rotY: -90, zoom: 20 }, { cols: 70, rows: 48 }, {
  light: { direction: lightDir(35, 45), intensity: 0.6, color: '#ffffff' },
  ambient: 0.55,
  shadow: { opacity: 0.3, lift: 0.05 },
});
