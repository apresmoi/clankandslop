import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reverifiedCorpusProvenance } from './reverified-corpus.mjs';
import { parseArguments } from './publish-edition-branch.mjs';
import { proofFor, COMMIT, REVISION, EDITION, DISCLOSURE } from './reverified-corpus.fixture.mjs';
const stage = { edition: EDITION, receipt: { composition_digest: `sha256:${'a'.repeat(64)}`, artifact_digest: `sha256:${'b'.repeat(64)}` } };
const claim = { commit: COMMIT, tree: `trees/${REVISION}` };
function fixture(change = () => {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'reverified-proof-')), file = path.join(directory, 'proof.json');
  const proof = proofFor(stage); change(proof); writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
  return { directory, file, proof };
}

test('only explicit operator options enable the Oct27 proof, never an automatic fallback', () => {
  const args = ['--staging', '/staging', '--state', '/state', '--dry-run'];
  assert.equal(parseArguments(args).reverifiedCorpus, undefined);
  assert.equal(parseArguments([...args, '--reverified-corpus', '/proof']).reverifiedCorpus, '/proof');
  assert.equal(parseArguments([...args, '--reverified-corpus=/proof']).reverifiedCorpus, '/proof');
  for (const conflict of [['--landed', '/landed'], ['--allow-unprovenanced-edition']]) assert.throws(() => parseArguments([...args, '--reverified-corpus', '/proof', ...conflict]), /cannot be combined/);
  assert.throws(() => parseArguments(['--staging', '/staging', '--dry-run', '--reverified-corpus', '/proof']), /requires --state/);
});

test('the approved proof publishes only current verification facts and unknown historical identity', () => {
  const f = fixture(p => { p.audit.proof_directory = '/root/private'; p.audit.journal_events = [{ observed_event_time: '2026-10-27T08:54:16Z' }]; });
  const result = reverifiedCorpusProvenance(f.file, stage, claim);
  assert.equal(result.disclosure, DISCLOSURE); assert.equal(result.corpus, null);
  assert.equal(result.original_fetch_identity, null); assert.equal(result.original_landing_timestamp, null);
  assert.equal(result.reverified_corpus.verified_at, f.proof.audit.finished_at);
  assert.equal(result.reverified_corpus.differences, 0);
  assert.doesNotMatch(JSON.stringify(result), /\/root\/|journal|landed_at|commissioned_ref|predates/);
  assert.deepEqual(result, reverifiedCorpusProvenance(f.file, stage, claim));
});

test('edition, staged artifact, composition and corpus claim must match the proof exactly', () => {
  for (const change of [p => p.edition = '2026-10-28', p => p.disclosure = 'Other wording', p => p.composition_digest = `sha256:${'c'.repeat(64)}`, p => p.artifact_digest = `sha256:${'c'.repeat(64)}`, p => p.audit.input.requested_commit = 'f'.repeat(40), p => p.audit.input.resolved_commit = 'f'.repeat(40), p => p.audit.input.resolved_revision = 'f'.repeat(64), p => p.audit.input.expected_retained_revision = 'f'.repeat(64), p => p.audit.input.paths = ['2026-10-28'], p => delete p.audit.latest_stage, p => p.audit.latest_stage.edition = '2026-10-28', p => p.audit.latest_stage.receipt.composition_digest = `sha256:${'c'.repeat(64)}`, p => p.audit.latest_stage.receipt.artifact_digest = `sha256:${'c'.repeat(64)}`, p => p.audit.latest_stage.claim.commit = 'f'.repeat(40), p => p.audit.latest_stage.claim.tree = `trees/${'f'.repeat(64)}`]) {
    const f = fixture(change); assert.throws(() => reverifiedCorpusProvenance(f.file, stage, claim), /proof refused/);
  }
  const f = fixture();
  assert.throws(() => reverifiedCorpusProvenance(f.file, { ...stage, edition: '2026-10-28' }, claim), /only the explicitly approved/);
  assert.throws(() => reverifiedCorpusProvenance(f.file, stage, null), /no valid corpus claim/);
  assert.throws(() => reverifiedCorpusProvenance(f.file, stage, { ...claim, tree: `trees/${'f'.repeat(64)}` }), /proof refused/);
});

test('failed, partial, malformed or drifted canonical audits refuse', () => {
  const changes = [p => p.version = 'unknown', p => p.audit.success = false, p => p.audit.content_match = false, p => p.audit.trusted_manifest_unchanged = false, p => p.audit.all_metadata_equal = false, p => p.audit.finished_at = 'invalid', p => p.audit.compiler.module_sha256 = {}, p => p.audit.trusted_manifest.sha256 = 'short', p => p.audit.trusted_manifest.uid = 2000, p => p.audit.trusted_manifest.entries += 1];
  for (const name of ['archive_comparison', 'retained_tree_comparison']) {
    for (const key of ['changed', 'extra', 'missing', 'touched', 'drift']) changes.push(p => p.audit[name][key].push('drifted-file'));
    changes.push(p => p.audit[name].checked_entries -= 1);
  }
  for (const change of changes) { const f = fixture(change); assert.throws(() => reverifiedCorpusProvenance(f.file, stage, claim), /proof refused/); }
  const f = fixture(); writeFileSync(f.file, '{'); assert.throws(() => reverifiedCorpusProvenance(f.file, stage, claim), /malformed JSON/);
});

test('proof and its parent must be private host-owned real paths', () => {
  const f = fixture(); chmodSync(f.file, 0o644); assert.throws(() => reverifiedCorpusProvenance(f.file, stage, claim), /private host-owned/); chmodSync(f.file, 0o600);
  chmodSync(f.directory, 0o755); assert.throws(() => reverifiedCorpusProvenance(f.file, stage, claim), /private host-owned/); chmodSync(f.directory, 0o700);
  const link = path.join(f.directory, 'link.json'); symlinkSync(f.file, link); assert.throws(() => reverifiedCorpusProvenance(link, stage, claim), /private host-owned/);
  const parent = path.join(f.directory, 'parent'); symlinkSync(f.directory, parent); assert.throws(() => reverifiedCorpusProvenance(path.join(parent, 'proof.json'), stage, claim), /private host-owned/);
  const folder = path.join(f.directory, 'folder'); mkdirSync(folder, { mode: 0o700 }); assert.throws(() => reverifiedCorpusProvenance(folder, stage, claim), /private host-owned/);
});
