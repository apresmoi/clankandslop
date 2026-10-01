// CORPUS.json: the record the host publishes INTO the volume for the newsroom to
// read, and the only file at the volume root this host ever rewrites.
//
// Split out of corpus-volume.mjs, which keeps the volume's directory, symlink and
// garbage-collection mechanics and re-exports every name declared here, so no
// caller's import path changed. The rules a record must satisfy are not here
// either: corpus-contract.mjs owns them (`corpusIdentityFindings`), and this
// module is the writer that refuses to publish anything they reject.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CORPUS_IDENTITY_FILE, CORPUS_IDENTITY_VERSION, CorpusError, corpusIdentityFindings, corpusTreePath
} from './corpus-contract.mjs';
import { hostExec } from './corpus-host-exec.mjs';

const fail = (message) => { throw new CorpusError(message); };

// CORPUS.json IS AN OUTPUT, NOT AN INPUT
// --------------------------------------
// uid 2000 owns the volume root and can replace this name (`echo forged >
// CORPUS.json` succeeded in the live container), so the host takes NO decision
// from it. It is written for the newsroom tools to read, and read back here only
// to compare against the bytes the host recorded in landed.json -- which is a
// tamper check, not trust. Nothing in the refresh path may use this to decide
// whether a corpus is current.
export function readIdentity(volume) {
  try { return JSON.parse(readFileSync(path.join(volume, CORPUS_IDENTITY_FILE), 'utf8')); } catch { return null; }
}

/** Exactly the record the container reads. The field list IS the contract, so it is built in one place. */
export function corpusIdentity({ commit, ref, edition, fetchedAt, editionsPresent, sourceCount }) {
  return {
    version: CORPUS_IDENTITY_VERSION,
    commit,
    // The ref NAME, not the resolved refs/remotes/... form: `edition/2026-10-02`
    // is what a producer, a runbook and an agent all recognize.
    ref,
    edition,
    fetched_at: fetchedAt,
    tree: corpusTreePath(commit),
    editions_present: [...editionsPresent].sort(),
    source_count: sourceCount
  };
}

// Refuses to publish a record that does not satisfy the contract: a reader that
// cannot validate CORPUS.json treats the corpus as unusable, so an invalid
// record is worse than an old one. The bytes are validated AFTER they are on
// disk and BEFORE they are visible -- reparsing what the filesystem actually
// holds is what catches a truncated write, which validating the object cannot.
/** The exact bytes `writeIdentity` publishes, so the host can record their digest and notice a forged replacement. */
export const identityBytes = (record) => `${JSON.stringify(record, null, 2)}\n`;

export function writeIdentity(volume, record, { edition, owner, tmpDir, exec = hostExec } = {}) {
  const planned = corpusIdentityFindings(record, { edition });
  if (planned.length) fail(`refusing to publish an invalid ${CORPUS_IDENTITY_FILE}: ${planned.join('; ')}`);
  const live = path.join(volume, CORPUS_IDENTITY_FILE);
  const tmp = path.join(tmpDir ?? volume, `.${CORPUS_IDENTITY_FILE}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, identityBytes(record), { mode: 0o444 });
  let written = null;
  try { written = JSON.parse(readFileSync(tmp, 'utf8')); } catch { /* reported as a finding below */ }
  const findings = written === null ? [`${CORPUS_IDENTITY_FILE} did not survive the write as parseable JSON`] : corpusIdentityFindings(written, { edition });
  if (findings.length) { rmSync(tmp, { force: true }); fail(`${CORPUS_IDENTITY_FILE} failed validation after it was written: ${findings.join('; ')}`); }
  // Scoped to the one file, never `-R` from the volume root.
  if (owner) exec('chown', [owner, tmp]);
  exec('chmod', ['0444', tmp]);
  renameSync(tmp, live);
  return record;
}
