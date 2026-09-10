import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repinPublicAssetPins } from './repin-runtime-bundle-pins.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function withCheckout(fn) {
  const repo = mkdtempSync(path.join(tmpdir(), 'asset-pin-repair-'));
  try {
    mkdirSync(path.join(repo, 'agentic-org/agents/pressman'), { recursive: true });
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('repins generated public asset bundles without repinning dependencies or source', () => {
  withCheckout((repo) => {
    const spawnfile = path.join(repo, 'agentic-org/agents/pressman/Spawnfile');
    writeFileSync(spawnfile, [
      `- { id: public-assets-a, kind: bundle, source: ../../newsroom-assets-a.tar, sha256: ${sha('a')}, mount: ./assets-a, mode: readonly }`,
      `- { id: website-deps-a, kind: bundle, source: ../../newsroom-dependencies-a.tar, sha256: ${sha('b')}, mount: ./deps-a, mode: readonly }`,
      `- { id: newsroom-runtime, kind: bundle, source: ../../newsroom-runtime.tar, sha256: ${sha('c')}, mount: ./repos/newsroom, mode: readonly }`,
      '',
    ].join('\n'));

    const changed = repinPublicAssetPins(repo, {
      source: { archive: 'newsroom-runtime.tar', sha256: sha('f') },
      dependencies: [{ archive: 'newsroom-dependencies-a.tar', sha256: sha('e') }],
      assets: [{ archive: 'newsroom-assets-a.tar', sha256: sha('d') }],
    });

    const updated = readFileSync(spawnfile, 'utf8');
    assert.deepEqual(changed, ['agentic-org/agents/pressman/Spawnfile']);
    assert.ok(updated.includes(`newsroom-assets-a.tar, sha256: ${sha('d')}`));
    assert.ok(updated.includes(`newsroom-dependencies-a.tar, sha256: ${sha('b')}`));
    assert.ok(updated.includes(`newsroom-runtime.tar, sha256: ${sha('c')}`));
  });
});

test('bundle build invokes the asset-only repin step', () => {
  const script = readFileSync(new URL('./build-newsroom-bundle.mjs', import.meta.url), 'utf8');
  assert.match(script, /repinPublicAssetPins\(repo,\s*value\)/u);
});
