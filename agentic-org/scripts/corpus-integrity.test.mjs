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
import { CORPUS_ALARM_REASONS, REFUSAL_REASON, TAMPER_REASON, integritySweep } from './corpus-verify.mjs';
import { main, refresh } from './corpus-refresh.mjs';
import {
  AFTER_CUTOFF, BEFORE_CUTOFF, EDITION, PRIOR, UNCUT, args, cleanup, commission, commitAll, deps, fixture,
  identityOf, landedOf, ledgerOf, plantAssignment, snapshot, uncommission, writeCorpus
} from './corpus-refresh.fixture.mjs';

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

// THE PATH WITH NO GUARD ON IT, AND IT SILENCED THE ALARM
// ------------------------------------------------------
// `assertTreesDirectory` checks `trees/`, never `trees/<commit>`. So one rename
// inside a directory uid 2000 owns threw ENOENT out of `buildManifest`, straight
// out of the sweep, past a top-level handler that only alarms on errors it
// recognizes: exit 1, NO page at all, the dated links left dangling, and the
// re-land this whole design rests on never running. A sweep that exits silently
// is strictly worse than no sweep, because the newsroom believes it ran.
test('a corpus tree renamed out from under the dated links pages and re-lands, instead of exiting on a silent ENOENT', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    const trees = join(f.volume, TREES_DIR);
    renameSync(join(trees, first.commit), join(trees, 'zzz'));
    assert.equal(existsSync(join(f.volume, EDITION, 'desks')), false, 'the dated link has to be dangling, or this test is not the reported state');

    const alarms = [], lines = [];
    assert.equal(main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => alarms.push([reason, detail]) })), 0,
      'a corpus that healed itself is a success');
    assert.ok(alarms.length >= 1, 'a tree that vanished without a page is the silent failure this sweep exists to remove');
    assert.deepEqual([...new Set(alarms.map(([reason]) => reason))], [TAMPER_REASON]);
    const said = alarms.map(([, detail]) => `${detail.message}\n${detail.detail}`).join('\n');
    assert.match(said, /is gone from the volume/u, said);
    assert.ok(lines.some((line) => /^re-landing /u.test(line)), lines.join(' | '));

    // The self-heal, which is the whole point: the desk index a reporter reads is
    // reachable again, from git, under the same commit the record names.
    assert.match(readFileSync(join(f.volume, EDITION, 'desks', 'cogsworth.index'), 'utf8'), /s-11111111/u);
    assert.equal(landedOf(f).editions[EDITION].commit, first.commit);
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`);
    // And the renamed tree is evidence: reported, never deleted.
    assert.equal(existsSync(join(trees, 'zzz')), true, 'the name an agent chose is the only record of who else writes this mount');
    // What is left to say is the planted NAME, which is reported and never deleted,
    // so it is said once more and then acknowledged -- not re-landed again.
    const second = [];
    assert.equal(main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => second.push(detail.message) })), 0);
    assert.ok(second.every((message) => /did not land/u.test(message)), `the drift must be healed by now: ${second.join(' | ')}`);
    const third = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason) => third.push(reason) })), 0);
    assert.deepEqual(third, [], 'and an acknowledged planted name stops paging');
  } finally { cleanup(f); }
});

// The other half of the same missing guard: `compareManifest` recursively
// readdir'd and lstat'd whatever `trees/<commit>` pointed at, as root, every two
// minutes. 34 entries outside the volume were measured in the repro; aimed at `/`
// it is a whole-filesystem walk. `stage`'s refusal came far too late to matter.
test('a symlink planted at trees/<commit> is never walked and pages with the one command that clears it', () => {
  const f = fixture();
  const tree = (commit) => join(f.volume, TREES_DIR, commit);
  let planted = null;
  try {
    const first = refresh(args(f), deps(f));
    const bait = join(f.root, 'bait');
    mkdirSync(join(bait, 'nested'), { recursive: true });
    for (const name of ['passwd', 'shadow', 'nested/hosts']) writeFileSync(join(bait, name), `do not read ${name}\n`);
    // uid 2000 owns the tree directory, so it can restore its own write bit and
    // rename it -- which is what makes this reachable at all.
    chmodSync(tree(first.commit), 0o755);
    renameSync(tree(first.commit), join(f.root, 'parked-tree'));
    planted = tree(first.commit);
    symlinkSync(bait, planted);

    const alarms = [], lines = [];
    const exit = main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => alarms.push([reason, detail]) }));
    const said = [...alarms.map(([reason, detail]) => `${reason} ${detail.message} ${detail.detail}`), ...lines].join('\n');

    // Checked FIRST: if the guard is ever removed, this test must fail on the walk
    // outside the volume, not on a missing word in a message. Every one of these
    // names would be reported as an extra file by `compareManifest`.
    for (const name of ['passwd', 'shadow', 'hosts']) assert.equal(said.includes(name), false, `the sweep walked outside the volume: ${said}`);
    assert.ok(alarms.length >= 1, 'a planted tree with no page is a corpus nobody is verifying');
    assert.match(said, /is a symlink where the corpus tree this host landed belongs/u, said);
    assert.match(said, /mv -- /u, 'a state only an operator can clear must page with the command that clears it');
    assert.equal(lines.some((line) => /^re-landing /u.test(line)), false, 'nothing may be re-landed through a name an agent chose');
    assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the symlink is the evidence and is left exactly where it is');
    for (const name of ['passwd', 'shadow', 'nested/hosts']) assert.ok(existsSync(join(bait, name)), `${name} was deleted through the planted symlink`);
    assert.equal(exit, 1, 'and a corpus that can be neither verified nor repaired is not a success');
  } finally { try { unlinkSync(planted); } catch { /* the symlink was never created */ } cleanup(f); }
});

// The class, not the case: a refusal raised because the volume was written by
// something else used to escape the sweep unrecognized, which is the same silent
// exit by a different route.
test('a refusal that escapes the sweep still pages, because an exception nobody sees is the failure this sweep removes', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const trees = join(f.volume, TREES_DIR);
    renameSync(trees, join(f.root, 'parked-trees'));
    symlinkSync(join(f.root, 'parked-trees'), trees);

    const alarms = [];
    // No new commit, so this is the ~700-times-a-day sweep path, not the swap path.
    const exit = main(args(f), deps(f, { alarm: (reason, detail) => alarms.push([reason, detail]) }));
    assert.ok(alarms.length >= 1, 'the sweep threw and nobody was told');
    const said = alarms.map(([reason, detail]) => `${reason} ${detail.message} ${detail.detail}`).join('\n');
    assert.match(said, /could not complete/u, said);
    assert.match(said, /is a symlink/u, said);
    assert.equal(exit, 1);
  } finally { try { unlinkSync(join(f.volume, TREES_DIR)); } catch { /* never created */ } cleanup(f); }
});

// THE REFUSAL IS RIGHT AND THE WEDGE IS NOT
// ----------------------------------------
// An agent owns the volume root, so it can unlink the dated symlink and put a real
// directory of its own there. `pointAtTree` refuses to rename over it, correctly --
// the host must not unlink research it did not write. But nothing could ever clear
// that refusal: three polls, one of them after a fresh producer commit, and the
// desk index was still unreachable, because every poll arrived back at the same
// impossible rename and took the rest of the repair down with it.
test('a real directory planted at the dated name pages with the command that clears it, and no longer wedges the rest of the repair', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const dated = join(f.volume, EDITION);
    const published = identityOf(f);
    unlinkSync(dated);
    mkdirSync(join(dated, 'desks'), { recursive: true });
    writeFileSync(join(dated, 'desks', 'cogsworth.index'), 'planted\n');
    // Forged in the SAME poll, and this is the load-bearing half: CORPUS.json is
    // republished after the dated links, so a throw in the link loop meant the
    // forgery survived every poll for as long as the wedge lasted.
    chmodSync(join(f.volume, CORPUS), 0o644);
    writeFileSync(join(f.volume, CORPUS), 'forged\n', { mode: 0o644 });

    const alarms = [], lines = [];
    const exit = main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => alarms.push([reason, detail]) }));
    const said = [...alarms.map(([reason, detail]) => `${reason} ${detail.message} ${detail.detail}`), ...lines].join('\n');
    assert.ok(alarms.length >= 1, 'an unreachable edition with no page is an edition nobody knows is broken');
    assert.match(said, /where this host's symlink to/u, said);
    assert.ok(said.includes(`mv -- ${dated}`), `the page has to carry the one command that clears it: ${said}`);
    assert.deepEqual(identityOf(f), published, 'the rest of the repair must still run: CORPUS.json was republished');
    // And nothing was deleted: what an agent put there is the only evidence of it.
    assert.equal(statSync(dated).isDirectory(), true);
    assert.equal(readFileSync(join(dated, 'desks', 'cogsworth.index'), 'utf8'), 'planted\n');
    assert.equal(exit, 1, 'an edition only an operator can make reachable again is not a success');

    // Classified, and NOT queued as a link repair: an impossible rename is not a
    // repair, and retrying it every two minutes is what the wedge was made of.
    const sweep = integritySweep({ volume: f.volume, landed: landedOf(f), landedFile: f.landed, edition: EDITION, privateRepo: f.priv, exec: hostExec });
    assert.deepEqual(sweep.links, [], `a rename that cannot work must never be queued: ${JSON.stringify(sweep.links)}`);
    assert.deepEqual(sweep.blocked.map(({ date, shape }) => [date, shape]), [[EDITION, 'directory']]);
    assert.equal(sweep.tampered, true, 'and the volume must not read as current while a desk index is unreachable');
  } finally { cleanup(f); }
});

// ONCE A DATE IS SETTLED ITS CORPUS IS FROZEN, AND THE HOST DECIDES WHEN
// ---------------------------------------------------------------------
// Brass binds a corpus commit into every assignment receipt. Move the link
// afterwards and the receipt cites research nobody read, and one reporter can
// resolve a desk index from one commit and a story file from another.
//
// The gate used to be "does this edition have assignment records", counted in the
// edition-state docker volume. The next test is why it is a clock now. This one is
// the behaviour that has to survive the change: the new tree still lands, dates
// whose cutoff has not passed still move, a frozen tree is never collected, and the
// steady state is a no-op rather than a re-land every two minutes.
test('a settled date keeps its corpus; a date whose cutoff has not passed follows the branch', () => {
  const f = fixture();
  try {
    // UNCUT is tomorrow from AFTER_CUTOFF's point of view, so it is the date that
    // must still move while today's and yesterday's are frozen.
    writeCorpus(f.priv, UNCUT, 'tomorrow, first cut');
    commitAll(f.priv, 'research: tomorrow');
    const first = refresh(args(f), deps(f));
    writeCorpus(f.priv, EDITION, 'RESEARCH THAT ARRIVED AFTER THE DEADLINE');
    writeCorpus(f.priv, PRIOR, 'and a correction to yesterday');
    writeCorpus(f.priv, UNCUT, 'tomorrow, second cut');
    const second = commitAll(f.priv, 'research: after the cutoff');

    const lines = [];
    const result = refresh(args(f), deps(f, { now: AFTER_CUTOFF, log: (line) => lines.push(line) }));
    // A success, not a failure: refusing the whole run would deadlock the refresher
    // for the rest of the day, every two minutes, for a corpus that is correct.
    assert.equal(result.changed, true);
    assert.equal(result.frozen, true);
    assert.ok(lines.some((line) => line.startsWith(`edition ${EDITION} is frozen at ${first.commit.slice(0, 7)}:`) && line.includes('09:00 Europe/Berlin cutoff passed at 2026-09-06T07:00:00Z')),
      lines.join(' | '));

    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`, "the settled edition's link must not move");
    assert.match(readFileSync(join(f.volume, EDITION, 'grok', 'grok-rolling-0730.md'), 'utf8'), /EDITION BRANCH RESEARCH/u);
    // The new tree still LANDS, and a date that is not settled yet still moves.
    assert.ok(existsSync(join(f.volume, TREES_DIR, second)), 'the new tree must land even though two dates are frozen');
    assert.equal(readlinkSync(join(f.volume, UNCUT)), `${TREES_DIR}/${second}/${UNCUT}`, "a date whose cutoff is still ahead must follow the branch");
    assert.equal(readlinkSync(join(f.volume, PRIOR)), `${TREES_DIR}/${first.commit}/${PRIOR}`, 'yesterday is settled too, and does not move either');
    // Provenance stays truthful: CORPUS.json describes what is mounted.
    assert.equal(identityOf(f).commit, first.commit, 'CORPUS.json must not name a commit the frozen edition does not serve');
    assert.deepEqual(ledgerOf(f).at(-1).frozen_editions, [PRIOR, EDITION]);
    // The record carries the host's own justification, so the freeze is auditable
    // without re-deriving it from anything.
    assert.deepEqual(landedOf(f).editions[EDITION].frozen, { at: '2026-09-06T08:00:00Z', cutoff: '2026-09-06T07:00:00Z', require_by: '09:00' });

    // And the frozen tree is never collected, whatever --keep says.
    writeCorpus(f.priv, UNCUT, 'tomorrow, third cut');
    const third = commitAll(f.priv, 'research: third');
    // The intermediate tree nothing references goes; the FROZEN one never does,
    // whatever --keep says, because twelve reporters are reading it right now.
    const swept = refresh(args(f, ['--keep=0']), deps(f, { now: AFTER_CUTOFF }));
    assert.deepEqual(swept.treesRemoved, [second], 'a tree no date resolves into and nothing is frozen at is collectable');
    assert.ok(existsSync(join(f.volume, TREES_DIR, first.commit, EDITION, 'desks', 'foreman.index')), "a frozen edition's tree is never garbage");
    assert.equal(readlinkSync(join(f.volume, EDITION)), `${TREES_DIR}/${first.commit}/${EDITION}`);
    assert.equal(readlinkSync(join(f.volume, UNCUT)), `${TREES_DIR}/${third}/${UNCUT}`);

    // The frozen state is a stable no-op, not a run that re-lands forever.
    const before = snapshot(f.volume);
    const quiet = refresh(args(f), deps(f, { now: AFTER_CUTOFF }));
    assert.deepEqual([quiet.current, quiet.changed, quiet.frozen], [true, false, true]);
    assert.deepEqual(snapshot(f.volume), before);
  } finally { cleanup(f); }
});

