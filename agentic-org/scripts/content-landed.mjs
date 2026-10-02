// The HOST's own record of what it put in the public content volume, and the
// CONTENT.json it publishes into it. The content-volume twin of
// corpus-landed.mjs + corpus-volume-identity.mjs, for the same reason those
// exist: uid 2000 owns the volume root (`mode: mutable`, chowned on every start),
// so every NAME in it -- CONTENT.json, `current`, `trees/` -- is agent-writable,
// and a root-run job that took a decision from one would be taking aim from an
// agent-writable input. This record lives at /var/lib/clank-content/landed.json,
// root-owned 0600, outside every container's view.
//
// Its manifests reuse corpus-landed.mjs's (kind, size, mtime, mode) stat
// manifest unchanged: one lstat per entry, no reads, every two minutes.

import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './corpus-landed.mjs';
import { hostExec } from './corpus-host-exec.mjs';
import { CONTENT_IDENTITY_FILE, CONTENT_IDENTITY_VERSION, PUBLIC_CONTENT_DIRS, PublicContentError, contentIdentityFindings } from './public-content.mjs';

export const CONTENT_LANDED_VERSION = 'clank.content-landed.v1';
const COMMIT = /^[0-9a-f]{40}$/u;
const fail = (message) => { throw new PublicContentError(message); };

/** Findings, not a throw, on the read side: a corrupt record degrades to "nothing landed" and is re-earned. */
export function contentLandedFindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['must be a JSON object'];
  const findings = [];
  if (value.version !== CONTENT_LANDED_VERSION) findings.push(`version must be ${CONTENT_LANDED_VERSION}`);
  if (!COMMIT.test(value.commit ?? '')) findings.push('commit must be a 40-character sha');
  for (const dir of PUBLIC_CONTENT_DIRS) if (!COMMIT.test(value.content_trees?.[dir] ?? '')) findings.push(`content_trees.${dir} must be a git tree id`);
  if (!Array.isArray(value.trees) || value.trees.some((name) => !COMMIT.test(name))) findings.push('trees must list landed commits');
  else if (!value.trees.includes(value.commit)) findings.push('trees must include the serving commit');
  if (!Number.isInteger(value.editions) || value.editions < 1) findings.push('editions must be the positive count the host landed');
  if (typeof value.identity_sha256 !== 'string' || !value.identity_sha256.startsWith('sha256:')) findings.push('identity_sha256 must be the digest of the published CONTENT.json');
  if (value.heals !== undefined && (typeof value.heals !== 'object' || value.heals === null || Array.isArray(value.heals))) findings.push('heals must be an object');
  return findings;
}

export function readContentLanded(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { record: null, reason: null }; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { record: null, reason: `${file} is not parseable JSON` }; }
  const findings = contentLandedFindings(parsed);
  return findings.length ? { record: null, reason: `${file} is invalid: ${findings.join('; ')}` } : { record: parsed, reason: null };
}

/** tmp + rename, 0600, and only ever after the volume mutation it describes has succeeded. */
export function writeContentLanded(file, record) {
  const findings = contentLandedFindings(record);
  if (findings.length) fail(`refusing to write an invalid ${path.basename(file)}: ${findings.join('; ')}`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return record;
}

export const contentIdentity = ({ commit, ref, contentTrees, editions, landedAt }) => ({
  version: CONTENT_IDENTITY_VERSION, commit, ref, tree: `trees/${commit}/content`,
  content_trees: { ...contentTrees }, editions, landed_at: landedAt
});
export const contentIdentityBytes = (record) => `${JSON.stringify(record, null, 2)}\n`;

// An OUTPUT for the container to read; never read back here except to compare
// its digest with the one recorded above. Validated after it is on disk and
// before it is visible, so a truncated write is never what a reader finds.
export function writeContentIdentity(volume, record, { owner, tmpDir, exec = hostExec } = {}) {
  const planned = contentIdentityFindings(record);
  if (planned.length) fail(`refusing to publish an invalid ${CONTENT_IDENTITY_FILE}: ${planned.join('; ')}`);
  const tmp = path.join(tmpDir ?? volume, `.${CONTENT_IDENTITY_FILE}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, contentIdentityBytes(record), { mode: 0o444 });
  let written = null;
  try { written = JSON.parse(readFileSync(tmp, 'utf8')); } catch { /* reported below */ }
  const findings = written === null ? ['did not survive the write as JSON'] : contentIdentityFindings(written);
  if (findings.length) { rmSync(tmp, { force: true }); fail(`${CONTENT_IDENTITY_FILE} failed validation after it was written: ${findings.join('; ')}`); }
  if (owner) exec('chown', [owner, tmp]);
  exec('chmod', ['0444', tmp]);
  renameSync(tmp, path.join(volume, CONTENT_IDENTITY_FILE));
  return sha256(contentIdentityBytes(record));
}

export const readContentIdentityBytes = (volume) => { try { return readFileSync(path.join(volume, CONTENT_IDENTITY_FILE), 'utf8'); } catch { return null; } };
