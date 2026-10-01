// What happens when the corpus volume is written by something that is not the
// host, because it can be: `mode: mutable` is forced (readonly kills the
// container), the compiler chowns the whole volume to uid 2000 on every start,
// and the ownership guard then demands a uid-owned 0755 root. Every one of these
// was reproduced in the live production container before it was written down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REASONS, parseArgs, raise } from './alarm.mjs';
import { CorpusError } from './corpus-contract.mjs';
import { TREES_DIR, hostExec } from './corpus-volume.mjs';
import { CORPUS_ALARM_REASONS, REFUSAL_REASON, TAMPER_REASON } from './corpus-verify.mjs';
import { main, refresh } from './corpus-refresh.mjs';
import { EDITION, PRIOR, UNCUT, args, cleanup, commission, commitAll, deps, fixture, identityOf, landedOf, ledgerOf, snapshot, writeCorpus } from './corpus-refresh.fixture.mjs';

const CORPUS = 'CORPUS.json';
const storyFile = (f, edition = EDITION) => join(f.volume, TREES_DIR, landedOf(f).editions[edition].commit, edition, 'stories', 's-11111111.md');
const withWritable = (file, change) => {
  const directory = join(file, '..');
  const dirMode = statSync(directory).mode & 0o7777, fileMode = statSync(file).mode & 0o7777;
  chmodSync(directory, 0o755);
  chmodSync(file, 0o644);
  change();
  chmodSync(file, fileMode);
  chmodSync(directory, dirMode);
};

// FIX 1. `corpusCurrent` used to read CORPUS.json and the dated symlink to decide
// whether to act. An agent owns both names, so the host was taking a decision —
// and then a root-privileged action — from an input twelve agents could write.
test('the no-op path takes no decision from CORPUS.json, however it is forged', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const landed = landedOf(f);

    // Every shape an agent can leave this file in: gone, garbage, and a perfectly
    // valid record for a commit that is not mounted.
    const published = identityOf(f);
    const forgeries = [
      () => rmSync(join(f.volume, CORPUS)),
      () => writeFileSync(join(f.volume, CORPUS), 'forged\n', { mode: 0o644 }),
      () => writeFileSync(join(f.volume, CORPUS), `${JSON.stringify({ ...published, commit: 'b'.repeat(40), tree: `${TREES_DIR}/${'b'.repeat(40)}` }, null, 2)}\n`, { mode: 0o644 })
    ];
    for (const forge of forgeries) {
      try { chmodSync(join(f.volume, CORPUS), 0o644); } catch { /* the previous forgery removed it */ }
      forge();
      // The decision is unchanged: the host record says this edition is landed at
      // this commit, so there is nothing to refresh.
      const quiet = refresh(args(f, ['--no-verify']), deps(f));
      assert.deepEqual([quiet.current, quiet.changed], [true, false], 'a forged CORPUS.json must not make the host re-land, re-link or sweep anything');
      assert.deepEqual(landedOf(f), landed, 'nor rewrite the host record');
    }
  } finally { cleanup(f); }
});

test('a lost host record is recoverable: the next run re-lands and never infers it from the volume', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    rmSync(f.landed);
    rmSync(join(f.work, 'manifests'), { recursive: true });

    const lines = [];
    const again = refresh(args(f), deps(f, { log: (line) => lines.push(line) }));
    assert.equal(again.changed, true, 'with no record, nothing is landed, so the corpus is landed again');
    assert.equal(again.previousCommit, null, 'and the host must not pretend to remember what it landed before');
    assert.ok(lines.some((line) => /re-extracting/u.test(line)), `an unverifiable tree already in the volume is re-extracted, not adopted: ${lines.join(' | ')}`);
    assert.equal(landedOf(f).editions[EDITION].commit, first.commit);
    assert.match(readFileSync(join(f.volume, EDITION, 'grok', 'grok-rolling-0730.md'), 'utf8'), /EDITION BRANCH RESEARCH/u);
  } finally { cleanup(f); }
});

test('an unparseable host record is announced and treated as nothing landed, never as a reason to stop', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    writeFileSync(f.landed, '{ truncated\n');
    const lines = [];
    assert.equal(refresh(args(f), deps(f, { log: (line) => lines.push(line) })).changed, true);
    assert.ok(lines.some((line) => /ignoring the host record/u.test(line)), lines.join(' | '));
  } finally { cleanup(f); }
});