// THE DEFECT THAT SURVIVED TWO ROUNDS OF REVIEW
// --------------------------------------------
// The freeze gate counted `*.json` files under `editions/<date>/assignments/` in
// the edition-state docker volume. That volume is mounted WRITABLE into all twelve
// agents, so the decision was theirs in both directions, and both were reproduced:
//
//   * a file containing the literal `{not json` counted as a commission, which
//     freezes a date nobody commissioned and denies the newsroom its refresh;
//   * deleting the real records dropped the count to zero, which dropped the
//     `frozen` field and let the corpus move under an edition that genuinely was
//     commissioned -- the exact thing the freeze exists to prevent.
//
// Validating the JSON would have closed neither. So the question is not asked any
// more, and this is the test that says so: the same scenario, run with nothing
// planted, with real records, with garbage, and with records planted and then
// deleted, must produce one identical decision.
const freezeDecision = (plant, now) => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    plant(f, first.commit);
    writeCorpus(f.priv, EDITION, 'RESEARCH THAT ARRIVED AFTER THE LINEUP WAS RECORDED');
    const second = commitAll(f.priv, 'research: after the lineup');
    const result = refresh(args(f), deps(f, { now }));
    const names = { [first.commit]: 'first', [second]: 'second' };
    const entry = landedOf(f).editions[EDITION];
    return {
      changed: result.changed, frozen: result.frozen,
      link: names[readlinkSync(join(f.volume, EDITION)).slice(`${TREES_DIR}/`.length, `${TREES_DIR}/`.length + 40)] ?? 'other',
      identity: names[identityOf(f).commit] ?? 'other', serving: names[entry.commit] ?? 'other',
      recorded: entry.frozen ?? null, ledger: ledgerOf(f).at(-1).frozen_editions
    };
  } finally { cleanup(f); }
};

