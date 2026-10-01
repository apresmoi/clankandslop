// The host record's own rules, where the end-to-end tests cannot reach the edges:
// what makes a record unusable, how a frozen edition reads as a stable no-op, and
// what the cheap tamper sweep can and cannot settle on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusError } from './corpus-contract.mjs';
import {
  LANDED_VERSION, buildManifest, commissionedEdition, compareManifest, corpusLanded,
  emptyLanded, landedFindings, readLanded, readManifest, writeLanded, writeManifest
} from './corpus-landed.mjs';

const EDITION = '2026-09-06';
const commitOf = (seed) => seed.repeat(40).slice(0, 40);
const landedFor = (seed, extra = {}) => ({
  version: LANDED_VERSION,
  editions: { [EDITION]: { commit: commitOf(seed), tree: `trees/${commitOf(seed)}`, landed_at: `${EDITION}T07:00:00Z`, ...extra } },
  trees: [`trees/${commitOf(seed)}`], identity: null
});
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-corpus-landed-'));
  return { root, landed: join(root, 'landed.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('a record whose editions and trees disagree is unusable, because the sweep reads both', () => {
  assert.deepEqual(landedFindings(landedFor('a')), []);
  assert.deepEqual(landedFindings(emptyLanded()), []);
  // An edition serving a tree the tree list does not carry is how a sweep ends up
  // taking aim at something twelve reporters are reading.
  const orphaned = { ...landedFor('a'), trees: [`trees/${commitOf('b')}`] };
  assert.ok(landedFindings(orphaned).some((text) => /is absent from trees\[\]/u.test(text)), landedFindings(orphaned).join('; '));
  assert.ok(landedFindings({ ...landedFor('a'), version: 'clank.corpus-landed.v0' }).length);
  assert.ok(landedFindings({ ...landedFor('a'), trees: ['trees/short'] }).length);
  assert.ok(landedFindings({ version: LANDED_VERSION, editions: { tomorrow: {} }, trees: [] }).length);
  assert.ok(landedFindings(landedFor('a', { tree: 'trees/elsewhere' })).length);
  assert.ok(landedFindings(null).length);
  assert.ok(landedFindings([]).length);
});

test('the record is written atomically, 0600, and refuses to publish a shape the next run cannot trust', () => {
  const s = scratch();
  try {
    writeLanded(s.landed, landedFor('a'));
    assert.deepEqual(readLanded(s.landed).record, landedFor('a'));
    assert.throws(() => writeLanded(s.landed, { ...landedFor('a'), trees: [] }), (error) => error instanceof CorpusError && /refusing to write an invalid landed\.json/u.test(error.message));
    assert.deepEqual(readLanded(s.landed).record, landedFor('a'), 'a refused write must leave the published record untouched');

    // Both failures degrade to "nothing landed" rather than stopping the refresher:
    // a corpus that must be re-landed is recoverable, a host that will not run is not.
    assert.deepEqual(readLanded(join(s.root, 'nowhere.json')), { record: null, reason: null, missing: true });
    writeFileSync(s.landed, '{ truncated\n');
    const broken = readLanded(s.landed);
    assert.equal(broken.record, null);
    assert.match(broken.reason, /is not parseable JSON/u);
  } finally { s.cleanup(); }
});

test('a frozen edition reads as current once the newer tree is landed, and as stale until then', () => {
  const stale = corpusLanded(landedFor('a'), { commit: commitOf('b'), edition: EDITION });
  assert.equal(stale.current, false);
  assert.ok(stale.reason.includes(commitOf('a').slice(0, 7)) && stale.reason.includes(commitOf('b').slice(0, 7)), stale.reason);
  assert.equal(corpusLanded(landedFor('a'), { commit: commitOf('a'), edition: EDITION }).current, true);
  assert.equal(corpusLanded(null, { commit: commitOf('a'), edition: EDITION }).current, false);
  assert.match(corpusLanded(emptyLanded(), { commit: commitOf('a'), edition: EDITION }).reason, /never landed a corpus for/u);

  // FIX 3's steady state. The edition is pinned to the commit its receipts name,
  // the branch has moved on, and the newer tree IS landed -- so there is nothing
  // left to do. Without this the refresher would re-land the same tree every two
  // minutes for the rest of the day.
  const frozen = { ...landedFor('a', { frozen: { at: `${EDITION}T08:00:00Z`, assignments: 1, commits: [commitOf('a')] } }) };
  frozen.trees = [`trees/${commitOf('a')}`, `trees/${commitOf('b')}`];
  const settled = corpusLanded(frozen, { commit: commitOf('b'), edition: EDITION });
  assert.deepEqual([settled.current, Boolean(settled.frozen)], [true, true]);
  // But a THIRD commit is work again: it has not been landed yet.
  const pending = corpusLanded(frozen, { commit: commitOf('c'), edition: EDITION });
  assert.equal(pending.current, false);
  assert.match(pending.reason, /is frozen at .* and .* is not landed yet/u);
});

