import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS_IDENTITY_VERSION, CORPUS_TREES_DIR, CorpusError, REPORTERS, corpusIdentityFindings, corpusLinkFindings,
  corpusTreePath, isCorpusCommit, isCorpusTreePath, verifyCorpusTree
} from './corpus-contract.mjs';
// The corpus writers live in the refresher's fixture module; a third copy of
// "how a desk index is spelled" is exactly how two checks drift apart.
import { EDITION, STORIES, writeCorpus, writeIndex } from './corpus-refresh.fixture.mjs';

const COMMIT = 'c'.repeat(40);
const valid = (overrides = {}) => ({
  version: CORPUS_IDENTITY_VERSION, commit: COMMIT, ref: `edition/${EDITION}`, edition: EDITION,
  fetched_at: `${EDITION}T07:12:04Z`, tree: `trees/${COMMIT}`, editions_present: [EDITION], source_count: 2, ...overrides
});

test('a complete identity record has no findings', () => {
  assert.deepEqual(corpusIdentityFindings(valid()), []);
  assert.deepEqual(corpusIdentityFindings(valid(), { edition: EDITION }), []);
  // Millisecond and offset forms are both legal ISO instants: the writer strips
  // ms, but a reader must not refuse a record because of that choice.
  assert.deepEqual(corpusIdentityFindings(valid({ fetched_at: `${EDITION}T07:12:04.918Z` })), []);
  assert.deepEqual(corpusIdentityFindings(valid({ fetched_at: `${EDITION}T09:12:04+02:00` })), []);
});

test('anything that is not a JSON object is rejected outright', () => {
  for (const value of [null, undefined, 'CORPUS.json', 7, [valid()]]) assert.equal(corpusIdentityFindings(value).length, 1, `${JSON.stringify(value)} was accepted`);
});

test('every field the container depends on is checked', () => {
  const finding = (overrides) => corpusIdentityFindings(valid(overrides)).join(' | ');
  assert.match(finding({ version: 'clank.research-corpus.identity.v2' }), /version must be clank\.research-corpus\.identity\.v1/u);
  assert.match(finding({ version: undefined }), /version must be/u);
  // A short sha, an uppercase sha and a non-string are each a commit nobody can
  // resolve back to a producer's branch.
  assert.match(finding({ commit: COMMIT.slice(0, 12) }), /commit must be a 40-character lowercase hex sha/u);
  assert.match(finding({ commit: COMMIT.toUpperCase() }), /commit must be a 40-character lowercase hex sha/u);
  assert.match(finding({ commit: 40 }), /commit must be a 40-character lowercase hex sha/u);
  assert.match(finding({ ref: '' }), /ref must name the branch/u);
  assert.match(finding({ ref: '   ' }), /ref must name the branch/u);
  assert.match(finding({ ref: null }), /ref must name the branch/u);
  assert.match(finding({ edition: '6 September 2026' }), /edition must be YYYY-MM-DD/u);
  assert.match(finding({ edition: undefined }), /edition must be YYYY-MM-DD/u);
  assert.match(finding({ fetched_at: 'Sun Sep 06 2026' }), /fetched_at must be an ISO instant/u);
  assert.match(finding({ fetched_at: '2026-13-45T99:99:99Z' }), /fetched_at must be an ISO instant/u);
  assert.match(finding({ fetched_at: 1757136724 }), /fetched_at must be an ISO instant/u);
  assert.match(finding({ tree: COMMIT }), /tree must be trees\/<commit>/u);
  assert.match(finding({ tree: `trees/${COMMIT}/${EDITION}` }), /tree must be trees\/<commit>/u);
  assert.match(finding({ tree: undefined }), /tree must be trees\/<commit>/u);
  // A record naming one commit while its tree holds another is how a reader
  // ends up proving the provenance of research it never read.
  assert.match(finding({ tree: `trees/${'d'.repeat(40)}` }), /tree must be trees\/<commit>/u);
  assert.match(finding({ editions_present: ['2026-09-05'] }), /editions_present must list the edition/u);
  assert.match(finding({ editions_present: EDITION }), /editions_present must list the edition/u);
  assert.match(finding({ source_count: 0 }), /source_count must be a positive integer/u);
  assert.match(finding({ source_count: '2' }), /source_count must be a positive integer/u);
});

