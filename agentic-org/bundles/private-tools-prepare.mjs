#!/usr/bin/env node
// The `prepare` step of the `newsroom-private-tools` fed volume
// (agentic-org/Spawnfile). Spawnfile runs it inside the staged tree, in the
// pinned Node image on linux/amd64, before the tree is validated, frozen and
// swapped in:
//
//   cwd = the staged tree:  newsroom/{art,build,...} from the private repo,
//                           .feed/fonts   (website/public/fonts, included)
//                           .feed/bundles (this directory, included)
//
// It gives the art server what git does not hold, in the places the art code
// reads them from:
//   - newsroom/art/fonts/<file>: the two artwork fonts art/fonts.mjs names,
//     copied from the public site fonts and checked against their sha256, plus
//     their licences;
//   - newsroom/art/node_modules: `npm ci --omit=dev` from the private
//     art/package-lock.json (glyphcss, @glyphcss/core, sharp for linux-x64).
// Then it removes .feed, so the landed tree holds only the tools.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = process.cwd();
const art = path.join(tree, 'newsroom/art');
const fontsIn = path.join(tree, '.feed/fonts');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const { ART_FONTS } = await import(pathToFileURL(path.join(art, 'fonts.mjs')).href);
mkdirSync(path.join(art, 'fonts'), { recursive: true });
for (const font of ART_FONTS) {
  const source = path.join(fontsIn, font.source);
  if (sha(source) !== font.sha256) throw new Error(`artwork font source drift: ${font.file} (${font.source})`);
  copyFileSync(source, path.join(art, 'fonts', font.file));
}
for (const license of ['jetbrainsmono-OFL.txt', 'intertight-OFL.txt']) {
  const source = path.join(fontsIn, license);
  if (!readFileSync(source, 'utf8').includes('SIL OPEN FONT LICENSE')) throw new Error(`missing font licence: ${license}`);
  copyFileSync(source, path.join(art, 'fonts', license));
}

const home = mkdtempSync(path.join(tmpdir(), 'private-tools-npm-'));
try {
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: art, stdio: 'inherit', timeout: 1_200_000,
    env: { ...process.env, HOME: home, npm_config_cache: path.join(home, 'cache'), npm_config_update_notifier: 'false' }
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}
const lock = JSON.parse(readFileSync(path.join(art, 'package-lock.json'), 'utf8'));
for (const name of ['glyphcss', '@glyphcss/core', 'sharp']) {
  const installed = JSON.parse(readFileSync(path.join(art, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (installed !== lock.packages?.[`node_modules/${name}`]?.version) throw new Error(`art dependency ${name} is ${installed}, the lockfile pins ${lock.packages?.[`node_modules/${name}`]?.version}`);
}
if (!existsSync(path.join(art, 'node_modules/@img', `sharp-linux-${process.arch}`))) throw new Error(`sharp has no linux-${process.arch} binary; the prepare step must run on the runtime's platform`);
// npm's hidden lockfile changes with install time; the landed tree must not.
rmSync(path.join(art, 'node_modules/.package-lock.json'), { force: true });
rmSync(path.join(tree, '.feed'), { recursive: true, force: true });
console.log(`private tools prepared: ${ART_FONTS.length} artwork font(s), art dependencies for linux-${process.arch}`);