test('the cheap manifest sweep settles names, sizes, modes and kinds, and defers only a same-size rewrite', () => {
  const s = scratch();
  try {
    const tree = join(s.root, 'tree');
    mkdirSync(join(tree, EDITION, 'stories'), { recursive: true });
    const story = join(tree, EDITION, 'stories', 's-11111111.md');
    writeFileSync(story, '# s-11111111\n');
    writeFileSync(join(tree, EDITION, 'index'), 'rows\n');
    const manifest = buildManifest(tree, commitOf('a'));
    assert.equal(manifest.files, 4, 'the walk must cover directories and files, not just the top level');
    assert.deepEqual(compareManifest(tree, manifest), { missing: [], extra: [], changed: [], touched: [] });

    writeManifest(s.landed, manifest);
    assert.deepEqual(readManifest(s.landed, commitOf('a')).entries, manifest.entries);
    assert.equal(readManifest(s.landed, commitOf('b')), null);

    // A same-SIZE rewrite is the one edit the stat sweep cannot settle: it shows up
    // as a moved mtime and nothing else, which is why `touched` is re-hashed
    // against git rather than reported as drift on its own.
    writeFileSync(story, 'xxxxxxxxxxxxx');
    assert.deepEqual(compareManifest(tree, manifest), { missing: [], extra: [], changed: [], touched: [`${EDITION}/stories/s-11111111.md`] });

    // Everything else it settles alone, with no reads at all.
    writeFileSync(story, '# s-11111111 and more\n');
    assert.deepEqual(compareManifest(tree, manifest).changed, [`${EDITION}/stories/s-11111111.md`]);
    writeFileSync(join(tree, EDITION, 'stories', 's-99999999.md'), 'planted\n');
    assert.deepEqual(compareManifest(tree, manifest).extra, [`${EDITION}/stories/s-99999999.md`]);
    rmSync(join(tree, EDITION, 'index'));
    assert.deepEqual(compareManifest(tree, manifest).missing, [`${EDITION}/index`]);
    // Including a mode an owner restored on a file the host froze.
    const clean = buildManifest(tree, commitOf('a'));
    assert.equal(clean.entries[`${EDITION}/stories/s-11111111.md`][3], 0o644, 'the fixture must start from a mode the chmod below actually changes');
    chmodSync(story, 0o400);
    assert.deepEqual(compareManifest(tree, clean).changed, [`${EDITION}/stories/s-11111111.md`]);
    // And an unchanged file whose mtime never moved is never re-read.
    utimesSync(join(tree, EDITION, 'stories'), new Date(0), new Date(0));
    assert.deepEqual(compareManifest(tree, buildManifest(tree, commitOf('a'))), { missing: [], extra: [], changed: [], touched: [] });
  } finally { s.cleanup(); }
});

test('an edition is commissioned the moment one assignment record exists, and an absent state root is not an error', () => {
  const s = scratch();
  try {
    assert.deepEqual(commissionedEdition(join(s.root, 'nowhere'), EDITION), { count: 0, commits: [] }, 'a fresh host has no edition state and must still refresh');
    const directory = join(s.root, 'editions', EDITION, 'assignments');
    mkdirSync(directory, { recursive: true });
    assert.deepEqual(commissionedEdition(s.root, EDITION), { count: 0, commits: [] }, 'an empty assignments directory is not a commissioned edition');

    writeFileSync(join(directory, 'aaaaaaaa.json'), `${JSON.stringify({ edition: EDITION, corpus: { commit: commitOf('a') } })}\n`);
    assert.deepEqual(commissionedEdition(s.root, EDITION), { count: 1, commits: [commitOf('a')] });
    // A record that converged into <id>/<revision>.json counts too: a commissioned
    // edition must not read as uncommissioned because of a layout detail.
    mkdirSync(join(directory, 'bbbbbbbb'), { recursive: true });
    writeFileSync(join(directory, 'bbbbbbbb', '1.json'), `${JSON.stringify({ edition: EDITION, corpus: { commit: commitOf('b') } })}\n`);
    assert.deepEqual(commissionedEdition(s.root, EDITION), { count: 2, commits: [commitOf('a'), commitOf('b')].sort() });
    // And an unreadable receipt still means the lineup was recorded.
    writeFileSync(join(directory, 'cccccccc.json'), 'truncated\n');
    assert.equal(commissionedEdition(s.root, EDITION).count, 3);
    assert.deepEqual(commissionedEdition(s.root, '2026-09-07'), { count: 0, commits: [] });
  } finally { s.cleanup(); }
});