test('a corpus from the wrong day names BOTH dates, because either one alone is unactionable', () => {
  const findings = corpusIdentityFindings(valid({ edition: '2026-09-05', editions_present: ['2026-09-05'] }), { edition: EDITION });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /2026-09-05/u);
  assert.match(findings[0], /2026-09-06/u);
  // Without a target edition the record is simply a valid record for some day.
  assert.deepEqual(corpusIdentityFindings(valid({ edition: '2026-09-05', editions_present: ['2026-09-05'] })), []);
});

test('findings accumulate so one read tells the whole story', () => {
  const findings = corpusIdentityFindings({ version: 'nope', commit: 'xyz', ref: '', edition: 'soon', fetched_at: 'now', tree: 'elsewhere' });
  assert.equal(findings.length, 8);
});

const tree = (build) => {
  const root = mkdtempSync(join(tmpdir(), 'clank-corpus-tree-'));
  writeCorpus(root, EDITION, 'a corpus');
  build?.(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('a desk with nothing routed to it is published; a corpus that routed nothing to anyone is not', () => {
  // The fixture already ships one empty desk, which is what a real edition
  // looks like. Refusing over it would cost the day for a quiet beat.
  assert.deepEqual(STORIES.tinkerton, [], 'this test is only meaningful while a desk in the fixture is empty');
  const quiet = tree();
  try {
    const report = verifyCorpusTree(quiet.root, EDITION);
    assert.deepEqual(report.map((entry) => entry.agent), REPORTERS);
    assert.equal(report.find((entry) => entry.agent === 'tinkerton').rows, 0);
    assert.ok(report.reduce((total, entry) => total + entry.rows, 0) > 0);
  } finally { quiet.cleanup(); }

  // Every desk empty is a broken split or an empty capture, not an editorial choice.
  const silent = tree((root) => { for (const agent of REPORTERS) writeIndex(root, EDITION, agent, []); });
  try {
    assert.throws(() => verifyCorpusTree(silent.root, EDITION), (error) => error instanceof CorpusError
      && error.message === `corpus for ${EDITION} routed no stories to any desk`);
  } finally { silent.cleanup(); }
});

test('a missing index, an unparsable row and a story file nobody wrote are all refusals', () => {
  const absent = tree((root) => rmSync(join(root, EDITION, 'desks', 'graves.index')));
  try {
    assert.throws(() => verifyCorpusTree(absent.root, EDITION), (error) => error instanceof CorpusError && /missing 2026-09-06\/desks\/graves\.index/u.test(error.message));
  } finally { absent.cleanup(); }

  const dangling = tree((root) => writeIndex(root, EDITION, 'graves', ['s-deadbeef']));
  try {
    assert.throws(() => verifyCorpusTree(dangling.root, EDITION), (error) => error instanceof CorpusError && /DEFECT/u.test(error.message) && error.message.includes('s-deadbeef'));
  } finally { dangling.cleanup(); }

  const garbled = tree((root) => writeFileSync(join(root, EDITION, 'desks', 'vesta.index'), 'not-a-story-id   some text\n'));
  try {
    assert.throws(() => verifyCorpusTree(garbled.root, EDITION), (error) => error instanceof CorpusError && /not a story id/u.test(error.message));
  } finally { garbled.cleanup(); }
});

test('the corpus check has ONE behaviour: no argument can soften or harden it', () => {
  // The host writer and the retired build path drifted apart once already,
  // through a flag that let one of them opt out of a check. Nothing a caller
  // passes may change the verdict -- an arity assertion cannot see this, because
  // a parameter with a default does not count towards Function.length.
  const quiet = tree();
  try {
    for (const extra of [undefined, {}, { requireRows: true }, { requireRows: false }, { strict: true }, { strict: false }])
      assert.equal(verifyCorpusTree(quiet.root, EDITION, extra).length, REPORTERS.length, `a third argument changed the verdict: ${JSON.stringify(extra)}`);
  } finally { quiet.cleanup(); }
  assert.doesNotMatch(readFileSync(new URL('./corpus-contract.mjs', import.meta.url), 'utf8'), /requireRows/u, 'the two-behaviour flag must not come back, under its old name or any other');
});

// ---------------------------------------------------------------------------
// The dated link, which is the only path any reader actually opens.
// corpusIdentityFindings validates a CLAIM; this is what binds the claim to the
// bytes. Both sides of the agent boundary call it: the host refresher so it
// knows whether a refresh is needed, the newsroom tools so they never bind a
// commit the desks are not reading.
// ---------------------------------------------------------------------------
const OTHER = 'd'.repeat(40);
const linkFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-corpus-link-'));
  for (const commit of [COMMIT, OTHER]) writeCorpus(join(root, 'trees', commit), EDITION, `research at ${commit}`);
  const link = join(root, EDITION);
  const pointAt = (commit) => { rmSync(link, { recursive: true, force: true }); symlinkSync(join('trees', commit, EDITION), link); };
  pointAt(COMMIT);
  return { root, link, pointAt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('a dated link that resolves into another commit is not a bound corpus, however valid the record is', () => {
  const fixture = linkFixture();
  try {
    assert.deepEqual(corpusLinkFindings(fixture.root, EDITION, COMMIT), []);
    // The exploit, exactly: the link moves and the record does not. Both trees
    // are complete, valid corpora for this edition, so every other check in the
    // contract passes -- and the record would prove the provenance of research
    // nobody read.
    fixture.pointAt(OTHER);
    const moved = corpusLinkFindings(fixture.root, EDITION, COMMIT);
    assert.equal(moved.length, 1);
    assert.match(moved[0], new RegExp(`outside trees/${COMMIT}/`, 'u'));
    assert.ok(moved[0].includes(OTHER), 'the finding must say where the link actually goes');
    assert.deepEqual(corpusLinkFindings(fixture.root, EDITION, OTHER), [], 'and the same volume IS bound to the commit it really points at');
  } finally { fixture.cleanup(); }
});

test('every way a link can fail to bind fails closed', () => {
  const fixture = linkFixture();
  try {
    rmSync(fixture.link);
    mkdirSync(fixture.link, { recursive: true });
    writeCorpus(fixture.link, EDITION, 'a corpus somebody dropped in by hand');
    assert.match(corpusLinkFindings(fixture.root, EDITION, COMMIT)[0], /is a real directory on the mount/u, 'real corpus data in the link\'s place is not a binding');
    rmSync(fixture.link, { recursive: true, force: true });
    assert.match(corpusLinkFindings(fixture.root, EDITION, COMMIT)[0], /is not on the corpus mount at all/u);
    symlinkSync(join('trees', 'e'.repeat(40), EDITION), fixture.link);
    assert.match(corpusLinkFindings(fixture.root, EDITION, COMMIT)[0], /dangling symlink/u);
    fixture.pointAt(COMMIT);
    rmSync(join(fixture.root, 'trees', OTHER), { recursive: true, force: true });
    assert.match(corpusLinkFindings(fixture.root, EDITION, OTHER)[0], /absent from the mount/u);
    // Refused before any path is built, so no caller can walk out of the mount
    // through the commit or the date it asks about.
    for (const commit of [undefined, '', '../../../etc', COMMIT.toUpperCase(), COMMIT.slice(0, 12)])
      assert.match(corpusLinkFindings(fixture.root, EDITION, commit)[0], /commit must be a 40-character lowercase hex sha/u, `commit ${JSON.stringify(commit)} was accepted`);
    for (const edition of [undefined, '', '..', '2026-9-6', `${EDITION}/../..`])
      assert.match(corpusLinkFindings(fixture.root, edition, COMMIT)[0], /edition must be YYYY-MM-DD/u, `edition ${JSON.stringify(edition)} was accepted`);
  } finally { fixture.cleanup(); }
});

// ONE RULE, ONE SPELLING
// ---------------------
// `trees/<40 hex>` was restated privately in this contract, in the host's record,
// in the host-side volume writer and in the edition publisher -- four copies of
// one rule, because this module documented itself as the home for shared corpus
// rules and exported none of them. These two tests are what stops the fifth.
test('the commit and tree shape are exported from the contract, and refuse everything that is not one', () => {
  const commit = 'a'.repeat(40);
  assert.equal(CORPUS_TREES_DIR, 'trees');
  assert.equal(corpusTreePath(commit), `trees/${commit}`);
  assert.equal(isCorpusCommit(commit), true);
  assert.equal(isCorpusTreePath(corpusTreePath(commit)), true);
  // Every shape a record, a flag or a planted name can carry instead of a commit.
  for (const value of [undefined, null, '', 42, {}, commit.toUpperCase(), commit.slice(0, 39), `${commit}a`, `${commit}\n`, '../../etc', ' '.repeat(40)]) {
    assert.equal(isCorpusCommit(value), false, `isCorpusCommit accepted ${JSON.stringify(value)}`);
    assert.throws(() => corpusTreePath(value), CorpusError, `corpusTreePath built a path from ${JSON.stringify(value)}`);
  }
  // And the tree path validator is anchored on both ends, so nothing that merely
  // CONTAINS a tree path passes for one.
  for (const value of [undefined, null, '', commit, `trees/${commit}/`, `trees/${commit}/${EDITION}`, `/trees/${commit}`, `trees//${commit}`, `TREES/${commit}`, `trees/${commit.toUpperCase()}`, `trees/../${commit}`])
    assert.equal(isCorpusTreePath(value), false, `isCorpusTreePath accepted ${JSON.stringify(value)}`);
});

// The scan. A private copy of the rule is a correctness defect that no behavioural
// test can see -- both copies agree on the day they are written -- so the defect
// has to be caught as what it is: a second spelling in the source text.
test('no corpus module re-spells the commit or tree-path rule privately', () => {
  // Every module that is allowed to know the shape. corpus-contract.mjs is the
  // home and is expected to hold exactly one declaration of the pattern.
  const owned = ['corpus-contract.mjs', 'corpus-verify.mjs', 'corpus-volume.mjs', 'corpus-swap.mjs'];
  const forbidden = [
    // The anchored 40-hex commit rule, in any of the spellings it has appeared in.
    [/\^\[0-9a-f\]\{40\}\$/gu, 'the commit pattern: import isCorpusCommit from corpus-contract.mjs'],
    // The tree path as a regex, and the tree path built by hand from the directory
    // name and a commit. `${TREES_DIR}/${commit.slice(0, 7)}` in a log line is a
    // MESSAGE about a tree, not the rule, and is deliberately not matched.
    [/trees\\\/\[0-9a-f\]\{40\}/gu, 'the tree-path pattern: import isCorpusTreePath from corpus-contract.mjs'],
    [/\$\{TREES_DIR\}\/\$\{commit\}/gu, 'a hand-built tree path: call corpusTreePath(commit)'],
    [/`trees\/\$\{/gu, 'a hand-built tree path: call corpusTreePath(commit)']
  ];
  const home = readFileSync(join(import.meta.dirname, 'corpus-contract.mjs'), 'utf8');
  assert.equal(home.match(forbidden[0][0]).length, 1, 'the contract must declare the commit pattern exactly once; a second copy here is a copy too');
  for (const file of owned.filter((name) => name !== 'corpus-contract.mjs')) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    for (const [pattern, remedy] of forbidden)
      assert.equal(source.match(pattern), null, `${file} re-spells ${remedy}`);
  }
});

// TWO READERS OF ONE MOUNT CANNOT BE ALLOWED TO DISAGREE ABOUT FAILING CLOSED
// -------------------------------------------------------------------------
// One reader wrapped its call to these predicates in a try/catch and said so in a
// comment; the other called it bare. The guarantee now lives in the contract, so
// every call site is correct by construction. DEFENCE IN DEPTH: nothing a reader
// passes in production makes these throw -- these arguments are constructed to,
// which is the only honest way to check that the catch exists.
test('a shared findings predicate answers with a finding instead of throwing, whatever it is handed', () => {
  // `path.join` throws a TypeError on a non-string, and `corpusLinkFindings` joins
  // the mount path: this is the one way a reader has ever been able to make it throw.
  for (const root of [undefined, null, 42, {}, []])
    assert.match(corpusLinkFindings(root, EDITION, COMMIT)[0], /must be a path to resolve a dated link against|could not be checked/u, `root ${JSON.stringify(root)} escaped as a throw`);
  // And the catch itself, exercised by a record that cannot come out of JSON.parse
  // but proves the wrapper is there: every field read is inside it.
  const hostile = { get commit() { throw new Error('a getter that throws'); } };
  assert.match(corpusIdentityFindings(hostile)[0], /could not be checked: a getter that throws/u);
  const hostileEdition = { version: CORPUS_IDENTITY_VERSION, get edition() { throw new Error('and so is this one'); } };
  assert.match(corpusIdentityFindings(hostileEdition, { edition: EDITION })[0], /could not be checked: and so is this one/u);
  // Both readers branch on a non-empty list, so the answer must always be one.
  for (const answer of [corpusIdentityFindings(hostile), corpusLinkFindings(null, EDITION, COMMIT)]) {
    assert.ok(Array.isArray(answer) && answer.length > 0, `${JSON.stringify(answer)} is not a refusal either reader would act on`);
    assert.ok(answer.every((finding) => typeof finding === 'string'));
  }
});