// FIX 2, end to end. The fable repro through the real entrypoint: the refresher
// runs as root, so following this symlink is a root-privileged delete whose
// target an agent chose.
test('a trees symlink stops the refresher dead and deletes nothing it points at', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const bait = join(f.root, 'bait');
    mkdirSync(join(bait, 'nested'), { recursive: true });
    for (const name of ['passwd', 'shadow', 'nested/hosts']) writeFileSync(join(bait, name), `do not delete ${name}\n`);

    // An agent owns the volume root, so it can move `trees` aside and put its own
    // name there. Verified in production.
    const trees = join(f.volume, TREES_DIR);
    const parked = join(f.root, 'parked-trees');
    renameSync(trees, parked);
    symlinkSync(bait, trees);

    writeCorpus(f.priv, EDITION, 'A LATER PRODUCER RUN');
    commitAll(f.priv, 'research: later');
    const alarms = [];
    const exit = main(args(f), deps(f, { alarm: (reason, detail) => alarms.push([reason, detail]) }));
    let refusal = null;
    try { refresh(args(f), deps(f)); } catch (error) { refusal = error; }

    // Checked BEFORE the refusal itself: if this guard is ever removed, the test
    // must fail on the root-privileged delete, not on a missing error message.
    for (const name of ['passwd', 'shadow', 'nested/hosts']) assert.ok(existsSync(join(bait, name)), `${name} was deleted through the symlink an agent planted`);
    assert.equal(exit, 1, 'a volume written by something else is a refusal, not a repair');
    assert.ok(refusal instanceof CorpusError && /is a symlink/u.test(refusal.message), `${refusal}`);
    assert.equal(lstatSync(trees).isSymbolicLink(), true, 'and the symlink itself is left as evidence, not silently repaired');
    assert.ok(existsSync(join(parked, landedOf(f).editions[EDITION].commit, EDITION)), 'the real trees directory is untouched');
  } finally { try { unlinkSync(join(f.volume, TREES_DIR)); } catch { /* the symlink was never created */ } cleanup(f); }
});

// FIX 3. Brass binds a corpus commit into every assignment receipt. Move the link
// afterwards and the receipt cites research nobody read, and one reporter can
// resolve a desk index from one commit and a story file from another.
test('a commissioned edition keeps its corpus; an uncommissioned one follows the branch', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    commission(f, EDITION, first.commit);
    writeCorpus(f.priv, EDITION, 'RESEARCH THAT ARRIVED AFTER THE LINEUP WAS RECORDED');
    writeCorpus(f.priv, PRIOR, 'and a correction to yesterday');
    const second = commitAll(f.priv, 'research: after commissioning');

    const lines = [];
    const result = refresh(args(f), deps(f, { log: (line) => lines.push(line) }));
    // A success, not a failure: refusing the whole run would deadlock the refresher
    // for the rest of the day, every two minutes, for a corpus that is correct.
    assert.equal(result.changed, true);
    assert.equal(result.frozen, true);
    assert.ok(lines.some((line) => line === `edition ${EDITION} is commissioned against ${first.commit.slice(0, 7)}; its corpus is frozen`), lines.join(' | '));

    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`, "the commissioned edition's link must not move");
    assert.match(readFileSync(join(f.volume, EDITION, 'grok', 'grok-rolling-0730.md'), 'utf8'), /EDITION BRANCH RESEARCH/u);
    // The new tree still LANDS, and every other date still moves.
    assert.ok(existsSync(join(f.volume, TREES_DIR, second)), 'the new tree must land even though one date is frozen');
    assert.equal(readlinkSync(join(f.volume, PRIOR)), `${TREES_DIR}/${second}/${PRIOR}`, 'a date with no assignments follows the branch');
    // Provenance stays truthful: CORPUS.json describes what is mounted.
    assert.equal(identityOf(f).commit, first.commit, 'CORPUS.json must not name a commit the frozen edition does not serve');
    assert.deepEqual(ledgerOf(f).at(-1).frozen_editions, [EDITION]);
    assert.deepEqual(landedOf(f).editions[EDITION].frozen.commits, [first.commit]);

    // And the frozen tree is never collected, whatever --keep says.
    writeCorpus(f.priv, EDITION, 'a third producer run');
    const third = commitAll(f.priv, 'research: third');
    // The intermediate tree nothing references goes; the FROZEN one never does,
    // whatever --keep says, because twelve reporters are reading it right now.
    const swept = refresh(args(f, ['--keep=0']), deps(f));
    assert.deepEqual(swept.treesRemoved, [second], 'a tree no date resolves into and nothing is frozen at is collectable');
    assert.ok(existsSync(join(f.volume, TREES_DIR, first.commit, EDITION, 'desks', 'foreman.index')), "a frozen edition's tree is never garbage");
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`);
    assert.equal(readlinkSync(join(f.volume, PRIOR)), `${TREES_DIR}/${third}/${PRIOR}`);

    // The frozen state is a stable no-op, not a run that re-lands forever.
    const before = snapshot(f.volume);
    const quiet = refresh(args(f), deps(f));
    assert.deepEqual([quiet.current, quiet.changed, quiet.frozen], [true, false, true]);
    assert.deepEqual(snapshot(f.volume), before);
  } finally { cleanup(f); }
});

