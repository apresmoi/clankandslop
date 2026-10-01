import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS_IDENTITY_VERSION, CorpusError } from './corpus-contract.mjs';
import {
  TREES_DIR, VOLUME_ROOT_MODE, applyOwner, assertRealDirectory, assertSameDevice, assertTreesDirectory,
  assertVolumeRoot, auditVolumeRoot, collectGarbage, corpusIdentity, freeze, pointAtTree, readIdentity,
  removeTree, resolveCorpusLink, SYMLINK_OPS, writeIdentity
} from './corpus-volume.mjs';

const EDITION = '2026-09-06';
const OWNER = `${process.getuid()}:${process.getgid()}`;
const commitOf = (seed) => seed.repeat(40).slice(0, 40);

// A volume laid out the way the refresher lays a real one out, minus the git
// repo: trees/<commit>/<date> content plus the <date> symlinks into it.
const volumeFixture = ({ commits = ['a'], dates = [EDITION] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'clank-corpus-volume-'));
  const volume = join(root, 'volume');
  const work = join(root, 'work');
  mkdirSync(volume, { recursive: true });
  chmodSync(volume, VOLUME_ROOT_MODE);
  mkdirSync(work, { recursive: true });
  for (const seed of commits) {
    for (const date of dates) {
      mkdirSync(join(volume, TREES_DIR, commitOf(seed), date, 'desks'), { recursive: true });
      writeFileSync(join(volume, TREES_DIR, commitOf(seed), date, 'desks', 'foreman.index'), `# ${seed}\n`);
    }
  }
  // realpath'd because this platform reaches its temp directory through a
  // symlink, and every assertion here compares resolved paths.
  return { root, volume: realpathSync(volume), work: realpathSync(work), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('the volume root is read before any write, and a mode the container cannot boot on is a refusal', () => {
  const fixture = volumeFixture();
  try {
    assert.equal(assertVolumeRoot(fixture.volume).mode & 0o7777, VOLUME_ROOT_MODE);
    // 0555 is the shape a well-meaning `chmod -R a-w` leaves behind. The
    // container's startup guard then refuses the volume outright, so every
    // agent fails to start on its next recreate.
    chmodSync(fixture.volume, 0o555);
    assert.throws(() => assertVolumeRoot(fixture.volume), (error) => error instanceof CorpusError
      && /is mode 0555, must be 0755/u.test(error.message) && error.message.includes(`chmod 0755 ${fixture.volume}`));
    chmodSync(fixture.volume, 0o700);
    assert.throws(() => assertVolumeRoot(fixture.volume), CorpusError);
    chmodSync(fixture.volume, VOLUME_ROOT_MODE);
    assert.throws(() => assertVolumeRoot(join(fixture.root, 'nowhere')), (error) => /does not exist/u.test(error.message));
  } finally { chmodSync(fixture.volume, VOLUME_ROOT_MODE); fixture.cleanup(); }
});

test('staging and trash must share the volume filesystem, because every swap is a rename(2)', () => {
  const fixture = volumeFixture();
  try {
    assert.doesNotThrow(() => assertSameDevice(fixture.volume, fixture.work, 'staging root'));
    // /dev is a different filesystem on every host this runs on, which is the
    // cheapest honest stand-in for a staging root on the wrong mount.
    assert.throws(() => assertSameDevice(fixture.volume, '/dev', 'staging root'), (error) => error instanceof CorpusError
      && /staging root \/dev is on device/u.test(error.message) && /rename\(2\)/u.test(error.message));
  } finally { fixture.cleanup(); }
});

test('a recursive ownership or mode change can never be aimed at the volume root', () => {
  const fixture = volumeFixture();
  try {
    // One `chown -R` over the volume root rewrites .spawnfile-resource-identity
    // and bricks the organization, so the target is checked rather than trusted.
    const calls = [];
    const exec = (command, args) => { calls.push([command, ...args]); };
    for (const target of [fixture.volume, fixture.root]) {
      assert.throws(() => applyOwner(target, OWNER, { volume: fixture.volume, exec }), (error) => error instanceof CorpusError && /spawnfile-resource-identity/u.test(error.message));
      assert.throws(() => freeze(target, { volume: fixture.volume, exec }), CorpusError);
    }
    assert.deepEqual(calls, [], 'a refused target must not reach chown or chmod at all');
    applyOwner(fixture.work, OWNER, { volume: fixture.volume, exec });
    freeze(fixture.work, { volume: fixture.volume, exec });
    assert.deepEqual(calls, [['chown', '-R', OWNER, fixture.work], ['chmod', '-R', 'a-w', fixture.work]]);
  } finally { fixture.cleanup(); }
});

test('the live name is replaced by rename(2) and never unlinked', () => {
  const fixture = volumeFixture({ commits: ['a', 'b'] });
  try {
    const target = (seed) => `${TREES_DIR}/${commitOf(seed)}/${EDITION}`;
    assert.equal(pointAtTree(fixture.volume, EDITION, target('a'), { tmpDir: fixture.work }), true);
    assert.equal(readlinkSync(join(fixture.volume, EDITION)), target('a'));
    // Unchanged is a no-op: nothing is created, nothing is renamed.
    assert.equal(pointAtTree(fixture.volume, EDITION, target('a'), { tmpDir: fixture.work }), false);

    const live = join(fixture.volume, EDITION);
    const calls = [];
    const ops = {
      ...SYMLINK_OPS,
      unlink: (path) => { calls.push(['unlink', path]); return SYMLINK_OPS.unlink(path); },
      symlink: (to, from) => {
        calls.push(['symlink', from]);
        const result = SYMLINK_OPS.symlink(to, from);
        // Still the OLD tree while the replacement exists under another name.
        assert.equal(realpathSync(live), join(fixture.volume, TREES_DIR, commitOf('a'), EDITION));
        return result;
      },
      rename: (from, to) => {
        calls.push(['rename', from, to]);
        assert.equal(realpathSync(live), join(fixture.volume, TREES_DIR, commitOf('a'), EDITION), 'the live name must resolve to the old tree right up until the rename');
        const result = SYMLINK_OPS.rename(from, to);
        assert.equal(realpathSync(live), join(fixture.volume, TREES_DIR, commitOf('b'), EDITION), 'and to the new tree immediately after it');
        return result;
      }
    };
    assert.equal(pointAtTree(fixture.volume, EDITION, target('b'), { ops, tmpDir: fixture.work }), true);
    assert.deepEqual(calls.filter(([name, path]) => name === 'unlink' && path === live), [], 'the live corpus name must never be unlinked');
    assert.ok(calls.some(([name, , to]) => name === 'rename' && to === live), 'the new link must become visible by rename');
    assert.ok(calls.every(([name, path]) => name !== 'unlink' || path.endsWith('.tmp')), 'unlink may only ever touch the temporary name');
    // The temporary name never appears inside the volume at all.
    assert.deepEqual(readdirSync(fixture.volume).filter((name) => name.includes('.tmp')), []);
  } finally { fixture.cleanup(); }
});

// The refusal is right -- the host must not unlink research it did not write --
// and on its own it is also a dead end: nothing in this newsroom can clear it, so
// a refusal that neither pages nor says what clears it leaves the dated corpus
// unreachable for as long as nobody happens to read a log.
test('a real directory where a corpus link belongs is a refusal, and it pages with the one command that clears it', () => {
  const fixture = volumeFixture();
  try {
    const planted = join(fixture.volume, EDITION);
    mkdirSync(planted);
    assert.throws(() => pointAtTree(fixture.volume, EDITION, `${TREES_DIR}/${commitOf('a')}/${EDITION}`, { tmpDir: fixture.work }),
      (error) => {
        assert.ok(error instanceof CorpusError && /is a real directory/u.test(error.message), error.message);
        assert.equal(error.alarm, true, 'the refresher alarms only on an error it recognizes, so an unmarked refusal is exit 1 with no page');
        assert.ok(error.message.includes(`mv -- ${planted}`), `the refusal must carry the command that clears it: ${error.message}`);
        return true;
      });
    // And it is still a refusal: nothing was unlinked, replaced or moved.
    assert.equal(statSync(planted).isDirectory(), true);
  } finally { fixture.cleanup(); }
});

test('an identity record is validated on disk before it is published, and never after', () => {
  const fixture = volumeFixture();
  try {
    const record = corpusIdentity({ commit: commitOf('a'), ref: `edition/${EDITION}`, edition: EDITION, fetchedAt: `${EDITION}T07:00:00Z`, editionsPresent: [EDITION], sourceCount: 2 });
    assert.deepEqual(Object.keys(record), ['version', 'commit', 'ref', 'edition', 'fetched_at', 'tree', 'editions_present', 'source_count']);
    assert.equal(record.version, CORPUS_IDENTITY_VERSION);
    writeIdentity(fixture.volume, record, { edition: EDITION, owner: OWNER, tmpDir: fixture.work });
    assert.deepEqual(readIdentity(fixture.volume), record);
    assert.equal(statSync(join(fixture.volume, 'CORPUS.json')).mode & 0o7777, 0o444);

    // A record for another day, or one missing a field, is never written at all.
    const before = readFileSync(join(fixture.volume, 'CORPUS.json'), 'utf8');
    assert.throws(() => writeIdentity(fixture.volume, { ...record, edition: '2026-09-05' }, { edition: EDITION, owner: OWNER, tmpDir: fixture.work }),
      (error) => error instanceof CorpusError && /refusing to publish an invalid/u.test(error.message));
    assert.throws(() => writeIdentity(fixture.volume, { ...record, commit: 'short' }, { edition: EDITION, owner: OWNER, tmpDir: fixture.work }), CorpusError);
    assert.equal(readFileSync(join(fixture.volume, 'CORPUS.json'), 'utf8'), before, 'a refused record must leave the published one untouched');
    assert.deepEqual(readdirSync(fixture.volume).filter((name) => name.includes('.tmp')), []);
  } finally { fixture.cleanup(); }
});

test('a retired tree leaves the volume by one rename and is deleted outside it', () => {
  const fixture = volumeFixture({ commits: ['a', 'b'] });
  try {
    const trash = join(fixture.work, 'trash');
    mkdirSync(trash, { recursive: true });
    symlinkSync(`${TREES_DIR}/${commitOf('b')}/${EDITION}`, join(fixture.volume, EDITION));
    const removed = [];
    // Standing in for the recursive delete so the parked directory survives for
    // inspection: the point of the test is WHERE it was deleted from.
    const swept = collectGarbage(fixture.volume, { keep: 0, known: [commitOf('a'), commitOf('b')], live: [commitOf('b')], trash, remove: (target) => removed.push(target) });
    assert.deepEqual(swept.removed, [commitOf('a')]);
    assert.deepEqual(swept.unknown, []);
    assert.equal(existsSync(join(fixture.volume, TREES_DIR, commitOf('a'))), false, 'the entry must be gone from the volume');
    assert.equal(removed.length, 1);
    assert.ok(removed[0].startsWith(`${trash}${'/'}`), `the doomed tree must be deleted from the trash root, not from inside the volume: ${removed[0]}`);
    assert.ok(existsSync(join(removed[0], EDITION, 'desks', 'foreman.index')), 'the tree must arrive in the trash whole, having been renamed rather than copied');
    assert.ok(existsSync(join(fixture.volume, TREES_DIR, commitOf('b'))), 'the live tree is never a candidate');
  } finally { fixture.cleanup(); }
});

test('garbage collection protects every tree a dated link resolves into, and keeps the newest spares', () => {
  const fixture = volumeFixture({ commits: ['a', 'b', 'c', 'd'] });
  try {
    const trash = join(fixture.work, 'trash');
    mkdirSync(trash, { recursive: true });
    // mtime order oldest -> newest: a, b, c, d. Only d is referenced. Set
    // explicitly, because four directories created in the same millisecond
    // would make "the newest spares" a coin toss.
    for (const [index, seed] of ['a', 'b', 'c', 'd'].entries()) {
      const when = new Date(Date.now() - (10 - index) * 60_000);
      utimesSync(join(fixture.volume, TREES_DIR, commitOf(seed)), when, when);
    }
    symlinkSync(`${TREES_DIR}/${commitOf('d')}/${EDITION}`, join(fixture.volume, EDITION));
    const swept = collectGarbage(fixture.volume, { keep: 1, known: ['a', 'b', 'c', 'd'].map(commitOf), live: [commitOf('d')], trash });
    assert.deepEqual([...swept.removed].sort(), [commitOf('a'), commitOf('b')], 'the newest unreferenced tree is kept, the rest go');
    assert.deepEqual(readdirSync(join(fixture.volume, TREES_DIR)).sort(), [commitOf('c'), commitOf('d')].sort());
    assert.deepEqual(readdirSync(trash), [], 'nothing is left behind in the trash root');
  } finally { fixture.cleanup(); }
});

test('resolveCorpusLink reads a dated corpus path the way an agent would', () => {
  const fixture = volumeFixture();
  try {
    assert.equal(resolveCorpusLink(fixture.volume, EDITION), null);
    symlinkSync(`${TREES_DIR}/${commitOf('a')}/${EDITION}`, join(fixture.volume, EDITION));
    assert.equal(resolveCorpusLink(fixture.volume, EDITION), realpathSync(join(fixture.volume, TREES_DIR, commitOf('a'), EDITION)));
    // A dangling link and a real directory both read as "no corpus here".
    rmSync(join(fixture.volume, EDITION));
    symlinkSync(`${TREES_DIR}/${commitOf('z')}/${EDITION}`, join(fixture.volume, EDITION));
    assert.equal(resolveCorpusLink(fixture.volume, EDITION), null);
    rmSync(join(fixture.volume, EDITION));
    mkdirSync(join(fixture.volume, EDITION));
    assert.equal(resolveCorpusLink(fixture.volume, EDITION), null);
    assert.equal(lstatSync(join(fixture.volume, EDITION)).isSymbolicLink(), false);
  } finally { fixture.cleanup(); }
});

// FABLE'S REPRO, AS A TEST. `collectGarbage` never lstat'd `trees/`, so an agent
// -- which owns the volume root -- could point that name at any absolute host
// path and the ROOT-RUN refresher would rename entries out of it and rmSync them.
// A root-privileged delete whose target an agent chose.
test('a trees symlink makes every volume operation refuse, and deletes nothing', () => {
  const fixture = volumeFixture({ commits: [] });
  try {
    // Shaped like the host path an agent would actually aim at: read-only files it
    // must not be able to chmod, and a DIRECTORY whose name the sweep would accept
    // as a retiring tree, which is what makes the rename-and-rmSync reachable.
    const bait = join(fixture.work, 'etc');
    mkdirSync(join(bait, commitOf('a')), { recursive: true });
    for (const name of ['passwd', 'shadow', `${commitOf('a')}/hosts`]) writeFileSync(join(bait, name), `do not delete ${name}\n`, { mode: 0o444 });
    symlinkSync(bait, join(fixture.volume, TREES_DIR));

    // Every operation is attempted for real and its outcome recorded, because the
    // assertion that matters is that the BAIT SURVIVED -- asserting the refusal
    // first would let a regression abort the test before the harm is checked.
    const errors = [];
    const attempt = (label, run) => { try { run(); errors.push([label, null]); } catch (error) { errors.push([label, error]); } };
    attempt('assertTreesDirectory', () => assertTreesDirectory(fixture.volume));
    attempt('collectGarbage', () => collectGarbage(fixture.volume, { keep: 0, known: [commitOf('a')], live: [], trash: fixture.work }));
    // `chmod -R u+w` follows a symlink and would restore write across the target,
    // so the thaw-then-delete has to refuse on its own and not only via the sweep.
    attempt('removeTree', () => removeTree(join(fixture.volume, TREES_DIR), { volume: fixture.volume }));

    for (const name of ['passwd', 'shadow', `${commitOf('a')}/hosts`]) assert.ok(existsSync(join(bait, name)), `${name} was deleted through the symlink an agent planted`);
    assert.deepEqual(readdirSync(bait).sort(), [commitOf('a'), 'passwd', 'shadow'].sort());
    // `chmod -R u+w` follows a symlinked target, so the thaw is harm on its own.
    for (const name of ['passwd', `${commitOf('a')}/hosts`]) assert.equal(statSync(join(bait, name)).mode & 0o222, 0, `${name} was chmodded through the symlink`);
    assert.deepEqual(readdirSync(fixture.work).filter((name) => name.startsWith(commitOf('a'))), [], 'nothing may have been parked in the trash root either');
    for (const [label, error] of errors) {
      assert.ok(error instanceof CorpusError, `${label} must refuse, not proceed: ${error ?? 'it returned normally'}`);
      assert.match(error.message, /symlink/u, label);
    }
  } finally { fixture.cleanup(); }
});

test('an entry under trees/ the host did not land is reported and left exactly where it is', () => {
  const fixture = volumeFixture({ commits: ['a', 'b'] });
  try {
    const trash = join(fixture.work, 'trash');
    mkdirSync(trash, { recursive: true });
    // `b` is a tree the host knows nothing about: either somebody else wrote it,
    // or this host lost its record. Deleting it would destroy the evidence of the
    // first case and twelve readers' corpus in the second.
    const swept = collectGarbage(fixture.volume, { keep: 0, known: [commitOf('a')], live: [], trash });
    assert.deepEqual(swept.removed, [commitOf('a')]);
    assert.deepEqual(swept.unknown, [commitOf('b')]);
    assert.ok(existsSync(join(fixture.volume, TREES_DIR, commitOf('b'), EDITION, 'desks', 'foreman.index')));
    // An absent `known` is never a sweep: it would mean the caller never consulted
    // the host record, and falling through to a readdir is the defect itself.
    assert.throws(() => collectGarbage(fixture.volume, { keep: 0, live: [], trash }), (error) => error instanceof CorpusError && /list of landed tree names/u.test(error.message));
  } finally { fixture.cleanup(); }
});

test('the volume root is audited against the only names this host writes, and nothing is deleted', () => {
  const fixture = volumeFixture();
  try {
    assert.deepEqual(auditVolumeRoot(fixture.volume), []);
    writeFileSync(join(fixture.volume, '.spawnfile-resource-identity'), '{}\n');
    writeFileSync(join(fixture.volume, 'CORPUS.json'), '{}\n');
    symlinkSync(`${TREES_DIR}/${commitOf('a')}/${EDITION}`, join(fixture.volume, EDITION));
    assert.deepEqual(auditVolumeRoot(fixture.volume), [], 'the sentinel, the identity record, trees/ and a dated symlink are all expected');

    writeFileSync(join(fixture.volume, 'notes.txt'), 'an agent was here\n');
    mkdirSync(join(fixture.volume, '2026-09-07'));
    const findings = auditVolumeRoot(fixture.volume);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((text) => /^2026-09-07 is a real directory where a corpus symlink belongs$/u.test(text)), findings.join('; '));
    assert.ok(findings.some((text) => /^notes\.txt is a name this host never writes \(file\)$/u.test(text)), findings.join('; '));
    // Reported, never repaired: a `chmod`/`rm` sweep here is what would take the
    // root-owned identity sentinel with it and brick every container.
    assert.ok(existsSync(join(fixture.volume, 'notes.txt')) && existsSync(join(fixture.volume, '2026-09-07')));
  } finally { fixture.cleanup(); }
});

test('assertRealDirectory accepts the directory the host made, refuses anything else, and tolerates absence', () => {
  const fixture = volumeFixture();
  try {
    assert.equal(assertRealDirectory(join(fixture.volume, TREES_DIR), 'trees').isDirectory(), true);
    assert.equal(assertRealDirectory(join(fixture.volume, 'nowhere'), 'a tree'), null, 'absent is the first run, not a refusal');
    writeFileSync(join(fixture.volume, 'afile'), 'x');
    assert.throws(() => assertRealDirectory(join(fixture.volume, 'afile'), 'a tree'), (error) => error instanceof CorpusError && /is a file, not a directory/u.test(error.message));
  } finally { fixture.cleanup(); }
});
