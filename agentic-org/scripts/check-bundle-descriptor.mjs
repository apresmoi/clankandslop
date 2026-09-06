#!/usr/bin/env node
// Fails when agentic-org/newsroom-runtime-bundle.json describes a different
// tree than the one committed.
//
// This is the third occurrence of the same defect: the descriptor is written
// by a build nobody is obliged to run, and organization.test.mjs only checks
// that the Spawnfiles agree with the descriptor — never that either agrees
// with the tree. Two files can be perfectly consistent with each other and
// both wrong, which is exactly what shipped: a branch adding a module the MCP
// entrypoint imports at load, carrying a pin from before that module existed.
//
// Only the source archive is checked, and that is deliberate rather than
// partial. It is the one archive that is a pure function of the git tree, so
// a mismatch is always drift. The dependency archives come from `npm ci`
// output whose file set is platform-specific, and the private archive needs
// a checkout of clankandslop-private — neither is available to CI, and a
// check that cannot run is not a check. The source archive is also the one
// that carries every file an agent's runtime actually loads.
//
//   node agentic-org/scripts/check-bundle-descriptor.mjs
//   node agentic-org/scripts/check-bundle-descriptor.mjs --repin-source
//
// `--repin-source` rewrites the descriptor's source block and the twelve
// Spawnfile pins from a fresh measurement, and touches nothing else. It exists
// because the full `npm run org:bundle` needs a clankandslop-private checkout
// and website/node_modules, and the commonest way to trip this check is to
// change one tracked file on a machine that has neither. The dependency,
// asset and private blocks are left exactly as committed: their digests come
// from the host that builds those archives, and rewriting them here would pin
// pressman to tars no rebuild could reproduce.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { measureSourceArchive, sourceDescriptorFindings } from './source-archive.mjs';

const repo = path.resolve(import.meta.dirname, '../..');

export function bundleDescriptorFindings(repoRoot = repo) {
  const descriptorPath = path.join(repoRoot, 'agentic-org/newsroom-runtime-bundle.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const findings = sourceDescriptorFindings(descriptor, measureSourceArchive(repoRoot));
  // The pin is only worth anything if the declarations carry it. Checked here
  // as well as in organization.test.mjs so one command answers the whole
  // question: does the tree, the descriptor, and every workspace agree?
  const agentsDir = path.join(repoRoot, 'agentic-org/agents');
  for (const agent of readdirSync(agentsDir).sort()) {
    const spawnfile = path.join(agentsDir, agent, 'Spawnfile');
    let source;
    try { source = readFileSync(spawnfile, 'utf8'); } catch { continue; }
    if (!source.includes(`sha256: ${descriptor.source.sha256}`))
      findings.push(`agents/${agent}/Spawnfile does not pin the descriptor source digest ${descriptor.source.sha256}`);
  }
  return findings;
}

export function repinSource(repoRoot = repo) {
  const descriptorPath = path.join(repoRoot, 'agentic-org/newsroom-runtime-bundle.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const measured = measureSourceArchive(repoRoot);
  const previous = descriptor.source.sha256;
  descriptor.source = { ...descriptor.source, sha256: measured.digest, file_count: measured.count, content_bytes: measured.total };
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const agentsDir = path.join(repoRoot, 'agentic-org/agents');
  const repinned = [];
  for (const agent of readdirSync(agentsDir).sort()) {
    const spawnfile = path.join(agentsDir, agent, 'Spawnfile');
    let source;
    try { source = readFileSync(spawnfile, 'utf8'); } catch { continue; }
    if (!source.includes(previous)) continue;
    writeFileSync(spawnfile, source.replaceAll(previous, measured.digest));
    repinned.push(agent);
  }
  return { previous, digest: measured.digest, file_count: measured.count, content_bytes: measured.total, repinned };
}

function main() {
  if (process.argv.slice(2).includes('--repin-source')) {
    const result = repinSource();
    console.log(`source ${result.previous} -> ${result.digest}`);
    console.log(`${result.file_count} files, ${result.content_bytes} bytes; repinned ${result.repinned.length} Spawnfile(s): ${result.repinned.join(', ')}`);
    return;
  }
  const findings = bundleDescriptorFindings();
  if (findings.length > 0) {
    console.error(`bundle descriptor is stale — ${findings.length} finding(s):\n`);
    for (const finding of findings) console.error(`  ✗ ${finding}`);
    console.error('\nFix it with `node agentic-org/scripts/check-bundle-descriptor.mjs --repin-source`, which needs');
    console.error('nothing but this checkout, and commit the descriptor and every Spawnfile it repins. A full');
    console.error('`npm run org:bundle` additionally rebuilds the dependency, asset and private archives, and needs');
    console.error('a clankandslop-private checkout and website/node_modules to do it.');
    process.exitCode = 1;
    return;
  }
  console.log('bundle descriptor OK — the source archive pin matches a fresh build of the tracked tree.');
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
