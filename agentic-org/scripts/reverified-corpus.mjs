import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isCorpusCommit, isCorpusTreePath } from './corpus-contract.mjs';

export const REVERIFIED_EDITION = '2026-10-27';
export const REVERIFIED_DISCLOSURE = 'Sources reverified; original host landing record unavailable.';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const receiptDigest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const instant = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
const refuse = (message) => { throw new Error(`reverified corpus proof refused: ${message} — nothing was pushed`); };

function privateProof(file) {
  if (!path.isAbsolute(file)) refuse('proof path must be absolute');
  const parent = lstatSync(path.dirname(file)), named = lstatSync(file);
  for (const [info, directory] of [[parent, true], [named, false]]) {
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || (directory ? !info.isDirectory() : !info.isFile())) refuse('proof and parent must be private host-owned real files/directories');
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) refuse('opened proof is not a private host-owned file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function reverifiedCorpusProvenance(file, staged, claim) {
  const bytes = privateProof(file);
  let proof;
  try { proof = JSON.parse(bytes); } catch { refuse('malformed JSON'); }
  if (proof?.version !== 'clank.reverified-corpus-publication.v1' || proof.edition !== REVERIFIED_EDITION || staged.edition !== REVERIFIED_EDITION || proof.disclosure !== REVERIFIED_DISCLOSURE) refuse('only the explicitly approved October 27 disclosure is supported');
  if (!receiptDigest(proof.composition_digest) || !receiptDigest(proof.artifact_digest) || proof.composition_digest !== staged.receipt?.composition_digest || proof.artifact_digest !== staged.receipt?.artifact_digest) refuse('proof does not bind the validated staged composition and artifact');
  if (!isCorpusCommit(claim?.commit) || !isCorpusTreePath(claim?.tree)) refuse('composition has no valid corpus claim');
  const audit = proof.audit, input = audit?.input, manifest = audit?.trusted_manifest;
  const auditedStage = audit?.latest_stage;
  if (auditedStage?.edition !== staged.edition || auditedStage.receipt?.state !== 'staged' || auditedStage.receipt.edition !== staged.edition || auditedStage.receipt.composition_digest !== staged.receipt.composition_digest || auditedStage.receipt.artifact_digest !== staged.receipt.artifact_digest || auditedStage.claim?.commit !== claim.commit || auditedStage.claim.tree !== claim.tree) refuse('canonical audit was not made against this staged edition and corpus claim');
  if (audit?.kind !== 'read-only-historical-corpus-content-audit' || audit.success !== true || audit.content_match !== true || audit.all_metadata_equal !== true || audit.trusted_manifest_unchanged !== true) refuse('canonical audit did not complete an exact comparison');
  const revision = claim.tree.slice('trees/'.length);
  if (!sha(revision) || input?.requested_commit !== claim.commit || input.resolved_commit !== claim.commit || input.resolved_revision !== revision || input.expected_retained_revision !== revision || JSON.stringify(input.paths) !== JSON.stringify([staged.edition]) || !isCorpusCommit(input.selected_git_tree)) refuse('canonical audit does not match the edition, commit and tree');
  if (!instant(audit.started_at) || !instant(audit.finished_at) || Date.parse(audit.started_at) > Date.parse(audit.finished_at)) refuse('audit has no valid verification interval');
  if (typeof audit.compiler?.version !== 'string' || !['feedSource.js', 'feedLayout.js', 'feedManifest.js'].every(name => sha(audit.compiler?.module_sha256?.[name]))) refuse('audit has no canonical feed implementation hashes');
  if (manifest?.uid !== 0 || manifest.mode !== '600' || manifest.regular !== true || manifest.directory !== false || manifest.symlink !== false || manifest.tree !== revision || !sha(manifest.sha256)) refuse('audit has no trusted retained manifest');
  if (!Number.isSafeInteger(manifest.declared_files) || manifest.declared_files < 1 || !Number.isSafeInteger(manifest.entries) || manifest.entries < manifest.declared_files || manifest.entry_counts?.f !== manifest.declared_files || !Object.values(manifest.entry_counts).every(n => Number.isSafeInteger(n) && n >= 0) || Object.values(manifest.entry_counts).reduce((a, b) => a + b, 0) !== manifest.entries) refuse('audit entry counts disagree');
  for (const name of ['archive_comparison', 'retained_tree_comparison']) {
    const comparison = audit[name];
    if (comparison?.checked_entries !== manifest.entries || !['changed', 'extra', 'missing', 'touched', 'drift'].every(key => Array.isArray(comparison[key]) && comparison[key].length === 0)) refuse(`${name} reports drift or an incomplete comparison`);
  }
  return {
    edition: staged.edition, asserted_by: 'host', verification: 'reverified-content', corpus: null,
    reverified_corpus: { commit: claim.commit, tree: claim.tree, verified_at: audit.finished_at, manifest_sha256: manifest.sha256, files_checked: manifest.declared_files, entries_checked: manifest.entries, differences: 0, proof_sha256: hash(bytes) },
    original_fetch_identity: null, original_landing_timestamp: null, disclosure: REVERIFIED_DISCLOSURE,
  };
}
