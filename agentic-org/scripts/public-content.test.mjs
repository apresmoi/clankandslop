import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONTENT_IDENTITY_FILE, CONTENT_RESOURCE, PublicContentError, contentIdentityFindings, publicContentRoot, stagePublicSource } from './public-content.mjs';

const REVISION = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const identity = (overrides = {}) => ({
  version: 'spawnfile.volume-feed.v1', resource: CONTENT_RESOURCE, volume: 'clank-newsroom-content', revision: REVISION, tree: `trees/${REVISION}`,
  files: 2, landed_at: '2026-10-09T08:00:00.000Z', source: { kind: 'git', commit: COMMIT, ref: 'origin/main', paths: ['content/editions', 'content/bylines'] }, ...overrides
});

// The layout `spawnfile volume refresh` lands: trees/<revision> keeps the git
// paths, `current` links to it, and the identity record sits at the root.
function fedVolume({ record = identity(), link = `trees/${REVISION}` } = {}) {
  const volume = mkdtempSync(path.join(tmpdir(), 'content-volume-'));
  const tree = path.join(volume, 'trees', REVISION, 'content');
  mkdirSync(path.join(tree, 'editions', '2026-10-08'), { recursive: true });
  writeFileSync(path.join(tree, 'editions', '2026-10-08', 'edition.json'), '{}');
  mkdirSync(path.join(tree, 'bylines'));
  if (link) symlinkSync(link, path.join(volume, 'current'));
  if (record) writeFileSync(path.join(volume, CONTENT_IDENTITY_FILE), JSON.stringify(record));
  return volume;
}

test('the published editions are read through current/content of the fed volume', () => {
  const volume = fedVolume();
  try {
    assert.equal(publicContentRoot({ env: { CLANK_PUBLIC_CONTENT_VOLUME: volume } }), path.join(volume, 'current', 'content'));
    assert.deepEqual(contentIdentityFindings(identity()), []);
    assert.deepEqual(contentIdentityFindings(identity({ tree: `trees/${REVISION}.2` })), [], 'a re-landed generation is still the content volume');
  } finally { rmSync(volume, { recursive: true, force: true }); }
});

test('an unlanded, foreign or malformed volume fails closed', () => {
  for (const [name, options, reason] of [
    ['no identity record', { record: null }, /has no readable/u],
    ['another resource', { record: identity({ resource: 'newsroom-private-tools' }) }, /resource must be/u],
    ['a tree of another revision', { record: identity({ tree: `trees/${'c'.repeat(64)}` }) }, /tree must be/u],
    ['no content paths', { record: identity({ source: { kind: 'git', commit: COMMIT, paths: ['content/editions'] } }) }, /content\/bylines/u],
    ['nothing landed behind current', { link: null }, /does not serve current\/content\/editions/u],
  ]) {
    const volume = fedVolume(options);
    try { assert.throws(() => publicContentRoot({ env: { CLANK_PUBLIC_CONTENT_VOLUME: volume } }), (error) => error instanceof PublicContentError && reason.test(error.message), name); }
    finally { rmSync(volume, { recursive: true, force: true }); }
  }
});

test('the release candidate is laid over from the tree current names, and refuses a link that is not a landed tree', async () => {
  const volume = fedVolume();
  const source = mkdtempSync(path.join(tmpdir(), 'content-source-'));
  const staging = path.join(mkdtempSync(path.join(tmpdir(), 'content-stage-')), 'candidate');
  try {
    mkdirSync(path.join(source, 'content', 'editions'), { recursive: true });
    await stagePublicSource(source, staging, () => true, { env: { CLANK_PUBLIC_CONTENT_VOLUME: volume } });
    assert.deepEqual(readdirSync(path.join(staging, 'content', 'editions')), ['2026-10-08']);
    rmSync(path.join(volume, 'current'));
    symlinkSync(`trees/${REVISION}/content`, path.join(volume, 'current'));
    await assert.rejects(stagePublicSource(source, `${staging}-2`, () => true, { env: { CLANK_PUBLIC_CONTENT_VOLUME: volume } }), /not trees\/<revision>|does not serve/u);
  } finally { for (const dir of [volume, source, path.dirname(staging)]) rmSync(dir, { recursive: true, force: true }); }
});
