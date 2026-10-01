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
  HEAL_SUSPEND_AFTER, LANDED_VERSION, buildManifest, bumpHeal, compareManifest, corpusLanded, editionCutoff,
  editionSettled, emptyLanded, landedFindings, readLanded, readManifest, writeLanded, writeManifest
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

  // The frozen steady state. The date is pinned to the commit it was serving when
  // its cutoff passed, the branch has moved on, and the newer tree IS landed -- so
  // there is nothing left to do. Without this the refresher would re-land the same
  // tree every two minutes for the rest of the day.
  const frozen = { ...landedFor('a', { frozen: { at: `${EDITION}T08:00:00Z`, cutoff: `${EDITION}T07:00:00Z`, require_by: '09:00' } }) };
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

// THE FREEZE GATE IS A CLOCK, AND THE CLOCK HAS TO BE RIGHT ABOUT BERLIN
// ---------------------------------------------------------------------
// This replaced a gate that counted assignment files inside an agent-writable
// docker volume. The whole value of the replacement is that the answer comes from
// the host alone — which is only true if `editionCutoff` really lands on the Berlin
// wall clock, on both sides of a DST boundary, rather than on a UTC time that
// happens to look right in summer.
test('the cutoff is Berlin wall-clock time on the edition date, on both sides of a DST boundary', () => {
  // CEST, UTC+2: 09:00 Berlin is 07:00Z.
  assert.equal(editionCutoff('2026-09-06', '09:00').toISOString(), '2026-09-06T07:00:00.000Z');
  // CET, UTC+1: the same wall-clock cutoff in January is 08:00Z. A naive
  // implementation gets one of these two wrong by an hour, which is an hour of a
  // settled edition still following the branch.
  assert.equal(editionCutoff('2026-01-14', '09:00').toISOString(), '2026-01-14T08:00:00.000Z');
  // The day the clocks go forward, after the skipped hour.
  assert.equal(editionCutoff('2026-03-29', '09:00').toISOString(), '2026-03-29T07:00:00.000Z');
  // And the day they go back.
  assert.equal(editionCutoff('2026-10-25', '09:00').toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal(editionCutoff('2026-09-06', '00:00').toISOString(), '2026-09-05T22:00:00.000Z');
  assert.throws(() => editionCutoff('yesterday', '09:00'), CorpusError);
  assert.throws(() => editionCutoff('2026-09-06', '9:00'), CorpusError);

  // The decision itself: one minute either side of the instant above.
  assert.equal(editionSettled(EDITION, { now: new Date('2026-09-06T06:59:59Z'), requireBy: '09:00' }), false);
  assert.equal(editionSettled(EDITION, { now: new Date('2026-09-06T07:00:00Z'), requireBy: '09:00' }), true);
  // A past date is settled whatever time it is now, and a future one never is.
  assert.equal(editionSettled('2026-09-05', { now: new Date('2026-09-06T06:00:00Z'), requireBy: '09:00' }), true);
  assert.equal(editionSettled('2026-09-07', { now: new Date('2026-09-06T23:00:00Z'), requireBy: '09:00' }), false);
  // And --require-by moves it, because there is only ONE cutoff concept.
  assert.equal(editionSettled(EDITION, { now: new Date('2026-09-06T06:00:00Z'), requireBy: '07:00' }), true);
});

test('a freeze the record cannot justify is not publishable, and the heal counter is the host’s own', () => {
  // A `frozen` field that cannot say when it was taken and which cutoff justified it
  // is a freeze nobody can audit — which is how the agent-answerable one survived.
  const auditable = { at: `${EDITION}T07:00:00Z`, cutoff: `${EDITION}T07:00:00Z`, require_by: '09:00' };
  assert.deepEqual(landedFindings(landedFor('a', { frozen: auditable })), []);
  for (const bad of [{}, { ...auditable, at: '' }, { ...auditable, cutoff: undefined }, { ...auditable, require_by: '9:00' }, 'frozen', []]) {
    assert.ok(landedFindings(landedFor('a', { frozen: bad })).length, `${JSON.stringify(bad)} must not be publishable as a freeze`);
  }

  const tree = `trees/${commitOf('a')}`;
  const first = bumpHeal(undefined, tree, { at: 'T1' });
  assert.deepEqual(first[tree], { cycles: 1, since: 'T1', last: 'T1' });
  const third = bumpHeal(bumpHeal(first, tree, { at: 'T2' }), tree, { at: 'T3' });
  assert.deepEqual(third[tree], { cycles: 3, since: 'T1', last: 'T3' }, 'the count is consecutive cycles and `since` is when the loop started');
  assert.equal(third[tree].cycles >= HEAL_SUSPEND_AFTER, true, 'three relands of one tree is the shipped ceiling');
  // A suspension stamp survives further counting, so the page is raised once.
  const stamped = { ...third, [tree]: { ...third[tree], suspended: 'T4' } };
  assert.equal(bumpHeal(stamped, tree, { at: 'T5' })[tree].suspended, 'T4');

  assert.deepEqual(landedFindings({ ...landedFor('a'), heals: third }), []);
  assert.deepEqual(landedFindings({ ...landedFor('a'), heals: {} }), []);
  for (const bad of [{ 'not-a-tree': { cycles: 1, since: 'T1' } }, { [tree]: { cycles: 0, since: 'T1' } }, { [tree]: { cycles: 1 } }, { [tree]: 1 }, []]) {
    assert.ok(landedFindings({ ...landedFor('a'), heals: bad }).length, `${JSON.stringify(bad)} must not be publishable as a heal count`);
  }
});