test('the freeze decision reads nothing inside either docker volume: planting or deleting assignment records cannot move it', () => {
  const plants = [
    ['nothing planted at all', () => {}],
    ['the real assignment records Brass writes', (f, commit) => commission(f, EDITION, commit)],
    ['a planted file that is not even JSON', (f) => plantAssignment(f, EDITION)],
    ['records planted and then deleted again', (f, commit) => { commission(f, EDITION, commit); plantAssignment(f, EDITION); uncommission(f, EDITION); }]
  ];
  for (const now of [BEFORE_CUTOFF, AFTER_CUTOFF]) {
    const decisions = plants.map(([, plant]) => freezeDecision(plant, now));
    for (const [index, [name]] of plants.entries()) {
      assert.deepEqual(decisions[index], decisions[0], `${name} changed the freeze decision at ${now.toISOString()}`);
    }
  }

  // VACUITY GUARD. The four runs above agreeing proves nothing unless the clock --
  // the one input that IS the host's -- really decides. These two must disagree, and
  // in this direction: research reaches the reporters until the cutoff, and after it
  // the date keeps what it had.
  const before = freezeDecision(() => {}, BEFORE_CUTOFF);
  const after = freezeDecision(() => {}, AFTER_CUTOFF);
  assert.deepEqual([before.frozen, before.link, before.serving, before.ledger], [false, 'second', 'second', []]);
  assert.deepEqual([after.frozen, after.link, after.serving], [true, 'first', 'first']);
  assert.deepEqual(after.ledger, [PRIOR, EDITION]);
  assert.equal(after.recorded.cutoff, '2026-09-06T07:00:00Z');
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

// AUTO-REPAIR CAN BE DRIVEN, SO IT HAS TO BE BOUNDED
// -------------------------------------------------
// An agent can `chmod u+w` a directory it owns inside the frozen tree, dirty one
// file, and make the next two-minute poll re-extract the whole tree through `git
// archive`. Repeated indefinitely that is a CPU and IO drain on the production
// host, self-inflicted by the heal loop. Healing a one-off is right; absorbing a
// driven loop in silence is not.
const dirty = (f) => withWritable(storyFile(f), () => writeFileSync(storyFile(f), 'tampered\n'));

test('a driven drift loop is healed up to the limit and then stood down, leaving the mount alone', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    const tree = `${TREES_DIR}/${first.commit}`;
    const alarms = [], lines = [];
    const run = () => main(args(f), deps(f, { log: (line) => lines.push(line), alarm: (reason, detail) => alarms.push([reason, detail]) }));

    for (const cycle of [1, 2, 3]) {
      dirty(f);
      assert.equal(run(), 0, `cycle ${cycle} must still be a success`);
      assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n', `cycle ${cycle} must still heal from git`);
      assert.equal(landedOf(f).heals[tree].cycles, cycle, 'the host counts the cycles in its own record, outside every volume');
    }
    assert.equal(landedOf(f).heals[tree].since, landedOf(f).heals[tree].since, 'the record says when the loop started');
    assert.equal(alarms.length, 3, 'each repair is new and pages');

    // The fourth drift is the one the host refuses to chase.
    dirty(f);
    assert.equal(run(), 0, 'the stand-down has already paged; a non-zero exit adds the unit OnFailure page every two minutes on top');
    assert.equal(readFileSync(storyFile(f), 'utf8'), 'tampered\n', 'auto-repair must have stood down rather than re-extracting a fourth time');
    assert.ok(lines.some((line) => /^auto-repair suspended for /u.test(line)), lines.join(' | '));
    assert.equal(landedOf(f).heals[tree].cycles, 3, 'and must not go on counting cycles it is no longer performing');
    assert.match(landedOf(f).heals[tree].suspended, /^\d{4}-\d\d-\d\dT/u);

    const suspension = alarms.slice(3);
    assert.equal(suspension.length, 1, 'the stand-down reaches a person, or a corpus nobody repairs is also a corpus nobody is told about');
    assert.equal(suspension[0][0], TAMPER_REASON);
    assert.match(suspension[0][1].message, /auto-repair suspended/u);
    // A page that does not say how to resume is a page that strands the newsroom.
    assert.match(suspension[0][1].detail, /resumes by itself as soon as a new commit lands/u);
    assert.match(suspension[0][1].detail, /"heals"/u);
    assert.ok(suspension[0][1].detail.includes(f.landed), suspension[0][1].detail);

    // And then it goes quiet: ~700 pages a day about a state only an operator can
    // clear is how the word stops meaning anything.
    for (const poll of [1, 2, 3]) assert.equal(run(), 0, `poll ${poll}`);
    assert.equal(alarms.length, 4, `a suspended tree must page once, not once per poll: ${alarms.map(([, d]) => d.message).join(' | ')}`);

    // A NEW commit is a fresh corpus, so the counter clears and auto-repair resumes.
    writeCorpus(f.priv, EDITION, 'a later producer run');
    const next = commitAll(f.priv, 'research: later');
    assert.equal(refresh(args(f), deps(f)).commit, next);
    assert.deepEqual(landedOf(f).heals, {}, 'a new commit must clear the counter');
    dirty(f);
    assert.equal(run(), 0);
    assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n', 'and the next drift is healed again');
  } finally { cleanup(f); }
});

