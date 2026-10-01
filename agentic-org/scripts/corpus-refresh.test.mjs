import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CorpusError, REPORTERS } from './corpus-contract.mjs';
import { SYMLINK_OPS, TREES_DIR, VOLUME_ROOT_MODE, hostExec } from './corpus-volume.mjs';
import { LOCK_BUSY_EXIT, LOCK_ENV, corpusCurrent, corpusRefreshArgs, main, refresh } from './corpus-refresh.mjs';
import { EDITION, OWNER, PRIOR, STORIES, UNCUT, args, cleanup, commitAll, deps, fixture, git, identityOf, ledgerOf, snapshot, writeCorpus, writeIndex, writeRaw } from './corpus-refresh.fixture.mjs';

const liveTree = (fixture, edition = EDITION) => realpathSync(join(fixture.volume, edition));
const treeOf = (fixture, commit) => realpathSync(join(fixture.volume, TREES_DIR, commit));

test('corpusRefreshArgs defaults to the production host and rejects anything it cannot act on', () => {
  const options = corpusRefreshArgs([]);
  assert.equal(options.volume, '/var/lib/docker/volumes/clank-newsroom-corpus/_data');
  assert.equal(options.private, '/root/work/clankandslop/clankandslop-private');
  assert.equal(options.staging, '/var/lib/clank-corpus/staging');
  assert.equal(options.trash, '/var/lib/clank-corpus/trash');
  assert.equal(options.lock, '/run/lock/clank-corpus-refresh.lock');
  assert.equal(options.owner, '2000:2000');
  assert.deepEqual([options.keep, options.fetch, options.check, options.edition, options.ref], [3, true, false, null, null]);
  assert.equal(corpusRefreshArgs(['--no-lock']).lock, null);
  assert.throws(() => corpusRefreshArgs(['--edition=tomorrow']), CorpusError);
  assert.throws(() => corpusRefreshArgs(['--keep=-1']), CorpusError);
  assert.throws(() => corpusRefreshArgs(['--keep=some']), CorpusError);
  assert.throws(() => corpusRefreshArgs(['--owner=clank']), CorpusError);
  assert.throws(() => corpusRefreshArgs(['--deploy']), CorpusError);
});

