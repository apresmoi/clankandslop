// Shared, byte-exact tar primitives for the offline newsroom bundles.
//
// build-newsroom-bundle.mjs (all six archives) and repin-private-source.mjs
// (the private archive alone) MUST emit identical bytes for the same private
// commit -- a repin that produced a different tar than the full build would
// hand the agents a checksum no rebuild could ever reproduce. Sharing the
// header/mode/stream code here is what makes that identity structural rather
// than a coincidence two copies have to keep agreeing on.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const privateRoot = 'clankandslop-private/';

// Tar headers must not depend on the machine that built the archive. Git
// tracks exactly one bit of file mode -- executable or not (100755 vs
// 100644) -- so every mode we embed is derived from git's recorded mode
// (never from a live filesystem stat, which varies with local umask and
// checkout tooling) and collapsed to the two canonical values below.
export const normalizeMode = (rawMode) => (rawMode & 0o111) ? 0o755 : 0o644;

export function gitModeMap(cwd, args) {
  const map = new Map();
  const raw = execFileSync('git', args, { cwd, maxBuffer: 1024 * 1024 * 256 }).toString();
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const fields = entry.slice(0, tab).split(' ');
    map.set(entry.slice(tab + 1), { mode: parseInt(fields[0], 8), type: fields.length > 2 && args.includes('ls-tree') ? fields[1] : 'blob' });
  }
  return map;
}

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

export function header(name, size, mode) {
  const bytes = Buffer.alloc(512), raw = Buffer.from(name);
  let prefix = Buffer.alloc(0), base = raw;
  if (raw.length > 100) {
    const split = name.lastIndexOf('/');
    prefix = Buffer.from(name.slice(0, split));
    base = Buffer.from(name.slice(split + 1));
    if (base.length > 100 || prefix.length > 155) throw new Error(`bundle path exceeds ustar bounds: ${name}`);
  }
  base.copy(bytes, 0);
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
  prefix.copy(bytes, 345);
  const sum = bytes.reduce((a, b) => a + b, 0);
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(bytes, 148);
  return bytes;
}

export function buildTar(entries, output, { strip = '', resolveFile, modeFor }) {
  const fd = openSync(output, 'w', 0o644), buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  try {
    for (const name of [...entries].sort()) {
      if (strip && !name.startsWith(strip)) throw new Error(`bundle entry outside strip root: ${name}`);
      const file = resolveFile(name), stat = lstatSync(file);
      writeSync(fd, header(name.slice(strip.length), stat.size, modeFor(name, file)));
      const source = openSync(file, 'r');
      try {
        for (let offset = 0; offset < stat.size;) {
          const count = readSync(source, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!count) throw new Error(`short read: ${name}`);
          writeSync(fd, buffer, 0, count);
          offset += count;
        }
      } finally { closeSync(source); }
      const padding = (512 - (stat.size % 512)) % 512;
      if (padding) writeSync(fd, Buffer.alloc(padding));
      total += stat.size;
    }
    writeSync(fd, Buffer.alloc(1024));
  } finally { closeSync(fd); }
  return { digest: `sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}`, total, count: entries.size };
}

// Resolves the private tree at `commit` into the entry set and recorded modes
// the archive is built from, without touching the private checkout's worktree.
export function privateArchivePlan(privateRepoPath, commit) {
  try {
    execFileSync('git', ['-C', privateRepoPath, 'cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error(`private newsroom archive commit ${commit} not found in ${privateRepoPath}: fetch it before building (pin lives in agentic-org/policies/private-source.json)`);
  }
  const tree = gitModeMap(privateRepoPath, ['ls-tree', '-r', '-z', commit]);
  const modes = new Map(), relative = [];
  for (const [name, entry] of tree) {
    if (entry.mode === 0o120000) continue; // symlink recorded at the pinned commit: excluded, same as the main repo
    if (entry.type !== 'blob') throw new Error(`unsupported private tree entry: ${entry.type} ${name}`);
    modes.set(privateRoot + name, entry.mode);
    relative.push(name);
  }
  if (relative.length === 0) throw new Error('private newsroom archive is empty: fetch clankandslop-private before building');
  return { modes, entries: new Set(relative.map((name) => privateRoot + name)) };
}

// Materializes the pinned tree into a scratch directory and streams it into
// `output`. The caller never sees the scratch directory: it is always removed.
export function buildPrivateArchive({ privateRepoPath, commit, output, modeFor }) {
  const plan = privateArchivePlan(privateRepoPath, commit);
  const extractDir = mkdtempSync(path.join(tmpdir(), 'clank-private-source-'));
  try {
    const archiveBuffer = execFileSync('git', ['-C', privateRepoPath, 'archive', '--format=tar', commit], { maxBuffer: 1024 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', extractDir], { input: archiveBuffer, maxBuffer: 1024 * 1024 * 1024 });
    return {
      ...buildTar(plan.entries, output, {
        strip: privateRoot,
        resolveFile: (name) => path.join(extractDir, name.slice(privateRoot.length)),
        modeFor: modeFor ?? ((name) => normalizeMode(plan.modes.get(name))),
      }),
      modes: plan.modes,
    };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
