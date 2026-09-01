// Build the deterministic ETOPO1 relief bundle mounted read-only by Caslon.
//
// The ~395MB grid is not a repository artifact: it is a shared, immutable
// reference dataset that every archived map was baked from. Like the newsroom
// bundles it is a gitignored build output, pinned by sha256 in the agent
// Spawnfile so the compiler verifies exactly which bytes a candidate carries.
//
//   node agentic-org/scripts/build-etopo-bundle.mjs [--source <grd.gz>]
//
// Source resolution mirrors ops/bake-map.mjs: --source, then CLANK_ETOPO_GZ,
// then the conventional checkout-relative path. Prints the digest to paste
// into agents/caslon/Spawnfile.
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((token, index, all) =>
    token.startsWith('--') ? [[token.slice(2), all[index + 1]]] : []
  )
);

const ENTRY = 'ETOPO1_Ice_g_gmt4.grd.gz';
const source = path.resolve(
  args.source ?? process.env.CLANK_ETOPO_GZ ?? path.join(repo, '../glyphcss/etopo', ENTRY)
);
const output = path.join(repo, 'agentic-org/etopo-relief.tar');

let stat;
try {
  stat = lstatSync(source);
} catch {
  console.error(`ETOPO1 grid not found at ${source}
Set CLANK_ETOPO_GZ or pass --source. Download (377MB) from:
  https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1/data/ice_surface/grid_registered/netcdf/${ENTRY}`);
  process.exit(1);
}
if (!stat.isFile()) {
  console.error(`not a regular file: ${source}`);
  process.exit(1);
}

// ustar header identical to build-newsroom-bundle.mjs: zeroed mtime/uid/gid and
// root/root ownership, so the digest depends only on the content.
const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
function header(name, size, mode) {
  const bytes = Buffer.alloc(512);
  Buffer.from(name).copy(bytes, 0);
  Buffer.from(octal(mode & 0o777, 8)).copy(bytes, 100);
  Buffer.from(octal(0, 8)).copy(bytes, 108);
  Buffer.from(octal(0, 8)).copy(bytes, 116);
  Buffer.from(octal(size, 12)).copy(bytes, 124);
  Buffer.from(octal(0, 12)).copy(bytes, 136);
  bytes.fill(0x20, 148, 156);
  bytes[156] = 0x30;
  Buffer.from('ustar\0').copy(bytes, 257);
  Buffer.from('00').copy(bytes, 263);
  Buffer.from('root').copy(bytes, 265);
  Buffer.from('root').copy(bytes, 297);
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(bytes, 148);
  return bytes;
}

const fd = openSync(output, 'w', 0o644);
const buffer = Buffer.alloc(1024 * 1024);
try {
  writeSync(fd, header(ENTRY, stat.size, 0o644));
  const input = openSync(source, 'r');
  try {
    for (let offset = 0; offset < stat.size; ) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) throw new Error(`short read: ${source}`);
      writeSync(fd, buffer, 0, count);
      offset += count;
    }
  } finally {
    closeSync(input);
  }
  const padding = (512 - (stat.size % 512)) % 512;
  if (padding) writeSync(fd, Buffer.alloc(padding));
  writeSync(fd, Buffer.alloc(1024));
} finally {
  closeSync(fd);
}

const digest = `sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}`;
console.log(`${output}\n${digest}\n${stat.size} content bytes`);
