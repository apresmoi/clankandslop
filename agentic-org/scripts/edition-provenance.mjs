// Provenance for a published edition, asserted by the HOST.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// The same reason `staged-edition.mjs` is: `publish-edition-branch.mjs` is the
// one path to the public paper and stays short enough to read in one sitting.
// The reading and checking of two durable records belongs beside it, not inside
// it, and a module with no side effects is testable without a remote.
//
// THE DEFECT THIS EXISTS FOR
// --------------------------
// The corpus left the image and became a docker volume, and the container's
// ownership guard chowns that volume to uid 2000 -- the AGENTS' uid -- on every
// start. Reproduced on the production host: `docker exec --user 2000:2000 ...
// 'echo forged > <volume>/CORPUS.json'` CREATES the file. So the identity record
// on the mount, and every receipt derived from it inside the container, is
// self-asserted by the very agents it is supposed to constrain; the image digest
// it replaced could not be forged from inside.
//
// This side of the airlock can still prove it. The host fetches the corpus and
// writes a root-owned record OUTSIDE the volume that the container cannot read,
// and the publisher -- on the host, holding the deploy key, the only thing that
// pushes -- refuses unless the edition's own durable records and that host
// record name the SAME commit. What lands on the branch is the commit the HOST
// vouches for, and nothing here ever reads the mount.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// The host record's SHAPE is not restated here. corpus-landed.mjs is what the
// refresher writes it under; a second copy of those rules is a copy that is not
// exercised every morning, and a provenance check that has drifted is
// indistinguishable from no provenance check at all. What this module owns is
// the POLICY on top: the refresher may degrade a bad record to "nothing landed"
// and re-earn it next run, and the publisher may not.
import { readLanded } from './corpus-landed.mjs';
import { corpusTreePath, isCorpusCommit } from './corpus-contract.mjs';

export { LANDED_VERSION } from './corpus-landed.mjs';
// The same path corpus-refresh.mjs writes (its `DEFAULT_LANDED`), spelled out
// rather than imported: the refresher is a host WRITER that pulls in the volume
// mutators, and the publisher has no business importing any of that. A drift
// between the two spellings is a refusal on the next publication, not a silent
// pass — the file simply is not there.
export const DEFAULT_LANDED_RECORD = '/var/lib/clank-corpus/landed.json';
export const CORPUS_PROVENANCE_FILE = 'corpus-provenance.json';
export const CORPUS_PROVENANCE_VERSION = 'clank.edition-corpus-provenance.v1';
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

