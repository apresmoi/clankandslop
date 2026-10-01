import test from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS_IDENTITY_VERSION, corpusIdentityFindings } from './corpus-contract.mjs';

const EDITION = '2026-09-06';
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
