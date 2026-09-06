import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORTERS, RepinError, assertEditionInTree, berlinToday, parseArgs, resolveRef, run, verifyArchive } from './repin-private-source.mjs';

const EDITION = '2026-09-06';
const STORIES = { cogsworth: ['s-11111111', 's-22222222'], sprockett: ['s-22222222'], foreman: ['s-33333333'], graves: ['s-33333333'], tinkerton: [], vesta: ['s-11111111'] };
const DIGEST = /sha256:[a-f0-9]{64}/;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const writeIndex = (root, edition, agent, ids) => {
  mkdirSync(join(root, edition, 'desks'), { recursive: true });
  const header = `# clank.desk-index.v1 desk=${agent} edition=${edition} generated=${edition}T01:13:15.652Z\n# stories=${ids.length} sources=2 empty_sources=0 unrouted=0 base=stories/\n# id          slot src  urls conf also\n`;
  writeFileSync(join(root, edition, 'desks', `${agent}.index`), header + ids.map((id) => `${id}    0307 grok 6    h    | a claim | a summary\n`).join(''));
};

const writeStory = (root, edition, id) => {
  mkdirSync(join(root, edition, 'stories'), { recursive: true });
  writeFileSync(join(root, edition, 'stories', `${id}.md`), `# ${id}\n`);
};

// A complete miniature of the real layout: a private git repo carrying an
// edition branch, and an org tree whose Spawnfiles pin the private archive.
const fixture = ({ edition = EDITION, stories = STORIES, withStoryFiles = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'clank-repin-test-'));
  const priv = join(root, 'clankandslop-private');
  mkdirSync(priv, { recursive: true });
  git(priv, 'init', '--quiet', '-b', 'main');
  git(priv, 'config', 'user.email', 'test@example.invalid');
  git(priv, 'config', 'user.name', 'test');
  writeFileSync(join(priv, 'README'), 'legacy\n');
  git(priv, 'add', '-A');
  git(priv, 'commit', '--quiet', '-m', 'legacy corpus');
  git(priv, 'checkout', '--quiet', '-b', `edition/${edition}`);
  for (const [agent, ids] of Object.entries(stories)) {
    writeIndex(priv, edition, agent, ids);
    if (withStoryFiles) for (const id of ids) writeStory(priv, edition, id);
  }
  if (!withStoryFiles) writeStory(priv, edition, 's-00000000'); // keep stories/ present but incomplete
  git(priv, 'add', '-A');
  git(priv, 'commit', '--quiet', '-m', `research: split ${edition} corpus`);
  const commit = git(priv, 'rev-parse', 'HEAD').trim();

  const org = join(root, 'agentic-org');
  mkdirSync(join(org, 'policies'), { recursive: true });
  const stale = `sha256:${'0'.repeat(64)}`;
  writeFileSync(join(org, 'policies/private-source.json'), `${JSON.stringify({ version: 'v1', repo: 'clankandslop-private', remote: 'git@example.invalid:private.git', commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, null, 2)}\n`);
  writeFileSync(join(org, 'newsroom-runtime-bundle.json'), `${JSON.stringify({ version: 'clank.newsroom-runtime-bundle.v2', source: { archive: 'newsroom-runtime.tar', sha256: `sha256:${'1'.repeat(64)}`, file_count: 3, content_bytes: 9 }, private: { archive: 'newsroom-private.tar', sha256: stale, mount: 'repos/newsroom-private', file_count: 0, content_bytes: 0, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }, null, 2)}\n`);
  for (const agent of ['cogsworth', 'vesta', 'pressman']) {
    mkdirSync(join(org, 'agents', agent), { recursive: true });
    writeFileSync(join(org, 'agents', agent, 'Spawnfile'), `name: ${agent}\nworkspace:\n  resources:\n    - { id: private-archive, kind: bundle, source: ../../newsroom-private.tar, sha256: ${stale}, mount: ./repos/newsroom-private, mode: readonly }\n`);
  }
  return { root, org, priv, commit, stale };
};

test('parseArgs defaults to a fetching, writing run', () => {
  assert.deepEqual(parseArgs([]), { edition: null, ref: null, fetch: true, check: false });
});

test('parseArgs accepts the documented flags and rejects anything else', () => {
  assert.deepEqual(parseArgs(['--edition=2026-09-06', '--ref=main', '--no-fetch', '--check']), { edition: '2026-09-06', ref: 'main', fetch: false, check: true });
  assert.throws(() => parseArgs(['--edition=tomorrow']), RepinError);
  assert.throws(() => parseArgs(['--deploy']), RepinError);
});

test('berlinToday reads the wall clock the cron runs on, not UTC', () => {
  // 22:30 UTC on 2026-09-06 is already 2026-09-07 in Berlin (CEST, +02:00):
  // the reporters resolve their own edition date, so an off-by-one here is an
  // off-by-one in every research path the bundle has to satisfy.
  assert.equal(berlinToday(new Date('2026-09-06T22:30:00Z')), '2026-09-07');
  assert.equal(berlinToday(new Date('2026-09-06T08:00:00Z')), '2026-09-06');
});

test('resolveRef never falls back when the edition branch is missing', () => {
  const { priv, commit } = fixture();
  try {
    assert.equal(resolveRef(priv, `edition/${EDITION}`).commit, commit);
    assert.throws(() => resolveRef(priv, 'edition/2099-01-01'), (error) => error instanceof RepinError && /refusing to fall back/u.test(error.message));
  } finally { rmSync(priv, { recursive: true, force: true }); }
});

