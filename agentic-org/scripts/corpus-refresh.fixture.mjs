// The fixtures the corpus refresher's tests run against: a real private git repo
// with a real edition branch, a real volume directory, and the host work roots
// the refresher stages and deletes through. `git` and `tar` are never mocked —
// the extraction path is the part most likely to be wrong, and a mocked one
// would have hidden the silently-empty extraction this suite caught.
// Test fixture only; nothing in a container imports this.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { VOLUME_ROOT_MODE } from './corpus-volume.mjs';

export const EDITION = '2026-09-06';
export const PRIOR = '2026-09-05';
export const UNCUT = '2026-09-07';
export const OWNER = `${process.getuid()}:${process.getgid()}`;
// A dated corpus freezes once its --require-by cutoff has passed with a corpus
// already landed, so every test now has to say WHEN it is running. The default
// clock is before the earliest cutoff in this fixture (12:00 Europe/Berlin on
// PRIOR), so nothing is frozen unless a test asks for it by passing AFTER_CUTOFF
// -- 13:00 Berlin on edition day, which is when the newsroom wakes.
export const BEFORE_CUTOFF = new Date('2026-09-05T05:00:00Z');
export const AFTER_CUTOFF = new Date('2026-09-06T11:00:00Z');
// tinkerton sits out, because that is what a real edition looks like: the row
// counts fall to single digits and a beat with nothing routed to it files
// nothing. Every test in this suite therefore runs against a corpus with a
// quiet desk in it, which is the case an over-strict guard would lose the day on.
export const STORIES = { cogsworth: ['s-11111111', 's-22222222'], sprockett: ['s-22222222'], foreman: ['s-33333333'], graves: ['s-33333333'], tinkerton: [], vesta: ['s-11111111'] };
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export const writeIndex = (root, edition, agent, ids) => {
  mkdirSync(join(root, edition, 'desks'), { recursive: true });
  const header = `# clank.desk-index.v1 desk=${agent} edition=${edition}\n# id          slot src  urls conf also\n`;
  writeFileSync(join(root, edition, 'desks', `${agent}.index`), header + ids.map((id) => `${id}    0307 grok 6    h    | a claim | a summary\n`).join(''));
};

const writeStory = (root, edition, id) => {
  mkdirSync(join(root, edition, 'stories'), { recursive: true });
  writeFileSync(join(root, edition, 'stories', `${id}.md`), `# ${id}\n`);
};

export const writeRaw = (root, edition, site, slot, body) => {
  mkdirSync(join(root, edition, site), { recursive: true });
  const rel = `${site}/${site}-rolling-${slot}.md`;
  writeFileSync(join(root, edition, rel), body);
  return { path: rel, sha256: sha256(body) };
};

const writePrepared = (root, edition, sources) => {
  mkdirSync(join(root, edition, 'desks'), { recursive: true });
  writeFileSync(join(root, edition, 'desks', '_corpus.prepared.json'), `${JSON.stringify({
    version: 'clank.research-corpus.prepared.v1', edition, generated: `${edition}T07:00:00.000Z`,
    sources: [...sources].sort((a, b) => a.path.localeCompare(b.path))
  }, null, 2)}\n`);
};

/** One day's complete corpus. `mark` is what distinguishes one commit's research from another's. */
export const writeCorpus = (root, edition, mark) => {
  const sources = [writeRaw(root, edition, 'chatgpt', '0715', `# chatgpt ${edition}\n\n${mark}\n`), writeRaw(root, edition, 'grok', '0730', `# grok ${edition}\n\n${mark}\n`)];
  for (const [agent, ids] of Object.entries(STORIES)) {
    writeIndex(root, edition, agent, ids);
    for (const id of ids) writeStory(root, edition, id);
  }
  writePrepared(root, edition, sources);
  return sources;
};

export const commitAll = (priv, message) => { git(priv, 'add', '-A'); git(priv, 'commit', '--quiet', '-m', message); return git(priv, 'rev-parse', 'HEAD').trim(); };

