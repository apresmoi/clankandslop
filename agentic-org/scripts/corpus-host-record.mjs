import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EDITION_PATTERN, editionOfRef, isCorpusCommit, isCorpusTreePath } from './corpus-contract.mjs';

export const LANDED_VERSION = 'spawnfile.volume-feed-landed.v1';
export const DEFAULT_LANDED_RECORD = '/var/lib/docker/volumes/clank-newsroom-corpus/spawnfile-feed/landed.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const historyRoot = (file) => path.join(path.dirname(file), 'corpus-history');

export function readHostCorpusRecord(file) {
  if (!path.isAbsolute(file)) throw new Error(`the host corpus record path must be absolute, got ${JSON.stringify(file)}`);
  let record, bytes, missing = false;
  try { bytes = readFileSync(file); record = JSON.parse(bytes); } catch (error) { missing = error.code === 'ENOENT'; record = { unreadable: error.code ?? error.message }; }
  const identity = record?.identity, source = identity?.source;
  const reason = record?.unreadable ? `it is unreadable (${record.unreadable})`
    : record?.version !== LANDED_VERSION ? `it is not a ${LANDED_VERSION} record`
    : identity?.resource !== 'research-corpus' ? 'it does not describe the research-corpus volume'
    : source?.kind !== 'git' || !isCorpusCommit(source?.commit) || typeof source?.ref !== 'string' ? 'it names no git commit and ref'
    : !isCorpusTreePath(identity?.tree) || `trees/${record.tree}` !== identity.tree ? 'its serving tree is not the tree its identity names'
    : typeof identity?.landed_at !== 'string' || !identity.landed_at ? 'it records no landing instant'
    : null;
  if (reason) throw new Error(`the host's corpus record ${file} ${missing ? 'does not exist' : `cannot be trusted — ${reason}`} — only the host can say which corpus it landed, and this job does not publish provenance the container asserted about itself. Nothing was pushed`);
  return { record, bytes, edition: editionOfRef(source.ref), corpus: { commit: source.commit, tree: identity.tree, landed_at: identity.landed_at } };
}

export function landedCorpus(file, edition) {
  const found = readHostCorpusRecord(file);
  if (found.edition !== edition) throw new Error(`the host's corpus record ${file} has no entry for edition ${edition} — the host serves ${found.record.identity.source.ref}, so nothing outside the container can vouch for what the paper read. Nothing was pushed`);
  return found.corpus;
}

function privateEntry(file, directory = false) {
  const stat = lstatSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`host corpus history requires a private host-owned ${directory ? 'directory' : 'file'}: ${file}`);
  }
}
const syncDirectory = (directory) => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
function privateDirectory(directory) {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateEntry(directory, true);
  syncDirectory(path.dirname(directory));
}
function archiveRecord(file) {
  privateEntry(file);
  const found = readHostCorpusRecord(file);
  if (!found.edition || !Number.isFinite(Date.parse(found.corpus.landed_at))) throw new Error(`cannot retain host corpus record without a valid edition and landing instant: ${file}`);
  return found;
}

// Preserve the host's exact bytes before refresh can replace the sole current record.
export function retainHostCorpusRecord(file = DEFAULT_LANDED_RECORD, { allowMissing = false } = {}) {
  try { lstatSync(file); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  privateEntry(path.dirname(file), true);
  const found = archiveRecord(file), root = historyRoot(file);
  privateDirectory(root);
  const directory = path.join(root, found.edition); privateDirectory(directory);
  const archived = path.join(directory, `${digest(found.bytes)}.json`);
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, found.bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, archived); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      privateEntry(archived);
      if (!readFileSync(archived).equals(found.bytes)) throw new Error(`conflicting retained host corpus record: ${archived}`);
    }
    syncDirectory(directory);
  } finally { unlinkSync(temporary); }
  return archived;
}

export function selectHostCorpusRecord(file, edition, claim) {
  const current = readHostCorpusRecord(file);
  if (current.edition === edition) return file;
  if (!current.edition) throw new Error(`current host corpus record has no valid edition: ${file}`);
  if (!EDITION_PATTERN.test(edition) || !isCorpusCommit(claim?.commit) || !isCorpusTreePath(claim?.tree)) throw new Error('cannot select host history for a malformed corpus claim');
  const root = historyRoot(file), directory = path.join(root, edition);
  let names;
  try {
    privateEntry(path.dirname(file), true); privateEntry(root, true); privateEntry(directory, true);
    names = readdirSync(directory).filter(name => !name.startsWith('.pending-')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') { landedCorpus(file, edition); }
    throw error;
  }
  const matches = [];
  for (const name of names) {
    const archived = path.join(directory, name), found = archiveRecord(archived);
    if (name !== `${digest(found.bytes)}.json` || found.edition !== edition) throw new Error(`malformed retained host corpus record: ${archived}`);
    if (found.corpus.commit === claim.commit && found.corpus.tree === claim.tree) matches.push({ file: archived, at: Date.parse(found.corpus.landed_at) });
  }
  matches.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  if (!matches.length) throw new Error(`no retained host corpus record matches edition ${edition}, commit ${claim.commit} and tree ${claim.tree} — nothing was pushed`);
  return matches[0].file;
}

export function refreshCorpusFeed(command, { landed = process.env.CLANK_CORPUS_LANDED ?? DEFAULT_LANDED_RECORD, run = spawnSync } = {}) {
  if (!Array.isArray(command) || command.length === 0) throw new Error('a corpus refresh command is required after --');
  const previous = retainHostCorpusRecord(landed, { allowMissing: true });
  let result;
  try { result = run(command[0], command.slice(1), { stdio: 'inherit' }); }
  finally { retainHostCorpusRecord(landed, { allowMissing: previous === null }); }
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== '--') throw new Error('expected -- followed by the existing corpus refresh command');
    process.exitCode = refreshCorpusFeed(process.argv.slice(3));
  } catch (error) { console.error(`corpus-host-record: ${error.message}`); process.exitCode = 1; }
}