test('a first refresh into an empty volume publishes the edition, its tree and a valid identity record', () => {
  const f = fixture();
  try {
    const result = refresh(args(f), deps(f, { now: new Date('2026-09-06T06:30:12.918Z') }));
    assert.equal(result.changed, true);
    assert.equal(result.commit, f.commit);
    assert.equal(result.previousCommit, null);
    // Both dated directories the commit carries are linked, not just today's.
    assert.equal(result.linksMoved, 2);
    assert.equal(lstatSync(join(f.volume, EDITION)).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${f.commit}/${EDITION}`);
    assert.equal(liveTree(f), join(treeOf(f, f.commit), EDITION));
    assert.equal(readFileSync(join(f.volume, EDITION, 'chatgpt', 'chatgpt-rolling-0715.md'), 'utf8').includes('EDITION BRANCH RESEARCH'), true);
    for (const agent of REPORTERS) assert.ok(existsSync(join(f.volume, EDITION, 'desks', `${agent}.index`)), `${agent} cannot read its desk index through the link`);

    const identity = identityOf(f);
    assert.deepEqual(Object.keys(identity), ['version', 'commit', 'ref', 'edition', 'fetched_at', 'tree', 'editions_present', 'source_count']);
    assert.deepEqual(identity, {
      version: 'clank.research-corpus.identity.v1', commit: f.commit, ref: `edition/${EDITION}`, edition: EDITION,
      fetched_at: '2026-09-06T06:30:12Z', tree: `${TREES_DIR}/${f.commit}`, editions_present: [PRIOR, EDITION], source_count: 2
    });
    assert.deepEqual(ledgerOf(f), [{
      v: 'clank.corpus-refresh.v1', at: '2026-09-06T06:30:12Z', edition: EDITION, ref: `edition/${EDITION}`,
      commit: f.commit, previous_commit: null, links_moved: 2, trees_removed: 0, changed: true
    }]);
    // Nothing transient is left anywhere, and staging/trash are empty again.
    assert.deepEqual(readdirSync(f.volume).sort(), ['CORPUS.json', PRIOR, EDITION, TREES_DIR].sort());
    assert.deepEqual(readdirSync(f.staging), []);
    assert.deepEqual(readdirSync(f.trash), []);
  } finally { cleanup(f); }
});

test('the landed tree is read-only to every class and owned by the configured uid', () => {
  const f = fixture();
  try {
    const calls = [];
    const exec = (command, commandArgs, options) => { calls.push([command, ...commandArgs]); return hostExec(command, commandArgs, options); };
    refresh(args(f), deps(f, { exec }));

    const tree = treeOf(f, f.commit);
    let checked = 0;
    const walk = (directory) => {
      for (const name of readdirSync(directory)) {
        const file = join(directory, name);
        const stat = lstatSync(file);
        assert.equal(stat.mode & 0o222, 0, `${relative(tree, file)} is writable by someone: 0${(stat.mode & 0o7777).toString(8)}`);
        assert.equal(stat.uid, process.getuid(), `${relative(tree, file)} is not owned by the configured uid`);
        checked += 1;
        if (stat.isDirectory()) walk(file);
      }
    };
    walk(tree);
    assert.ok(checked > 20, `the walk must actually have visited the corpus, saw ${checked} entries`);

    // The chown and the freeze are aimed at the staging tree, before it is
    // reachable, and NEVER at the volume root: one `-R` over the root rewrites
    // .spawnfile-resource-identity and no container starts again.
    const recursive = calls.filter(([command, flag]) => ['chown', 'chmod'].includes(command) && flag === '-R');
    assert.ok(recursive.some(([command, , owner, target]) => command === 'chown' && owner === OWNER && target.startsWith(f.staging + sep)), `no chown of the staging tree in ${JSON.stringify(calls)}`);
    assert.ok(recursive.some(([command, , mode, target]) => command === 'chmod' && mode === 'a-w' && target.startsWith(f.staging + sep)), 'the staging tree was never frozen');
    for (const call of recursive) assert.ok(call[3].startsWith(f.staging + sep) || call[3].startsWith(f.trash + sep), `a recursive ${call[0]} escaped the host work roots: ${call[3]}`);
  } finally { cleanup(f); }
});

test('an immediate second run is a no-op that touches nothing in the volume', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f, { now: new Date('2026-09-06T06:30:12.918Z') }));
    const before = snapshot(f.volume);
    const second = refresh(args(f), deps(f, { now: new Date('2026-09-06T08:45:00.000Z') }));
    assert.equal(second.changed, false);
    assert.equal(second.current, true);
    assert.deepEqual(snapshot(f.volume), before, 'the no-op path must not rewrite a single byte or mtime');
    // Nor append to the ledger: this path runs hundreds of times a day.
    assert.equal(ledgerOf(f).length, 1);
    assert.equal(main(args(f), deps(f)), 0);
  } finally { cleanup(f); }
});

test('a new commit on the edition branch moves the link and advances the identity record', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    writeCorpus(f.priv, EDITION, 'A LATER PRODUCER RUN');
    const second = commitAll(f.priv, `research: refresh ${EDITION}`);

    const result = refresh(args(f), deps(f));
    assert.equal(result.changed, true);
    assert.equal(result.commit, second);
    assert.equal(result.previousCommit, first.commit);
    assert.equal(identityOf(f).commit, second);
    assert.equal(liveTree(f), join(treeOf(f, second), EDITION));
    assert.match(readFileSync(join(f.volume, EDITION, 'grok', 'grok-rolling-0730.md'), 'utf8'), /A LATER PRODUCER RUN/u);
    assert.equal(ledgerOf(f).at(-1).previous_commit, first.commit);
  } finally { cleanup(f); }
});

test('an identity record that disagrees with the commit on the links is not current', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    writeCorpus(f.priv, EDITION, 'A LATER PRODUCER RUN');
    const second = commitAll(f.priv, 'research: later');
    refresh(args(f), deps(f));

    // A record that is internally perfect, points at a tree that exists, and
    // sits over links that resolve — for the commit before last. Only comparing
    // the record's commit to the resolved one catches it, and leaving it stale
    // is what makes an edition receipt cite research the reporters did not read.
    const stale = { ...identityOf(f), commit: first.commit, tree: `${TREES_DIR}/${first.commit}` };
    chmodSync(join(f.volume, 'CORPUS.json'), 0o644);
    writeFileSync(join(f.volume, 'CORPUS.json'), `${JSON.stringify(stale, null, 2)}\n`);
    const state = corpusCurrent(f.volume, { commit: second, edition: EDITION });
    assert.equal(state.current, false);
    assert.match(state.reason, /volume carries/u);
    assert.ok(state.reason.includes(first.commit.slice(0, 7)) && state.reason.includes(second.slice(0, 7)), 'the reason must name both commits');
    assert.equal(refresh(args(f), deps(f)).changed, true, 'the record must be republished rather than trusted');
    assert.equal(identityOf(f).commit, second);
  } finally { cleanup(f); }
});

test('the live edition path is never absent or dangling: the swap is a rename over it', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    writeCorpus(f.priv, EDITION, 'THE SWAP UNDER LOAD');
    const second = commitAll(f.priv, 'research: swap');
    const live = join(f.volume, EDITION);
    const oldTree = treeOf(f, first.commit), newTree = join(f.volume, TREES_DIR, second);

    const calls = [];
    const ops = {
      ...SYMLINK_OPS,
      unlink: (path) => { calls.push(['unlink', path]); return SYMLINK_OPS.unlink(path); },
      symlink: (to, from) => {
        const result = SYMLINK_OPS.symlink(to, from);
        if (from.includes(EDITION)) assert.equal(realpathSync(live), join(oldTree, EDITION), 'while the replacement link exists under another name, the live name still serves the old corpus');
        return result;
      },
      rename: (from, to) => {
        if (to === live) assert.equal(realpathSync(live), join(oldTree, EDITION), 'the live name must resolve to the OLD tree right up until the rename');
        const result = SYMLINK_OPS.rename(from, to);
        calls.push(['rename', from, to]);
        if (to === live) assert.equal(realpathSync(live), join(newTree, EDITION), 'and to the new tree immediately after it');
        return result;
      }
    };
    assert.equal(refresh(args(f), deps(f, { ops })).commit, second);
    assert.deepEqual(calls.filter(([name, path]) => name === 'unlink' && path === live), [], 'the live corpus name must never be unlinked');
    assert.ok(calls.some(([name, , to]) => name === 'rename' && to === live), 'the new corpus must become visible by rename(2) over the live name');
    assert.ok(calls.every(([name, path]) => name !== 'unlink' || path.endsWith('.tmp')), 'unlink may only ever touch a temporary name');
  } finally { cleanup(f); }
});

// FAIL CLOSED. Each of these is a corpus the producers really can cut, and each
// one must leave the newsroom on yesterday's good corpus rather than on a corpus
// a reporter cannot read.
const failsClosed = (name, breakIt, pattern) => test(`fail closed: ${name}`, () => {
  const f = fixture();
  try {
    const good = refresh(args(f), deps(f));
    const before = snapshot(f.volume);
    breakIt(f);
    const broken = commitAll(f.priv, `research: ${name}`);

    const alarms = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason, detail) => alarms.push([reason, detail]) })), 1, 'a corpus that cannot be read must exit non-zero');
    assert.throws(() => refresh(args(f), deps(f)), (error) => error instanceof CorpusError && pattern.test(error.message));

    assert.deepEqual(snapshot(f.volume), before, 'the previously good corpus must be exactly as it was');
    assert.equal(identityOf(f).commit, good.commit);
    assert.equal(liveTree(f), join(treeOf(f, good.commit), EDITION));
    assert.equal(existsSync(join(f.volume, TREES_DIR, broken)), false, 'an unvalidated tree must never become reachable');
    assert.deepEqual(readdirSync(f.staging), [], 'the staging tree must be removed, not left for the next run to reuse');
    assert.deepEqual(readdirSync(f.volume).filter((entry) => entry.startsWith('.staging')), []);
    assert.equal(alarms.length, 1, 'a corpus refusal reaches a person or nobody ever learns the paper went out on stale research');
    assert.deepEqual(alarms[0][0], 'corpus-refresh-failed');
    assert.equal(alarms[0][1].edition, EDITION);
  } finally { cleanup(f); }
});

failsClosed('a reporter has no desk index', (f) => rmSync(join(f.priv, EDITION, 'desks', 'foreman.index')), /missing 2026-09-06\/desks\/foreman\.index/u);

failsClosed('a desk index row points at a story file nobody wrote', (f) => {
  writeIndex(f.priv, EDITION, 'graves', [...STORIES.graves, 's-deadbeef']);
}, /DEFECT.*s-deadbeef/su);

failsClosed('a reporter has a desk index with no rows', (f) => writeIndex(f.priv, EDITION, 'tinkerton', []), /tinkerton\.index carries no rows/u);

failsClosed('a raw capture was re-run without re-preparing the corpus', (f) => {
  writeRaw(f.priv, EDITION, 'chatgpt', '0715', '# chatgpt\n\nA LATER CAPTURE THE PREPARED CORPUS DOES NOT COVER\n');
}, /stale digest/u);

test('a missing edition branch refuses and never falls back to main', () => {
  const f = fixture();
  try {
    // main carries a complete, valid corpus for UNCUT. Any fallback succeeds
    // loudly, so an empty volume afterwards is the proof there was none.
    assert.equal(git(f.priv, 'rev-parse', '--verify', 'main^{commit}').trim().length, 40);
    const uncut = args(f, [`--edition=${UNCUT}`]).filter((arg) => arg !== `--edition=${EDITION}`);
    assert.throws(() => refresh(uncut, deps(f)), (error) => error instanceof CorpusError
      && /refusing to fall back to another ref/u.test(error.message) && error.message.includes(`edition/${UNCUT}`));
    assert.equal(main(uncut, deps(f)), 1);
    assert.deepEqual(readdirSync(f.volume), [], 'a refusal must not leave a corpus behind');

    // The same refusal for an explicitly named branch that does not exist.
    assert.throws(() => refresh(args(f, ['--ref=edition/2099-01-01']), deps(f)), CorpusError);
    // And `main` is usable only when it is asked for by name.
    assert.equal(refresh(args(f, ['--ref=main']), deps(f)).changed, true);
    assert.equal(identityOf(f).ref, 'main');
    assert.match(readFileSync(join(f.volume, EDITION, 'grok', 'grok-rolling-0730.md'), 'utf8'), /MAIN RESEARCH/u);
  } finally { cleanup(f); }
});

test('garbage collection keeps the live tree and --keep spares, and removes the rest', () => {
  const f = fixture();
  try {
    const commits = [refresh(args(f, ['--keep=1']), deps(f)).commit];
    for (const mark of ['second producer run', 'third producer run']) {
      writeCorpus(f.priv, EDITION, mark);
      commitAll(f.priv, `research: ${mark}`);
      commits.push(refresh(args(f, ['--keep=1']), deps(f)).commit);
    }
    const [first, second, third] = commits;
    assert.equal(new Set(commits).size, 3);
    assert.deepEqual(readdirSync(join(f.volume, TREES_DIR)).sort(), [second, third].sort(), 'the live tree and one spare survive');
    assert.equal(ledgerOf(f).at(-1).trees_removed, 1);
    assert.equal(existsSync(join(f.volume, TREES_DIR, first)), false);
    assert.equal(liveTree(f), join(treeOf(f, third), EDITION));
    // The tree CORPUS.json names is never a candidate, whatever --keep says.
    assert.equal(identityOf(f).commit, third);
    assert.deepEqual(readdirSync(f.trash), [], 'retired trees are deleted out of the trash root, not parked in it');
  } finally { cleanup(f); }
});

test('a tree still reachable through an older date survives collection', () => {
  const f = fixture();
  try {
    const first = refresh(args(f, ['--keep=0']), deps(f));
    // The producers prune yesterday off the branch. Today's tree no longer
    // carries 2026-09-05, so its link keeps pointing into the previous tree —
    // and an agent asked for that date still has to be able to read it.
    rmSync(join(f.priv, PRIOR), { recursive: true, force: true });
    const second = commitAll(f.priv, 'research: prune yesterday');
    const result = refresh(args(f, ['--keep=0']), deps(f));

    assert.equal(result.commit, second);
    assert.deepEqual(result.treesRemoved, [], 'a tree an older date still resolves into is never a candidate');
    assert.deepEqual(readdirSync(join(f.volume, TREES_DIR)).sort(), [first.commit, second].sort());
    assert.equal(readlinkSync(join(f.volume, PRIOR)), `${TREES_DIR}/${first.commit}/${PRIOR}`);
    assert.ok(existsSync(join(f.volume, PRIOR, 'desks', 'foreman.index')), 'yesterday must still be readable through its link');
  } finally { cleanup(f); }
});

test('--check writes nothing and reports whether a refresh is needed', () => {
  const f = fixture();
  try {
    assert.equal(main(args(f, ['--check']), deps(f)), 1);
    assert.deepEqual(readdirSync(f.volume), [], '--check must not create anything');
    assert.equal(existsSync(f.ledger), false);

    refresh(args(f), deps(f));
    const before = snapshot(f.volume);
    assert.equal(main(args(f, ['--check']), deps(f)), 0);
    assert.deepEqual(snapshot(f.volume), before);

    writeCorpus(f.priv, EDITION, 'something newer');
    commitAll(f.priv, 'research: newer');
    assert.equal(main(args(f, ['--check']), deps(f)), 1, 'a stale corpus must exit non-zero so the timer can see it');
    assert.deepEqual(snapshot(f.volume), before);
  } finally { cleanup(f); }
});

test('a volume root the container cannot boot on stops the refresh before it writes', () => {
  const f = fixture();
  try {
    chmodSync(f.volume, 0o555);
    assert.throws(() => refresh(args(f), deps(f)), (error) => error instanceof CorpusError && /must be 0755/u.test(error.message));
    chmodSync(f.volume, VOLUME_ROOT_MODE);
    assert.deepEqual(readdirSync(f.volume), []);
    assert.deepEqual(readdirSync(f.work).filter((name) => name !== 'trash' && name !== 'staging'), []);
  } finally { chmodSync(f.volume, VOLUME_ROOT_MODE); cleanup(f); }
});

test('the mutating run holds the same flock(2) the recreate and release units take', () => {
  const f = fixture();
  try {
    const lock = join(f.work, 'corpus.lock');
    const locked = args(f, [`--lock=${lock}`]).filter((arg) => arg !== '--no-lock');
    const spawned = [];
    const spawn = (command, commandArgs, options) => { spawned.push({ command, commandArgs, options }); return { status: 0 }; };
    assert.equal(main(locked, deps(f, { spawn })), 0);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, 'flock');
    assert.deepEqual(spawned[0].commandArgs.slice(0, 4), ['-n', '-E', String(LOCK_BUSY_EXIT), lock]);
    assert.equal(spawned[0].commandArgs[4], process.execPath);
    assert.equal(spawned[0].options.env[LOCK_ENV], lock, 'the child must know the lock is already held, or it would relay forever');
    assert.deepEqual(readdirSync(f.volume), [], 'the parent process must not write the volume itself');

    // A busy lock is a quiet no-op: the holder is doing this run's work.
    const busy = [];
    assert.equal(main(locked, deps(f, { spawn: () => ({ status: LOCK_BUSY_EXIT }), log: (line) => busy.push(line) })), 0);
    assert.ok(busy.some((line) => line.includes(lock)), 'a run that stood down must say which lock it stood down for');
    // Being unable to lock at all is a refusal, never an unlocked run.
    assert.equal(main(locked, deps(f, { spawn: () => ({ error: new Error('spawn flock ENOENT') }) })), 1);
    assert.deepEqual(readdirSync(f.volume), []);
    // The child, which already holds the lock, does the work.
    assert.equal(main(locked, deps(f, { env: { [LOCK_ENV]: lock }, spawn })), 0);
    assert.equal(spawned.length, 1, 'the child must not relay a second time');
    assert.equal(identityOf(f).commit, f.commit);
  } finally { cleanup(f); }
});

test('a tree already extracted for this commit is reused rather than re-extracted', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const tree = treeOf(f, f.commit);
    const before = statSync(tree).mtimeMs;
    // Drop the identity record: the no-op check fails, but the content is there.
    rmSync(join(f.volume, 'CORPUS.json'));
    const commands = [];
    const exec = (command, commandArgs, options) => { commands.push(commandArgs.includes('archive') ? 'archive' : command); return hostExec(command, commandArgs, options); };
    const result = refresh(args(f), deps(f, { exec }));
    assert.equal(commands.includes('archive'), false, `a tree that is already on disk must not be extracted again: ${commands.join(', ')}`);
    assert.equal(result.changed, true);
    assert.equal(result.linksMoved, 0, 'the links already point at this tree');
    assert.equal(statSync(tree).mtimeMs, before, 'the tree must not be rewritten');
    assert.equal(identityOf(f).commit, f.commit);
    assert.deepEqual(readdirSync(f.staging), []);
  } finally { cleanup(f); }
});