// A real private repo with a real edition branch, a real volume directory, and
// the host work roots the refresher stages and deletes through. `git` is never
// mocked: the extraction path is the thing most likely to be wrong.
export const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-corpus-refresh-'));
  const priv = join(root, 'clankandslop-private');
  mkdirSync(priv, { recursive: true });
  git(priv, 'init', '--quiet', '-b', 'main');
  git(priv, 'config', 'user.email', 'test@example.invalid');
  git(priv, 'config', 'user.name', 'test');
  // `main` carries a DIFFERENT, perfectly valid corpus — including one for a
  // date whose edition branch was never cut. Anything that falls back to main
  // therefore produces a corpus, and the test can see that it did.
  writeCorpus(priv, EDITION, 'MAIN RESEARCH, MERGED LAST NIGHT');
  writeCorpus(priv, UNCUT, 'MAIN RESEARCH FOR A DAY NOBODY CUT');
  commitAll(priv, 'research: main');
  git(priv, 'checkout', '--quiet', '-b', `edition/${EDITION}`);
  rmSync(join(priv, UNCUT), { recursive: true, force: true });
  writeCorpus(priv, PRIOR, 'yesterday');
  writeCorpus(priv, EDITION, 'EDITION BRANCH RESEARCH');
  const commit = commitAll(priv, `research: split ${EDITION} corpus`);

  const volume = join(root, 'volume');
  mkdirSync(volume, { recursive: true });
  chmodSync(volume, VOLUME_ROOT_MODE);
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  // The host-side record and the edition-state root both live OUTSIDE the volume,
  // exactly as they must on the box: landed.json is the only thing the refresher
  // believes, and a volume-resident copy would be agent-writable.
  const editionState = join(root, 'edition-state');
  mkdirSync(editionState, { recursive: true });
  return {
    root, priv, commit, volume: realpathSync(volume), work: realpathSync(work), editionState: realpathSync(editionState),
    staging: join(realpathSync(work), 'staging'), trash: join(realpathSync(work), 'trash'),
    ledger: join(realpathSync(work), 'refresh.jsonl'), landed: join(realpathSync(work), 'landed.json')
  };
};

// A frozen tree is unwritable even by its owner, so the fixture has to thaw
// before it can be removed — exactly what the refresher's own GC does.
export const cleanup = (fixture) => {
  try { execFileSync('chmod', ['-R', 'u+w', fixture.root]); } catch { /* nothing left to thaw */ }
  rmSync(fixture.root, { recursive: true, force: true });
};

// No `--edition-state`: the refresher does not take the flag any more, because it
// does not read that volume any more. See `commission` below.
export const args = (fixture, extra = []) => [
  '--no-fetch', '--no-lock', `--edition=${EDITION}`, `--volume=${fixture.volume}`, `--private=${fixture.priv}`,
  `--staging=${fixture.staging}`, `--trash=${fixture.trash}`, `--landed=${fixture.landed}`, `--owner=${OWNER}`, ...extra
];
// `alarm` defaults to a no-op so a test that does not care about alarms cannot
// page a real host through raiseDetached; tests that DO care pass their own.
export const deps = (fixture, extra = {}) => ({ log: () => {}, alarm: () => {}, now: BEFORE_CUTOFF, ledger: fixture.ledger, ...extra });
export const identityOf = (fixture) => JSON.parse(readFileSync(join(fixture.volume, 'CORPUS.json'), 'utf8'));
/** The host's authoritative record — the only thing the refresher is allowed to believe. */
export const landedOf = (fixture) => JSON.parse(readFileSync(fixture.landed, 'utf8'));

// ASSIGNMENT RECORDS, AS THE AGENTS CAN LEAVE THEM
// ------------------------------------------------
// These write into the edition-state volume, which is mounted WRITABLE into all
// twelve agents. The refresher used to count these files to decide whether a date
// was frozen, which made the freeze agent-answerable in both directions: one
// planted file froze a date nobody commissioned, and one `rm` thawed a date the
// reporters were drafting against.
//
// They are kept here for exactly one purpose now: proving the freeze decision does
// not change when they appear, when they are garbage, or when they are deleted.
const assignmentsDir = (fixture, edition) => join(fixture.editionState, 'editions', edition, 'assignments');

export const commission = (fixture, edition, commit) => {
  const directory = assignmentsDir(fixture, edition);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'aaaaaaaa.json'), `${JSON.stringify({
    version: 'clank.assignments.v1', edition, event_key: `schedule:assignment-${edition}`,
    assignments: [{ id: 'story-0', owner: 'cogsworth', brief: 'Report the verified mechanism.', evidence_refs: [] }],
    corpus: { commit, edition }
  }, null, 2)}\n`);
  return commit;
};

/** The planted file the old count accepted as a commission: not JSON, not a receipt, not from Brass. */
export const plantAssignment = (fixture, edition) => {
  const directory = assignmentsDir(fixture, edition);
  mkdirSync(join(directory, 'bbbbbbbb'), { recursive: true });
  writeFileSync(join(directory, 'cccccccc.json'), '{not json');
  writeFileSync(join(directory, 'bbbbbbbb', '1.json'), `${JSON.stringify({ corpus: { commit: 'f'.repeat(40), edition } })}\n`);
};

/** Everything an agent can delete to make a commissioned edition look uncommissioned. */
export const uncommission = (fixture, edition) => rmSync(assignmentsDir(fixture, edition), { recursive: true, force: true });
export const ledgerOf = (fixture) => readFileSync(fixture.ledger, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** Every path in the volume with its kind, mtime and contents — the evidence that a no-op wrote nothing. */
export const snapshot = (root) => {
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      const key = relative(root, file);
      if (stat.isSymbolicLink()) entries.push([key, 'link', readlinkSync(file)]);
      else if (stat.isDirectory()) { entries.push([key, 'dir', stat.mtimeMs]); walk(file); }
      else entries.push([key, 'file', stat.mtimeMs, stat.mode & 0o7777, readFileSync(file, 'utf8')]);
    }
  };
  walk(root);
  return entries;
};