test('--heal-limit sets the ceiling, and a clean sweep clears the counter', () => {
  const f = fixture();
  try {
    const first = refresh(args(f), deps(f));
    const tree = `${TREES_DIR}/${first.commit}`;
    const once = args(f, ['--heal-limit=1']);

    dirty(f);
    assert.equal(main(once, deps(f)), 0);
    assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n', 'the first drift is always healed');
    assert.equal(landedOf(f).heals[tree].cycles, 1);

    // A clean poll is the only evidence that whatever was rewriting the mount has
    // stopped, so it is what clears the count -- and it must not cost the no-op path
    // a write once there is nothing left to clear.
    assert.equal(main(once, deps(f)), 0);
    assert.deepEqual(landedOf(f).heals, {});
    const settled = landedOf(f);
    assert.equal(main(once, deps(f)), 0);
    assert.deepEqual(landedOf(f), settled, 'a clean sweep with nothing to clear must write nothing at all');

    // So the ceiling is per consecutive run of drift, not per lifetime.
    dirty(f);
    assert.equal(main(once, deps(f)), 0);
    assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n');
    dirty(f);
    assert.equal(main(once, deps(f)), 0);
    assert.equal(readFileSync(storyFile(f), 'utf8'), 'tampered\n', '--heal-limit=1 means one reland before standing down');
    // An operator clearing the entry by hand resumes it immediately.
    writeFileSync(f.landed, `${JSON.stringify({ ...landedOf(f), heals: {} }, null, 2)}\n`);
    assert.equal(main(once, deps(f)), 0);
    assert.equal(readFileSync(storyFile(f), 'utf8'), '# s-11111111\n', 'clearing heals by hand must be the documented resume, and must work');
  } finally { cleanup(f); }
});