test('assertEditionInTree rejects a commit that has no desk index for the target date', () => {
  const { root, priv, commit } = fixture();
  try {
    assert.doesNotThrow(() => assertEditionInTree(priv, commit, EDITION));
    // The exact shape of the current production defect: a commit whose corpus
    // stops a day short of the date the reporters will compute.
    assert.throws(() => assertEditionInTree(priv, commit, '2026-09-07'), (error) => error instanceof RepinError && /no 2026-09-07\/desks\/<agent>\.index/u.test(error.message) && REPORTERS.every((agent) => error.message.includes(agent)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyArchive reports index sizes and resolves every story row', () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-repin-verify-'));
  try {
    for (const [agent, ids] of Object.entries(STORIES)) { writeIndex(root, EDITION, agent, ids); for (const id of ids) writeStory(root, EDITION, id); }
    const report = verifyArchive(root, EDITION);
    assert.deepEqual(report.map((entry) => entry.agent), REPORTERS);
    assert.deepEqual(report.find((entry) => entry.agent === 'cogsworth').stories, STORIES.cogsworth);
    assert.equal(report.find((entry) => entry.agent === 'tinkerton').rows, 0);
    assert.ok(report.every((entry) => entry.bytes > 0));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyArchive fails loudly on a dangling story reference and on a missing index', () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-repin-verify-'));
  try {
    for (const [agent, ids] of Object.entries(STORIES)) writeIndex(root, EDITION, agent, ids);
    writeStory(root, EDITION, 's-11111111'); // s-22222222 and s-33333333 deliberately absent
    assert.throws(() => verifyArchive(root, EDITION), (error) => error instanceof RepinError && /DEFECT/u.test(error.message) && error.message.includes('s-22222222'));
  } finally { rmSync(root, { recursive: true, force: true }); }

  const complete = mkdtempSync(join(tmpdir(), 'clank-repin-verify-'));
  try {
    for (const [agent, ids] of Object.entries(STORIES)) { writeIndex(complete, EDITION, agent, ids); for (const id of ids) writeStory(complete, EDITION, id); }
    rmSync(join(complete, EDITION, 'desks', 'graves.index'));
    assert.throws(() => verifyArchive(complete, EDITION), (error) => error instanceof RepinError && /missing 2026-09-06\/desks\/graves\.index/u.test(error.message));
  } finally { rmSync(complete, { recursive: true, force: true }); }
});

test('run repins the pin, the bundle and every Spawnfile, and is idempotent', () => {
  const { root, org, commit, stale } = fixture();
  try {
    const first = run(['--no-fetch', `--edition=${EDITION}`], { orgRoot: org, log: () => {} });
    assert.equal(first.commit, commit);
    assert.equal(first.ref, `edition/${EDITION}`);
    assert.match(first.digest, DIGEST);
    assert.notEqual(first.digest, stale);
    assert.equal(first.spawnfiles, 3);
    assert.equal(JSON.parse(readFileSync(join(org, 'policies/private-source.json'), 'utf8')).commit, commit);
    const bundle = JSON.parse(readFileSync(join(org, 'newsroom-runtime-bundle.json'), 'utf8'));
    assert.equal(bundle.private.sha256, first.digest);
    assert.equal(bundle.private.commit, commit);
    // The repin owns the private archive and nothing else.
    assert.equal(bundle.source.sha256, `sha256:${'1'.repeat(64)}`);
    for (const agent of ['cogsworth', 'vesta', 'pressman']) assert.ok(readFileSync(join(org, 'agents', agent, 'Spawnfile'), 'utf8').includes(`sha256: ${first.digest}`), `${agent} Spawnfile not repinned`);

    const second = run(['--no-fetch', `--edition=${EDITION}`], { orgRoot: org, log: () => {} });
    assert.equal(second.digest, first.digest);
    assert.deepEqual(second.changed, [], 'a second run from a repinned tree must change nothing');
    assert.doesNotThrow(() => run(['--no-fetch', `--edition=${EDITION}`, '--check'], { orgRoot: org, log: () => {} }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run refuses a date the pinned corpus cannot serve, and writes nothing', () => {
  const { root, org } = fixture();
  try {
    const before = readFileSync(join(org, 'policies/private-source.json'), 'utf8');
    assert.throws(() => run(['--no-fetch', '--edition=2026-09-07'], { orgRoot: org, log: () => {} }), RepinError);
    assert.throws(() => run(['--no-fetch', `--edition=${EDITION}`, '--ref=main'], { orgRoot: org, log: () => {} }), (error) => error instanceof RepinError && /no 2026-09-06\/desks/u.test(error.message));
    assert.equal(readFileSync(join(org, 'policies/private-source.json'), 'utf8'), before, 'a failed repin must leave the pin untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check fails on a tree that is not already repinned', () => {
  const { root, org } = fixture();
  try {
    assert.throws(() => run(['--no-fetch', `--edition=${EDITION}`, '--check'], { orgRoot: org, log: () => {} }), (error) => error instanceof RepinError && /--check/u.test(error.message) && error.message.includes('policies/private-source.json'));
    assert.equal(JSON.parse(readFileSync(join(org, 'policies/private-source.json'), 'utf8')).commit, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dangling story reference in the corpus aborts the repin', () => {
  const { root, org } = fixture({ withStoryFiles: false });
  try {
    assert.throws(() => run(['--no-fetch', `--edition=${EDITION}`], { orgRoot: org, log: () => {} }), (error) => error instanceof RepinError && /DEFECT/u.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
