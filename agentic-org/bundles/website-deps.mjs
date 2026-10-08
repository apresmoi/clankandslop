#!/usr/bin/env node
// Writes the website dependencies bundle (Pressman's ./deps) into the output
// directory Spawnfile hands a `generated` bundle. It runs INSIDE the pinned
// Node image Spawnfile starts on the target platform, with the repository
// mounted as the working directory:
//
//   node agentic-org/bundles/website-deps.mjs <builder-image> <output>
//
// The output is the layout the private release adapter reads from every
// dependency root: website/node_modules/** and website/dependency-provenance.json
// (it copies the provenance file and re-asserts it before `astro build`). A
// plain `dependencies` bundle archives node_modules alone, so it cannot carry
// that file; this is the same install with the provenance written beside it.
//
// The provenance rules are the private repo's newsroom/build/dependencies.mjs,
// restated here because this runs in a bare image with only the public tree
// mounted. The release adapter compares field for field, so any drift fails
// the release closed rather than shipping unverified dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [builderImage, output] = process.argv.slice(2);
if (!/^.+@sha256:[a-f0-9]{64}$/u.test(builderImage ?? '') || !output) throw new Error('usage: website-deps.mjs <image@sha256:digest> <output>');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const allowed = (list, value) => !list || (!list.includes(`!${value}`) && (list.every((item) => item.startsWith('!')) || list.includes(value)));

const work = mkdtempSync(path.join(tmpdir(), 'website-deps-'));
try {
  const website = path.join(work, 'website');
  mkdirSync(website);
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(path.join('website', name), path.join(website, name));
  const env = { ...process.env, HOME: work, npm_config_cache: path.join(work, '.npm'), npm_config_update_notifier: 'false' };
  execFileSync('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: website, env, stdio: 'inherit', timeout: 600_000 });

  const lockBytes = readFileSync(path.join(website, 'package-lock.json'));
  const lock = JSON.parse(lockBytes), declared = JSON.parse(readFileSync(path.join(website, 'package.json'), 'utf8'));
  if (lock.lockfileVersion < 2 || !lock.packages?.['']) throw new Error('A modern npm lockfile is required');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (JSON.stringify(declared[field] ?? {}) !== JSON.stringify(lock.packages[''][field] ?? {})) throw new Error(`package.json ${field} differs from lock root`);
  }
  const versions = {};
  for (const [relative, item] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!relative) continue;
    if (!relative.startsWith('node_modules/') || relative.includes('..') || item.link) throw new Error(`Unsupported lock package ${relative}`);
    const applicable = allowed(item.os, process.platform) && allowed(item.cpu, process.arch) && allowed(item.libc, 'glibc');
    let actual;
    try { actual = JSON.parse(readFileSync(path.join(website, relative, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && item.optional) continue; throw new Error(`Required installed package is missing: ${relative}`, { cause: error }); }
    if (!applicable) throw new Error(`Installed package ${relative} targets another platform`);
    if (actual.version !== item.version) throw new Error(`Dependency drift: ${relative} is ${actual.version}; lock requires ${item.version}`);
    versions[relative] = actual.version;
  }
  const provenance = { version: 'clank.website-dependencies.v1', lock_digest: hash(lockBytes), platform: process.platform, arch: process.arch, versions, node_major: Number(process.versions.node.split('.')[0]), node_version: process.version, builder_image: builderImage };

  execFileSync(process.execPath, ['--input-type=module', '-e', "import {transformSync} from 'esbuild'; import sharp from 'sharp'; if(!transformSync('const x=1').code)throw Error('esbuild empty'); const x=await sharp({create:{width:2,height:2,channels:3,background:'#000'}}).png().toBuffer(); if(x.length<20)throw Error('sharp empty'); console.log('NATIVE_DEPENDENCIES_OK');"], { cwd: website, env, stdio: 'inherit' });

  // Regular files only, as the archives this replaces held: npm's `.bin`
  // symlinks and its hidden lockfile never reached a dependency root.
  let count = 0;
  const copy = (relative) => {
    for (const name of readdirSync(path.join(website, relative)).sort()) {
      const child = path.join(relative, name), info = lstatSync(path.join(website, child));
      if (relative === 'node_modules' && name === '.package-lock.json') continue;
      if (info.isDirectory()) copy(child);
      else if (info.isFile()) {
        const target = path.join(output, 'website', child);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(website, child), target);
        chmodSync(target, info.mode & 0o111 ? 0o755 : 0o644);
        count += 1;
      } else if (!info.isSymbolicLink()) throw new Error(`Unsupported dependency node: ${child}`);
    }
  };
  copy('node_modules');
  writeFileSync(path.join(output, 'website', 'dependency-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`website dependencies: ${count} files, node ${process.version}, ${process.platform}/${process.arch}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
