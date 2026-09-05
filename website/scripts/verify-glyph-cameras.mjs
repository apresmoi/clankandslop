// Headless guard for the glyphcss camera conversion in src/lib/glyphCamera.ts.
//
// glyphcss 0.1.0 changed rotX/rotY from radians to degrees, zoom from a
// fraction of the smaller grid axis to CSS px per world unit, and moved the old
// `distance` pinhole to `perspective`. Nothing about that is a type error: the
// pre-0.1 numbers still compile and still render — into one character cell.
// That failure is invisible to a build, so it needs a test that looks at pixels.
//
// This runs the rasterizer directly (no DOM), where glyphcss falls back to a
// 50px character cell — the same BASE_TILE the conversion uses — so the two
// sides line up. The browser-side check (verify-glyph-scenes.mjs) covers the
// real components with real font metrics.
//
//   node scripts/verify-glyph-cameras.mjs
//
// Needs Node 22.6+ (native TypeScript type stripping) to import the shared lib.
import { createGlyphPerspectiveCamera, buildRasterizeContext, rasterize } from 'glyphcss';
import { BASE_TILE, GLYPH_PERSPECTIVE, glyphRot, glyphZoom } from '../src/lib/glyphCamera.ts';

const D = Math.PI / 180;
const LAND = '#0f0f0f';
const OCEAN = '#d5cfc3';

const toVec3 = (lat, lon, r = 1) => [
  r * Math.cos(lat * D) * Math.cos(lon * D),
  r * Math.cos(lat * D) * Math.sin(lon * D),
  r * Math.sin(lat * D),
];

/** A globe of lat/lon quads, wound the way WorldGlyph winds them, with a
    coarse land band so both colours are in play. */
function globePolygons(step = 10) {
  const polygons = [];
  for (let lat = -90; lat < 90; lat += step)
    for (let lon = -180; lon < 180; lon += step)
      polygons.push({
        vertices: [
          toVec3(lat, lon), toVec3(lat, lon + step),
          toVec3(lat + step, lon + step), toVec3(lat + step, lon),
        ],
        color: Math.abs(lat) < 50 && lon > -120 && lon < 60 ? LAND : OCEAN,
      });
  return polygons;
}

/** MapGlyph's interactive geometry: a lat/lon plane of terrain quads wound
    NW→SW→SE→NE, viewed from almost overhead. No edition uses `interactive:
    true` today (they all take the typeset print path, which never touches
    glyphcss), so nothing on the built site exercises this — hence covering it
    here rather than in the browser check. */
function planePolygons(n = 40) {
  const polygons = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const x0 = -1 + (r / n) * 2, x1 = -1 + ((r + 1) / n) * 2;
      const y0 = -1 + (c / n) * 2, y1 = -1 + ((c + 1) / n) * 2;
      const z = ((r + c) % 5) * 0.018;
      polygons.push({
        vertices: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]],
        color: (r + c) % 5 ? LAND : OCEAN,
      });
    }
  return polygons;
}

const GRID = { cols: 84, rows: 40, cellAspect: 1.67 };
const ROT_X = 1.2;   // radians, as the edition JSON ships them
const ROT_Y = 0.9;
const ZOOM_FRACTION = 0.33;

function render(camera, polygons = globePolygons(), grid = GRID) {
  const html = rasterize(buildRasterizeContext({
    camera,
    grid,
    polygons,
    mode: 'solid',
    useColors: true,
    directionalLight: { direction: [-0.5, -1, 0.4], intensity: 0.2 },
    ambientLight: { intensity: 0.85 },
  }));
  const plain = html.replace(/<[^>]+>/g, '');
  const colors = [...new Set([...html.matchAll(/color:\s*([^"';]+)/g)].map((m) => m[1].trim().toLowerCase()))];
  return {
    ink: plain.replace(/\s/g, '').length,
    rows: plain.split('\n').filter((l) => l.trim()).length,
    // Land is near-black ink; ocean is a pale paper/ink blend. The glyph ramp
    // carries lighting only, so this colour split is the ONLY thing separating
    // land from sea — losing it is a real regression even if the disc renders.
    land: colors.filter((c) => c.startsWith('#') && parseInt(c.slice(1, 3), 16) < 0x40).length,
    ocean: colors.filter((c) => c.startsWith('#') && parseInt(c.slice(1, 3), 16) > 0xa0).length,
  };
}

const fixed = render(createGlyphPerspectiveCamera({
  rotX: glyphRot(ROT_X),
  rotY: glyphRot(ROT_Y),
  zoom: glyphZoom(ZOOM_FRACTION, GRID.cols, GRID.rows, BASE_TILE),
  perspective: GLYPH_PERSPECTIVE,
}));

// The exact call the component used to make. Kept as a live control: if the
// conversion is ever removed the two results converge and this script fails,
// instead of the globe quietly disappearing from the front page.
const unconverted = render(createGlyphPerspectiveCamera({
  rotX: ROT_X, rotY: ROT_Y, zoom: ZOOM_FRACTION, distance: 100,
}));

// MapGlyph's interactive camera, through the same conversion.
const MAP_GRID = { cols: 80, rows: 38, cellAspect: 1.67 };
const mapFixed = render(createGlyphPerspectiveCamera({
  rotX: glyphRot(0.45),
  rotY: glyphRot(0),
  zoom: glyphZoom(0.42, MAP_GRID.cols, MAP_GRID.rows, BASE_TILE),
  perspective: GLYPH_PERSPECTIVE,
}), planePolygons(), MAP_GRID);
const mapUnconverted = render(createGlyphPerspectiveCamera({
  rotX: 0.45, rotY: 0, zoom: 0.42, distance: 100,
}), planePolygons(), MAP_GRID);

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(fixed.ink > 800, `converted camera drew ${fixed.ink} cells, expected > 800`);
check(fixed.rows >= GRID.rows - 2, `converted camera filled ${fixed.rows}/${GRID.rows} rows`);
check(fixed.land > 0, 'converted camera drew no land-ink colours');
check(fixed.ocean > 0, 'converted camera drew no ocean colours');
check(unconverted.ink <= 4, `pre-0.1 params drew ${unconverted.ink} cells — the conversion may be a no-op now`);

check(mapFixed.ink > 500, `converted map camera drew ${mapFixed.ink} cells, expected > 500`);
check(mapFixed.land > 0 && mapFixed.ocean > 0, 'converted map camera lost its two-tone terrain');
check(mapUnconverted.ink <= 4, `pre-0.1 map params drew ${mapUnconverted.ink} cells — the conversion may be a no-op now`);

console.log(`globe converted   : ${fixed.ink} cells, ${fixed.rows} rows, ${fixed.land} land colours, ${fixed.ocean} ocean colours`);
console.log(`globe pre-0.1 args: ${unconverted.ink} cells  (this is the bug being guarded against)`);
console.log(`map   converted   : ${mapFixed.ink} cells, ${mapFixed.land} land colours, ${mapFixed.ocean} ocean colours`);
console.log(`map   pre-0.1 args: ${mapUnconverted.ink} cells`);

if (failures.length) {
  console.error('\nFAIL\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nOK — glyphcss camera conversion renders a filled, two-tone globe.');