// An unknown name under trees/ is reported and never deleted, which is right -- and
// which means a planted directory holds host disk indefinitely while the report is
// acknowledged and goes quiet. "Reported" must not be able to mean "nobody will
// ever look".
test('an unknown tree is never deleted, but a footprint over the limit pages again', () => {
  const f = fixture();
  try {
    refresh(args(f), deps(f));
    const planted = join(f.volume, TREES_DIR, 'd'.repeat(40));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'blob'), 'x'.repeat(3 * 1024 * 1024));

    const first = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason, detail) => first.push([reason, detail]) })), 0);
    assert.equal(first.length, 1, 'a name this host did not land is reported');
    const quiet = [];
    assert.equal(main(args(f), deps(f, { alarm: (reason) => quiet.push(reason) })), 0);
    assert.deepEqual(quiet, [], 'and then acknowledged, because it is never deleted and would otherwise page forever');

    // Same name, same acknowledgement -- but now it is over what this host will
    // absorb, which is a different fact and has to page on its own.
    const escalated = [];
    assert.equal(main(args(f, ['--unknown-mib=2']), deps(f, { alarm: (reason, detail) => escalated.push([reason, detail]) })), 0);
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0][0], TAMPER_REASON);
    assert.match(escalated[0][1].detail, /occupying 3 MiB, over the 2 MiB this host will absorb/u);
    assert.ok(existsSync(join(planted, 'blob')), 'it still must not be deleted: that would destroy the evidence of who writes this mount');

    // A planted SYMLINK is counted as one entry and never followed. Measuring
    // through a name an agent chose is how a root-run walk ends up reading /etc, so
    // the bait here is 10 MiB: a walk that follows the link measures 13 MiB and
    // escalates, and a walk that lstats it measures 3 MiB and does not.
    const bait = join(f.root, 'bait');
    mkdirSync(bait, { recursive: true });
    writeFileSync(join(bait, 'big'), 'y'.repeat(10 * 1024 * 1024));
    symlinkSync(bait, join(f.volume, TREES_DIR, 'e'.repeat(40)));
    const linked = [];
    assert.equal(main(args(f, ['--unknown-mib=4']), deps(f, { alarm: (reason, detail) => linked.push([reason, detail]) })), 0);
    assert.deepEqual(linked.filter(([, detail]) => /MiB, over the 4 MiB/u.test(detail.detail)).map(([, detail]) => detail.detail), []);
    assert.equal(existsSync(join(bait, 'big')), true);
  } finally { cleanup(f); }
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

