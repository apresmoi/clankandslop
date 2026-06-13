// Bake a bounded regional map from ETOPO1 into a compact JSON asset.
//
// The full dataset (~900MB decompressed) lives wherever the newsroom runs;
// editions only ever carry the few-KB baked artifact. An agent requests a
// map by coordinates:
//
//   node ops/bake-map.mjs --edition 2026-05-17 --name taiwan-strait \
//     --west 105 --east 130 --south 15 --north 32 --cols 72 --rows 44
//
// Output: content/editions/<edition>/maps/<name>.json
//   { name, west, east, south, north, cols, rows, bands: [row strings] }
// where each band char is 0 (water) … 8 (high mountain), row 0 = north.
// Band thresholds mirror glyphcss's bake-globe.mjs so palettes stay portable.
import gdal from 'gdal-async';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const required = ['edition', 'name', 'west', 'east', 'south', 'north'];
for (const k of required) if (args[k] === undefined) { console.error(`missing --${k}`); process.exit(1); }

const west = Number(args.west), east = Number(args.east);
const south = Number(args.south), north = Number(args.north);
const cols = Number(args.cols ?? 72), rows = Number(args.rows ?? 44);
if (!(west < east && south < north)) { console.error('bounds must satisfy west<east, south<north'); process.exit(1); }

const GZ = args.etopoGz ?? '/Users/apresmoi/glyphcss/etopo/ETOPO1_Ice_g_gmt4.grd.gz';
const SRC = args.etopo ?? '/tmp/etopo1.grd';
if (!existsSync(SRC)) {
  console.log(`decompressing ${GZ} → ${SRC} …`);
  execSync(`gunzip -c "${GZ}" > "${SRC}"`);
}

function elevToBand(elev) {
  if (elev < 0)    return 0;
  if (elev < 250)  return 1;
  if (elev < 800)  return 2;
  if (elev < 1600) return 3;
  if (elev < 2600) return 4;
  if (elev < 3600) return 5;
  if (elev < 4600) return 6;
  if (elev < 5600) return 7;
  return 8;
}

const ds = gdal.open(SRC);
const { x: NX, y: NY } = ds.rasterSize; // ETOPO1: 21601 × 10801, 1-arcmin, lon -180..180, lat 90..-90
const lonToCol = (lon) => Math.max(0, Math.min(NX - 1, Math.round(((lon + 180) / 360) * (NX - 1))));
const latToRow = (lat) => Math.max(0, Math.min(NY - 1, Math.round(((90 - lat) / 180) * (NY - 1))));

const x0 = lonToCol(west), x1 = lonToCol(east);
const y0 = latToRow(north), y1 = latToRow(south);
const data = ds.bands.get(1).pixels.read(x0, y0, x1 - x0 + 1, y1 - y0 + 1, null, {
  buffer_width: cols,
  buffer_height: rows,
});

const bands = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) line += elevToBand(data[r * cols + c]);
  bands.push(line);
}

const outDir = resolve(root, 'content/editions', args.edition, 'maps');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${args.name}.json`);
writeFileSync(outPath, JSON.stringify({ name: args.name, west, east, south, north, cols, rows, bands }));
const land = bands.join('').replace(/0/g, '').length;
console.log(`${outPath} — ${cols}×${rows}, ${Math.round(land / (cols * rows) * 100)}% land`);
