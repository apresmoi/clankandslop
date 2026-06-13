// Build-time ASCII map renderer. Reads polygons from the local GADM 4.1
// File Geodatabase, projects them through glyphcss's orthographic camera,
// and prints the resulting ASCII grid to stdout.
//
// Usage:
//   node scripts/bake-map.mjs --bbox 22,26,118,122.5 --cols 70 --rows 22
//   node scripts/bake-map.mjs --country TWN
//   node scripts/bake-map.mjs --bbox 22,26,118,122.5 --countries CHN,TWN
import gdal from 'gdal-async';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGlyphOrthographicCamera,
  buildRasterizeContext,
  rasterize,
} from 'glyphcss';

const here = dirname(fileURLToPath(import.meta.url));
const GDB_PATH = resolve(here, '../../gadm_410.gdb');

// ── Args ───────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const cols = Number(arg('cols', '70'));
const rows = Number(arg('rows', '22'));
const mode = arg('mode', 'solid');
const country = arg('country', null);              // single ISO-3 code (e.g. "TWN")
const countriesArg = arg('countries', null);        // comma-separated ISO-3 codes
const bboxArg = arg('bbox', null);                  // "latMin,latMax,lngMin,lngMax"
const countries = countriesArg ? countriesArg.split(',').map((s) => s.trim().toUpperCase())
                : country     ? [country.toUpperCase()]
                              : null;
let bbox = bboxArg ? bboxArg.split(',').map(Number) : null;

if (!countries && !bbox) {
  console.error('Provide either --country TWN, --countries TWN,CHN, or --bbox latMin,latMax,lngMin,lngMax');
  process.exit(1);
}

// ── Open the geodatabase ───────────────────────────────────────────
const ds = gdal.open(GDB_PATH);
const layer = ds.layers.get(0);

// Build the GDAL attribute filter — if we're filtering by country code(s), do it
// at the GDAL level so we don't pull 356k features just to drop them.
if (countries) {
  const list = countries.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');
  layer.setAttributeFilter(`GID_0 IN (${list})`);
}

// Build the spatial filter from the bbox if given. GADM coords are WGS84
// (lng, lat, no transformation).
if (bbox) {
  const [latMin, latMax, lngMin, lngMax] = bbox;
  const env = new gdal.Envelope({ minX: lngMin, maxX: lngMax, minY: latMin, maxY: latMax });
  layer.setSpatialFilter(env.toPolygon());
}

// ── Collect features and figure out the bbox we render in ──────────
const featureNames = new Set();
const rings = []; // Array of [[lng, lat], ...] rings
let scannedBbox = null;

for (const f of layer.features) {
  const props = f.fields.toObject();
  const name = props.NAME_1 || props.NAME_0 || '?';
  featureNames.add(`${props.GID_0}:${props.NAME_0}`);
  const geom = f.getGeometry();
  if (!geom) continue;
  const extracted = extractRings(geom);
  for (const r of extracted) {
    rings.push(r);
    for (const [x, y] of r) {
      if (!scannedBbox) scannedBbox = { minX: x, maxX: x, minY: y, maxY: y };
      else {
        if (x < scannedBbox.minX) scannedBbox.minX = x;
        if (x > scannedBbox.maxX) scannedBbox.maxX = x;
        if (y < scannedBbox.minY) scannedBbox.minY = y;
        if (y > scannedBbox.maxY) scannedBbox.maxY = y;
      }
    }
  }
}
console.error(`[gadm] matched: ${[...featureNames].join(', ')}`);
console.error(`[gadm] rings: ${rings.length}, total vertices: ${rings.reduce((a, r) => a + r.length, 0)}`);

// If no explicit bbox was given, fall back to whatever the data spans.
const renderBbox = bbox ? {
  minX: Math.min(bbox[2], bbox[3]), maxX: Math.max(bbox[2], bbox[3]),
  minY: Math.min(bbox[0], bbox[1]), maxY: Math.max(bbox[0], bbox[1]),
} : scannedBbox;
if (!renderBbox) { console.error('No features matched.'); process.exit(1); }
console.error(`[render] bbox lng[${renderBbox.minX.toFixed(2)},${renderBbox.maxX.toFixed(2)}] lat[${renderBbox.minY.toFixed(2)},${renderBbox.maxY.toFixed(2)}]`);

// ── Project rings to glyphcss polygons ─────────────────────────────
const cx = (renderBbox.minX + renderBbox.maxX) / 2;
const cy = (renderBbox.minY + renderBbox.maxY) / 2;
const w = renderBbox.maxX - renderBbox.minX;
const h = renderBbox.maxY - renderBbox.minY;
const scale = 2 / Math.max(w, h); // fit into [-1, 1]

function toMeshXY(lng, lat) {
  return [(lng - cx) * scale, -(lat - cy) * scale, 0];
}

const polygons = rings
  .filter((r) => r.length >= 3)
  .map((ring) => ({ vertices: ring.map(([x, y]) => toMeshXY(x, y)), color: '#222' }));

// ── Render ──────────────────────────────────────────────────────────
const camera = createGlyphOrthographicCamera({ rotX: 0, rotY: 0, zoom: 0.5 });
const ctx = buildRasterizeContext({
  camera,
  grid: { cols, rows, cellAspect: 0.5 },
  polygons,
  mode,
  useColors: false,
});

console.log(rasterize(ctx));

// ── Helpers ─────────────────────────────────────────────────────────
/**
 * Pull every outer/inner ring out of a Polygon or MultiPolygon geometry,
 * returning a list of `[[lng, lat], ...]` rings. We don't distinguish outer
 * vs inner rings — for a flat fill render the distinction doesn't matter.
 */
function extractRings(geom) {
  const t = geom.name;
  if (t === 'POLYGON') {
    return polygonRings(geom);
  }
  if (t === 'MULTIPOLYGON') {
    const out = [];
    for (let i = 0; i < geom.children.count(); i++) {
      out.push(...polygonRings(geom.children.get(i)));
    }
    return out;
  }
  return [];
}

function polygonRings(polyGeom) {
  const out = [];
  // gdal-async: a Polygon's first ring is the outer; subsequent are holes.
  // The `.rings` collection exposes them uniformly.
  for (let i = 0; i < polyGeom.rings.count(); i++) {
    const ring = polyGeom.rings.get(i);
    const pts = [];
    for (let p = 0; p < ring.points.count(); p++) {
      const pt = ring.points.get(p);
      pts.push([pt.x, pt.y]);
    }
    out.push(pts);
  }
  return out;
}