// CLOSING THE CLASS, NOT THE INSTANCE
// -----------------------------------
// The test above proves the freeze decision does not change when assignment records
// are planted or deleted. This one proves the question is not ASKED, anywhere in
// these modules -- because the previous fix's own header comment claimed exactly
// that while the code three screens below counted files in the edition-state
// volume, and every later reader believed the comment. A comment cannot be tested;
// the absence of the read can.
//
// It also closes the second half of the same defect: the removed log line named
// `commits[0]` -- the lexicographically first commit across the receipts -- while
// production-newsroom.mjs binds the edition to the receipt with the earliest
// `corpus.fetched_at`. Two modules, one question, two answers. There is no shared
// export for that ordering, so the only safe number of places that implement it is
// one, and that place is not here.
test('no corpus module reads the edition-state volume, so none can re-invent a freeze gate or a commit ordering out of it', () => {
  const forbidden = /assignments|edition-state|editionState|commissioned/giu;
  let scanned = 0;
  for (const file of ['corpus-refresh.mjs', 'corpus-swap.mjs', 'corpus-verify.mjs', 'corpus-landed.mjs', 'corpus-volume.mjs', 'corpus-contract.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    // Comments are where this history is deliberately written down, so only the
    // code is scanned -- and a line that is code AND comment is scanned as code.
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.ok(code.length > 500, `${file} was not read as source, so this scan proves nothing`);
    scanned += 1;
    assert.deepEqual(code.match(forbidden) ?? [], [],
      `${file} names the edition-state volume in code. That volume is mounted writable into all twelve agents: a decision taken from it is a decision the agents take, in both directions, `
      + 'and validating what it contains closes neither (a planted file can be well-formed, and a delete still thaws). If a LOG line genuinely needs it, it must be labelled untrusted and must not reach a branch.');
  }
  assert.equal(scanned, 6, 'the scan must have covered every corpus module');
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
