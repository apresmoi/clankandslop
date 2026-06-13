// One-off: sample ETOPO1 elevation down to a 1° land/ocean bitmask for the
// WorldGlyph globe. Output is committed (website/src/data/landmask.json); the
// source grid lives outside the repo, so this only needs to rerun if the
// resolution changes.
//
//   node ops/build-landmask.mjs [path/to/ETOPO1.grd]
import gdal from 'gdal-async';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GZ = '/Users/apresmoi/glyphcss/etopo/ETOPO1_Ice_g_gmt4.grd.gz';
const TMP = '/tmp/etopo1.grd';
const OUT = resolve(root, 'website/src/data/landmask.json');

const COLS = 360; // 1° grid
const ROWS = 180;

const src = process.argv[2] ?? TMP;
if (!existsSync(src)) {
  console.log(`decompressing ${GZ} → ${TMP} …`);
  execSync(`gunzip -c "${GZ}" > "${TMP}"`);
}

const ds = gdal.open(src);
const band = ds.bands.get(1);
// RasterIO decimation: read the full grid at COLS×ROWS directly.
const data = band.pixels.read(0, 0, ds.rasterSize.x, ds.rasterSize.y, null, {
  buffer_width: COLS,
  buffer_height: ROWS,
});

// Row 0 = lat +90 (north). '1' = land (elevation above sea level).
const rows = [];
for (let r = 0; r < ROWS; r++) {
  let line = '';
  for (let c = 0; c < COLS; c++) line += data[r * COLS + c] > 0 ? '1' : '0';
  rows.push(line);
}

writeFileSync(OUT, JSON.stringify({ cols: COLS, rows: ROWS, lon0: -180, lat0: 90, mask: rows }));
const land = rows.join('').split('1').length - 1;
console.log(`landmask ${COLS}×${ROWS} → ${OUT} (${Math.round(land / (COLS * ROWS) * 100)}% land)`);