test('an edition commissioned before this host landed anything is served rather than left dark', () => {
  const f = fixture();
  try {
    commission(f, EDITION, 'c'.repeat(40));
    const lines = [];
    assert.equal(refresh(args(f), deps(f, { log: (line) => lines.push(line) })).changed, true);
    assert.ok(lines.some((line) => /is commissioned but this host has no record/u.test(line)), lines.join(' | '));
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${f.commit}/${EDITION}`, 'no corpus at all is worse than one whose receipt must be re-cut');
  } finally { cleanup(f); }
});

// FIX 4. The mount is agent-writable and nothing can change that, so the only
// honest guarantee is that tampering is noticed within one poll and healed.
test('content rewritten inside a frozen tree is detected, alarmed and re-landed from git', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    const story = storyFile(f);
    const original = readFileSync(story, 'utf8');
    // A SAME-LENGTH rewrite with the mode put back: nothing the cheap stat sweep
    // can settle on its own, so it is the case the deep pass against
    // `git ls-tree` exists for.
    const forged = 'x'.repeat(original.length);
    withWritable(story, () => writeFileSync(story, forged));
    assert.equal(readFileSync(story, 'utf8'), forged, 'the owner really can rewrite an a-w file it owns');
    assert.equal(readFileSync(story, 'utf8').length, original.length);
    assert.equal(statSync(story).mode & 0o7777, 0o444);

    const alarms = [], lines = [];
    assert.equal(main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => alarms.push([reason, detail]) })), 0,
      'a corpus that healed itself is a success, and a silent one would be the worst of both');
    assert.equal(alarms.length, 1, 'tampering that nobody is told about is tampering that works');
    assert.equal(alarms[0][0], TAMPER_REASON);
    assert.ok(alarms[0][1].detail.includes(`${EDITION}/stories/s-11111111.md`), `the alarm must name the paths: ${alarms[0][1].detail}`);
    assert.ok(lines.some((line) => /^re-landing /u.test(line)), lines.join(' | '));

    assert.equal(readFileSync(story, 'utf8'), original, 'the newsroom must heal itself back to what git says the corpus is');
    assert.equal(landedOf(f).editions[EDITION].commit, first.commit);
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`);
    // And the healed corpus is clean on the next poll rather than alarming forever.
    const after = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason) => after.push(reason) })), 0);
    assert.deepEqual(after, []);
  } finally { cleanup(f); }
});

test('a file left writable, a file added and a file removed inside the corpus are all detected', () => {
  for (const [name, tamper] of [
    ['chmod u+w and overwrite', (f) => { const story = storyFile(f); chmodSync(join(story, '..'), 0o755); chmodSync(story, 0o644); writeFileSync(story, 'tampered\n'); }],
    ['an extra file nobody wrote', (f) => { const dir = join(storyFile(f), '..'); chmodSync(dir, 0o755); writeFileSync(join(dir, 's-99999999.md'), 'planted\n'); }],
    ['a story file unlinked', (f) => { const story = storyFile(f); chmodSync(join(story, '..'), 0o755); rmSync(story); }]
  ]) {
    const f = fixture();
    try {
      refresh(args(f), deps(f));
      tamper(f);
      const alarms = [];
      assert.equal(main(args(f), deps(f, { alarm: (reason, detail) => alarms.push([reason, detail]) })), 0, name);
      assert.equal(alarms.length, 1, `${name}: no alarm`);
      assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n', `${name}: the corpus did not heal`);
      assert.equal(existsSync(join(storyFile(f), '..', 's-99999999.md')), false, `${name}: a planted file survived the re-land`);
      assert.equal(statSync(storyFile(f)).mode & 0o222, 0, `${name}: the healed tree is writable again`);
    } finally { cleanup(f); }
  }
});

