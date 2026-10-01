import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS_IDENTITY_VERSION, CorpusError, REPORTERS, corpusIdentityFindings, corpusLinkFindings, verifyCorpusTree } from './corpus-contract.mjs';
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