// The container's claim, read out of the composition receipt the staged receipt
// already names: the same receipts directory `resolveStagedEdition` reads,
// addressed by the composition digest it validated, so there is no second path
// convention. `claim: null` means the records carry no corpus identity at all —
// the backfill case. A record that CONTRADICTS itself throws instead: that is
// broken records, never an edition that predates provenance.
export async function editionCorpusClaim(stateRoot, edition, compositionDigest) {
  if (!path.isAbsolute(stateRoot)) throw new Error(`--state must be an absolute path, got ${JSON.stringify(stateRoot)}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(compositionDigest ?? '')) throw new Error(`the staged receipt for ${edition} records no composition digest, so the composition carrying its corpus claim cannot be found — nothing was pushed`);
  const file = path.join(stateRoot, 'editions', edition, 'receipts', `composed-${compositionDigest.slice(7)}.json`);
  let value;
  try { value = await readJson(file); } catch (error) { return { file, claim: null, reason: `${file} is missing or unparseable (${error.code ?? error.message})` }; }
  if (value?.kind !== 'composed' || value.edition !== edition || value.digest !== compositionDigest) throw new Error(`${file} is not the composed receipt for ${edition} at ${compositionDigest} — the edition's records disagree about which composition was staged, and nothing was pushed`);
  const corpus = value.composition?.corpus;
  if (corpus === undefined || corpus === null) return { file, claim: null, reason: `${file} carries no composition.corpus` };
  if (typeof corpus !== 'object' || !isCorpusCommit(corpus.commit ?? '') || corpus.edition !== edition || corpus.tree !== corpusTreePath(corpus.commit)) throw new Error(`${file} carries a malformed research-corpus identity (commit ${JSON.stringify(corpus.commit ?? null)}, edition ${JSON.stringify(corpus.edition ?? null)}, tree ${JSON.stringify(corpus.tree ?? null)}) — nothing was pushed`);
  return { file, claim: { commit: corpus.commit, ref: typeof corpus.ref === 'string' ? corpus.ref : null, tree: corpus.tree }, reason: null };
}

// The host's own answer, written outside the volume and unreadable by the
// container. EVERY failure here is a refusal: an edition whose corpus the host
// cannot vouch for is exactly what this exists to stop, and "unknown" is not a
// value a published paper may carry.
export function landedCorpus(file, edition) {
  if (!path.isAbsolute(file)) throw new Error(`the host corpus record path must be absolute, got ${JSON.stringify(file)}`);
  // `readLanded` owns the shape and degrades anything it cannot trust to
  // "nothing landed". For the refresher that is recoverable — it re-lands and
  // rewrites the record on its next run. A published paper cannot re-earn its
  // provenance afterwards, so here the same state is a refusal.
  const { record, reason, missing } = readLanded(file);
  if (record === null) throw new Error(`the host's corpus record ${file} ${missing ? 'does not exist' : `cannot be trusted — ${reason}`} — only the host can say which corpus it landed, and this job does not publish provenance the container asserted about itself. Nothing was pushed`);
  const entry = record.editions?.[edition];
  if (entry === undefined) throw new Error(`the host's corpus record ${file} has no entry for edition ${edition} — the host never landed a corpus for this edition, so nothing outside the container can vouch for what the paper read. Nothing was pushed`);
  return { commit: entry.commit, tree: entry.tree, landed_at: entry.landed_at };
}

// Fail closed, and loud when overridden. The record returned is what the branch
// carries: host-asserted values only, no host paths, and nothing that moves
// between two runs of one edition — a provenance file holding a publish instant
// would rebuild a different commit on every retry and break the convergence the
// push depends on.
export async function hostAssertedProvenance(options, staged, { warn = console.warn } = {}) {
  const edition = staged.edition;
  if (options.state === undefined) throw new Error(`publishing ${edition} requires --state <clank-edition-state volume path>: the host asserts which research corpus backed the edition, and the claim it is checked against lives in the edition's own durable records. Nothing was pushed`);
  const landedFile = path.resolve(options.landed ?? process.env.CLANK_CORPUS_LANDED ?? DEFAULT_LANDED_RECORD);
  const found = await editionCorpusClaim(options.state, edition, staged.receipt?.composition_digest);
  if (found.claim === null) {
    if (options.allowUnprovenanced !== true) throw new Error(`edition ${edition} carries no research-corpus identity in its own records — ${found.reason}. It was commissioned before corpus provenance existed, so it cannot prove which research its stories rest on, and this job never publishes a paper whose provenance is unknown. Recommission the lineup against the mounted corpus and stage it again, or — for a one-time backfill of an edition that predates provenance — re-run with --allow-unprovenanced-edition. Nothing was pushed`);
    warn(`publish-edition-branch: PUBLISHING ${edition} AS UNPROVENANCED — ${found.reason}. --allow-unprovenanced-edition was passed deliberately, so the branch itself records that this edition cannot say which research backed it.`);
    return { record: { version: CORPUS_PROVENANCE_VERSION, edition, asserted_by: 'host', corpus: null, unprovenanced: 'this edition predates host-asserted corpus provenance and was published with --allow-unprovenanced-edition' }, claim: null, landed: null, landed_record: landedFile, unprovenanced: true };
  }
  const landed = landedCorpus(landedFile, edition);
  if (landed.commit !== found.claim.commit) throw new Error(`edition ${edition} was commissioned against corpus ${found.claim.commit} (${found.file}), but the host landed ${landed.commit} for ${edition} (${landedFile}) — the container's claim and the host's record name different research, and the host's record is the one with authority. Nothing was pushed`);
  // `corpus` is the HOST's record and nothing else, because that is what
  // `asserted_by: host` claims. The branch name the container says the corpus was
  // cut from is useful and unverifiable from here, so it is carried beside it
  // under its own name rather than folded in where it would read as vouched for.
  return { record: { version: CORPUS_PROVENANCE_VERSION, edition, asserted_by: 'host', corpus: { commit: landed.commit, tree: landed.tree, landed_at: landed.landed_at }, commissioned_ref: found.claim.ref }, claim: found.claim, landed, landed_record: landedFile, unprovenanced: false };
}