test('a forged CORPUS.json and a redirected dated link are detected and restored without re-extracting', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    const published = readFileSync(join(f.volume, CORPUS), 'utf8');
    chmodSync(join(f.volume, CORPUS), 0o644);
    writeFileSync(join(f.volume, CORPUS), `${JSON.stringify({ ...identityOf(f), edition: PRIOR }, null, 2)}\n`);
    // An agent owns the volume root, so it can replace a dated link as easily.
    unlinkSync(join(f.volume, PRIOR));
    symlinkSync(`${TREES_DIR}/${first.commit}/${EDITION}`, join(f.volume, PRIOR));

    const alarms = [], commands = [];
    const exec = (command, commandArgs, options) => { commands.push(commandArgs.includes('archive') ? 'archive' : command); return hostExec(command, commandArgs, options); };
    assert.equal(main(args(f), deps(f, { exec, alarm: (reason, detail) => alarms.push([reason, detail]) })), 0);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0][0], TAMPER_REASON);
    assert.equal(commands.includes('archive'), false, 'a forged name is repaired from the host record, not by re-extracting 4660 files');
    assert.equal(readFileSync(join(f.volume, CORPUS), 'utf8'), published, 'the published record must come back byte for byte');
    assert.equal(readlinkSync(join(f.volume, PRIOR)), `${TREES_DIR}/${first.commit}/${PRIOR}`);
    assert.equal(statSync(join(f.volume, CORPUS)).mode & 0o7777, 0o444);
  } finally { cleanup(f); }
});

test('an unexpected name at the volume root is reported and left in place, and stops paging once it is known', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    writeFileSync(join(f.volume, 'notes.txt'), 'an agent was here\n');
    const first = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason, detail) => first.push([reason, detail]) })), 0);
    assert.equal(first.length, 1);
    assert.ok(first[0][1].detail.includes('notes.txt'));
    assert.ok(existsSync(join(f.volume, 'notes.txt')), 'deleting it would destroy the evidence of who else writes this mount');

    // It is never deleted, so it would otherwise page every two minutes forever,
    // which is how a pager gets ignored. The set is acknowledged, not forgotten.
    const second = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason) => second.push(reason) })), 0);
    assert.deepEqual(second, []);
    // A NEW finding pages again.
    writeFileSync(join(f.volume, 'more.txt'), 'and again\n');
    const third = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason) => third.push(reason) })), 0);
    assert.deepEqual(third, [TAMPER_REASON]);
  } finally { cleanup(f); }
});

test('--check reports tampering without repairing anything', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const story = storyFile(f);
    withWritable(story, () => writeFileSync(story, 'tampered\n'));
    const before = snapshot(f.volume);
    assert.equal(main(args(f, ['--check']), deps(f)), 1, 'a tampered corpus needs a refresh, so the timer must see it');
    assert.deepEqual(snapshot(f.volume), before, '--check must not write a byte');
  } finally { cleanup(f); }
});

// FIX 5. Between Berlin midnight and the producers' first push the branch does
// not exist. At a two-minute cadence that was ~25 non-zero exits a night, each
// one firing the unit's OnFailure= alarm.
const noEdition = (f, extra = []) => args(f, extra).filter((arg) => arg !== `--edition=${EDITION}`);

test('a missing edition branch before the deadline is a logged wait, not a failure', () => {
  const f = fixture();
  try {
    // 04:00 Europe/Berlin on a day whose branch was never cut (UNCUT), which main
    // carries a complete corpus for — so any fallback would succeed loudly.
    const now = new Date('2026-09-07T02:00:00Z');
    const lines = [], alarms = [];
    assert.equal(main(noEdition(f), deps(f, { now, log: (line) => lines.push(line), alarm: (reason) => alarms.push(reason) })), 0,
      'waiting must exit 0 or the unit pages about twenty-five times a night');
    assert.deepEqual(alarms, []);
    // But never silently, and never as though it had refreshed.
    const waiting = lines.filter((line) => /^waiting for edition\/2026-09-07/u.test(line));
    assert.equal(waiting.length, 1, lines.join(' | '));
    assert.match(waiting[0], /04:00 Europe\/Berlin/u);
    assert.match(waiting[0], /due by 09:00/u);
    assert.deepEqual(readdirSync(f.volume), [], 'a wait must not leave a corpus behind');
    assert.equal(existsSync(f.landed), false);
    assert.equal(refresh(noEdition(f), deps(f, { now })).waiting, true);
    assert.equal(refresh(noEdition(f), deps(f, { now })).current, false, 'and must not report itself as current');
  } finally { cleanup(f); }
});

