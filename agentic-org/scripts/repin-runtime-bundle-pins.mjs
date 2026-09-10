import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const bundleResourcePattern = /(- \{ id: [^,]+, kind: bundle, source: \.\.\/\.\.\/([^,]+), sha256: )sha256:[a-f0-9]{64}/gu;

function assetPins(descriptor) {
  return new Map(
    (descriptor.assets ?? [])
      .filter((entry) => entry?.archive && entry?.sha256)
      .map((entry) => [entry.archive, entry.sha256]),
  );
}

export function repinPublicAssetPins(repoRoot, descriptor) {
  const expected = assetPins(descriptor);
  const agentsRoot = path.join(repoRoot, 'agentic-org/agents');
  const changed = [];
  if (expected.size === 0 || !existsSync(agentsRoot)) return changed;

  for (const agent of readdirSync(agentsRoot).sort()) {
    const spawnfile = path.join(agentsRoot, agent, 'Spawnfile');
    if (!existsSync(spawnfile)) continue;
    const before = readFileSync(spawnfile, 'utf8');
    const after = before.replace(bundleResourcePattern, (match, prefix, archive) => {
      const sha256 = expected.get(archive);
      return sha256 ? `${prefix}${sha256}` : match;
    });
    if (after !== before) {
      writeFileSync(spawnfile, after);
      changed.push(`agentic-org/agents/${agent}/Spawnfile`);
    }
  }

  return changed;
}
