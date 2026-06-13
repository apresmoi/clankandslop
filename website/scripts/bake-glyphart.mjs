// One-off: render the coliseum model to a static ASCII illustration with the
// glyphcss rasterizer (headless), and commit the text. The heavy .obj stays on
// the newsroom machine — only the few-KB ASCII ships. Re-run if the model or
// camera changes.  Run from website/:  node scripts/bake-glyphart.mjs
import { parseObj, buildRasterizeContext, rasterize, createGlyphPerspectiveCamera, computeSceneBbox } from 'glyphcss';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// The model lives on the newsroom machine (datasets don't ship), like ETOPO.
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

const cols = 104, rows = 54;
const polygons = fitToUnitBbox(parseObj(readFileSync(OBJ, 'utf8')).polygons);
const camera = createGlyphPerspectiveCamera({ rotX: 1.12, rotY: 0.5, zoom: 0.42, distance: 100 });
const ctx = buildRasterizeContext({
  camera,
  grid: { cols, rows, cellAspect: 1.67 },
  polygons,
  mode: 'solid',
  directionalLight: { direction: [-0.45, -0.7, 0.6], intensity: 0.6 },
  ambientLight: { intensity: 0.55 },
  useColors: false,
});
const ascii = rasterize(ctx).replace(/[ \t]+$/gm, '');
writeFileSync(resolve(OUT_DIR, 'glyphart-coliseum.txt'), ascii + '\n');
console.log(`coliseum → src/data/glyphart-coliseum.txt (${cols}x${rows}, ${ascii.length} chars)`);