test('past the deadline the same missing branch exits non-zero exactly as it always did', () => {
  const f = fixture();
  try {
    const lines = [];
    // 10:00 Europe/Berlin: the wake has happened and there is no corpus.
    assert.equal(main(noEdition(f), deps(f, { now: new Date('2026-09-07T08:00:00Z'), log: (line) => lines.push(line) })), 1);
    assert.deepEqual(lines.filter((line) => /^waiting/u.test(line)), []);
    // And --require-by moves the line, rather than it being a constant to edit.
    assert.equal(main(noEdition(f, ['--require-by=03:00']), deps(f, { now: new Date('2026-09-07T02:00:00Z') })), 1);
    assert.equal(main(noEdition(f, ['--require-by=23:59']), deps(f, { now: new Date('2026-09-07T08:00:00Z') })), 0);
    // A deliberately named ref is never a wait: nobody is waiting for it.
    assert.equal(main(args(f, ['--ref=edition/2099-01-01']), deps(f, { now: new Date('2026-09-07T02:00:00Z') })), 1);
    // Nor is a date that is not today — yesterday's branch is not going to appear.
    assert.equal(main(args(f, [`--ref=edition/${UNCUT}`]), deps(f, { now: new Date('2026-09-07T02:00:00Z') })), 1);
    assert.deepEqual(readdirSync(f.volume), []);
  } finally { cleanup(f); }
});

// THE WORD HAS TO BE ONE alarm.mjs ACCEPTS, AND THE ONLY PROOF IS RAISING IT
// -------------------------------------------------------------------------
// alarm.mjs's vocabulary is CLOSED: `parseArgs` refuses an unknown --reason and
// exits 64, which `raiseDetached` reports as "could not be raised". So code that
// emits a plausible-looking word that is not registered pages NOBODY, while every
// log line and every unit test about the string still reads as a pass. That gap
// was real in this file's own history. Asserting what a constant equals cannot
// close it; this test asserts against the registry, forbids a bare string at any
// call site, and then raises each word for real and requires a page on disk.
test('every reason these modules can raise is registered, and raising it really writes a page', async () => {
  for (const reason of CORPUS_ALARM_REASONS) {
    assert.ok(reason in REASONS, `${reason} is not in alarm.mjs REASONS, so raiseDetached exits 64 and nobody is ever told`);
    assert.equal(parseArgs([`--reason=${reason}`]).reason, reason);
  }
  assert.ok(CORPUS_ALARM_REASONS.includes(TAMPER_REASON) && CORPUS_ALARM_REASONS.includes(REFUSAL_REASON));

  // Closing the CLASS, not the instance: no call site in these modules may pass a
  // bare string or any expression this list does not name, so the next reason
  // somebody adds cannot reach production without passing the checks above.
  const named = { TAMPER_REASON, REFUSAL_REASON };
  let sites = 0;
  for (const file of ['corpus-refresh.mjs', 'corpus-swap.mjs', 'corpus-verify.mjs', 'corpus-volume.mjs', 'corpus-landed.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [, token] of source.matchAll(/(?<![\w$.])alarm\(\s*([A-Za-z_$][\w$]*|'[^']*')/gu)) {
      sites += 1;
      const reason = token.startsWith("'") ? token.slice(1, -1) : named[token];
      assert.ok(CORPUS_ALARM_REASONS.includes(reason), `${file} raises ${token}, which CORPUS_ALARM_REASONS does not name — a word alarm.mjs has never heard of exits 64 and pages nobody`);
    }
  }
  assert.ok(sites >= 4, `the scan must actually have found the raise sites, saw ${sites}`);

  // And the real thing, through alarm.mjs itself: it reads REASONS for the title
  // and priority, and spools the page to disk BEFORE any channel is touched. A
  // rejected or unregistered word leaves no breadcrumb at all, so the file on disk
  // is the positive signal — exit 0 and an empty spool would be the failure shape.
  const spoolDirectory = mkdtempSync(join(tmpdir(), 'clank-alarm-spool-'));
  try {
    for (const reason of CORPUS_ALARM_REASONS) {
      const page = await raise(
        parseArgs([`--reason=${reason}`, `--edition=${EDITION}`, '--message=the mounted corpus stopped matching the host record', '--dry-run']),
        { environment: { CLANK_ALARM_SPOOL: spoolDirectory, CLANK_ALARM_HOST: 'test-box' }, now: new Date('2026-09-06T07:00:00Z'), log: () => {} }
      );
      assert.equal(page.reason, reason);
      const breadcrumbs = readdirSync(spoolDirectory).filter((name) => name.endsWith(`.${reason}.json`));
      assert.equal(breadcrumbs.length, 1, `${reason} left no page on disk, so nothing would have reached a person`);
      assert.equal(JSON.parse(readFileSync(join(spoolDirectory, breadcrumbs[0]), 'utf8')).reason, reason);
      assert.equal(REASONS[reason].priority, 'urgent', `${reason} must page urgently: a corpus the reporters cannot trust is not an FYI`);
    }
  } finally { rmSync(spoolDirectory, { recursive: true, force: true }); }
});
