import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBylinesTsv } from './build-bylines-tsv.mjs';
import { CONTENT_ALARM_REASONS, main, refresh } from './content-refresh.mjs';
import { REASONS } from './alarm.mjs';
import { VOLUME_ROOT_MODE } from './corpus-volume.mjs';
import { CONTENT_VOLUME_ENV, PublicContentError, publicContentRoot, publicEditionsRoot, stagePublicSource } from './public-content.mjs';

const OWNER = `${process.getuid()}:${process.getgid()}`;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const now = new Date('2026-10-02T16:00:00Z');

function article(repo, edition, id, agent) {
  const dir = path.join(repo, 'content', 'editions', edition, 'articles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ id, edition_date: edition, section: 'world', epistemic: 'reported', topics: ['ports'], headline: `${id} headline`, byline: { agents: [agent] } })}\n`);
}

// A public checkout with a tracked origin/main, the same shape the release build
// root has: content the volume serves, plus code the image carries.
function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-content-refresh-'));
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'agentic-org'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 't');
  writeFileSync(path.join(repo, 'agentic-org', 'Spawnfile'), 'kind: team\n');
  mkdirSync(path.join(repo, 'content', 'agents'), { recursive: true });
  writeFileSync(path.join(repo, 'content', 'agents', 'cogsworth.json'), '{}\n');
  article(repo, '2026-09-30', 's-aaaaaaaa', 'Cogsworth');
  article(repo, '2026-10-01', 's-bbbbbbbb', 'Graves');
  const volume = path.join(root, 'volume');
  mkdirSync(volume); chmodSync(volume, VOLUME_ROOT_MODE);
  const work = path.join(root, 'work');
  mkdirSync(work);
  const w = {
    root, repo, volume: realpathSync(volume), landed: path.join(realpathSync(work), 'landed.json'),
    commit: (message) => { buildBylinesTsv(repo); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); return git(repo, 'rev-parse', 'HEAD'); },
    args: (extra = []) => ['--no-fetch', '--no-lock', `--repo=${repo}`, `--volume=${realpathSync(volume)}`, `--landed=${path.join(realpathSync(work), 'landed.json')}`, `--staging=${path.join(realpathSync(work), 'staging')}`, `--trash=${path.join(realpathSync(work), 'trash')}`, `--owner=${OWNER}`, ...extra],
    env: { [CONTENT_VOLUME_ENV]: realpathSync(volume) },
    link: () => readlinkSync(path.join(realpathSync(volume), 'current')),
    record: () => JSON.parse(readFileSync(path.join(realpathSync(work), 'landed.json'), 'utf8'))
  };
  w.first = w.commit('first');
  return w;
}
const cleanup = (w) => { try { execFileSync('chmod', ['-R', 'u+w', w.root]); } catch { /* nothing frozen */ } rmSync(w.root, { recursive: true, force: true }); };
const quiet = { now, log: () => {}, alarm: () => {} };

test('the published editions land behind `current`, frozen, with an identity a reader can check', () => {
  const w = world();
  try {
    const result = refresh(w.args(), quiet);
    assert.equal(result.changed, true);
    assert.equal(w.link(), `trees/${w.first}/content`);
    const root = publicContentRoot({ env: w.env });
    assert.equal(realpathSync(root), realpathSync(path.join(w.volume, 'trees', w.first, 'content')));
    assert.ok(statSync(path.join(publicEditionsRoot({ env: w.env }), '2026-10-01', 'articles', 's-bbbbbbbb.json')).isFile());
    assert.match(readFileSync(path.join(root, 'bylines', 'graves.tsv'), 'utf8'), /s-bbbbbbbb/u);
    // Only the published content moved: code and the persona roster stay in the image.
    assert.throws(() => statSync(path.join(root, 'agents')), /ENOENT/u);
    assert.throws(() => writeFileSync(path.join(root, 'editions', '2026-10-01', 'articles', 'forged.json'), '{}'), /EACCES|EPERM/u);
    const identity = JSON.parse(readFileSync(path.join(w.volume, 'CONTENT.json'), 'utf8'));
    assert.equal(identity.commit, w.first);
    assert.equal(identity.editions, 2);
  } finally { cleanup(w); }
});

test('a code-only merge is a no-op, an edition merge lands within one poll', () => {
  const w = world();
  try {
    refresh(w.args(), quiet);
    const before = statSync(w.landed).mtimeMs;
    writeFileSync(path.join(w.repo, 'agentic-org', 'prompt.md'), 'a reviewed prompt\n');
    const code = w.commit('code only');
    const idle = refresh(w.args(), quiet);
    assert.equal(idle.changed, false);
    assert.equal(idle.current, true);
    assert.equal(w.link(), `trees/${w.first}/content`, 'a merge that moved no published content must not move `current`');
    assert.equal(statSync(w.landed).mtimeMs, before, 'the no-op path writes nothing');
    assert.notEqual(code, w.first);

    article(w.repo, '2026-10-02', 's-cccccccc', 'Cogsworth');
    const edition = w.commit('chore(edition): add the 2026-10-02 edition');
    const landed = refresh(w.args(), quiet);
    assert.equal(landed.changed, true);
    assert.equal(w.link(), `trees/${edition}/content`);
    assert.ok(statSync(path.join(publicEditionsRoot({ env: w.env }), '2026-10-02')).isDirectory());
    // The tree a release candidate may still be copying from outlives the swap.
    assert.ok(lstatSync(path.join(w.volume, 'trees', w.first)).isDirectory());
    assert.deepEqual(w.record().trees.sort(), [edition, w.first].sort());
  } finally { cleanup(w); }
});

test('content git does not vouch for is refused, alarmed, and the last good editions stay mounted', () => {
  const w = world();
  try {
    refresh(w.args(), quiet);
    article(w.repo, '2026-10-02', 's-dddddddd', 'Cogsworth');
    buildBylinesTsv(w.repo);
    // A byline index that disagrees with the editions: CI would have caught it, and
    // so must the host, because recall built from it points at the wrong story.
    writeFileSync(path.join(w.repo, 'content', 'bylines', 'cogsworth.tsv'), 'stale\n');
    git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'bad'); git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const alarms = [];
    const code = main(w.args(), { ...quiet, alarm: (reason, detail) => alarms.push({ reason, detail }) });
    assert.equal(code, 1);
    assert.deepEqual(alarms.map((item) => item.reason), ['content-refresh-failed']);
    assert.equal(w.link(), `trees/${w.first}/content`);
    assert.equal(JSON.parse(readFileSync(path.join(w.volume, 'CONTENT.json'), 'utf8')).commit, w.first);
  } finally { cleanup(w); }
});

test('a rewritten edition or a moved `current` is alarmed and repaired from git', () => {
  const w = world();
  try {
    refresh(w.args(), quiet);
    const file = path.join(w.volume, 'trees', w.first, 'content', 'editions', '2026-10-01', 'articles', 's-bbbbbbbb.json');
    const original = readFileSync(file, 'utf8');
    chmodSync(path.dirname(file), 0o755); chmodSync(file, 0o644);
    writeFileSync(file, original.replace('Graves', 'Gravez'));
    chmodSync(file, 0o444);
    const alarms = [];
    const healed = refresh(w.args(), { ...quiet, alarm: (reason) => alarms.push(reason) });
    assert.equal(healed.changed, true);
    assert.deepEqual(alarms, ['content-tampered']);
    assert.equal(readFileSync(path.join(publicEditionsRoot({ env: w.env }), '2026-10-01', 'articles', 's-bbbbbbbb.json'), 'utf8'), original);

    // An agent repoints the reader-facing name: put back, and said out loud.
    unlinkSync(path.join(w.volume, 'current'));
    symlinkSync('/etc', path.join(w.volume, 'current'));
    const relinked = [];
    refresh(w.args(), { ...quiet, alarm: (reason) => relinked.push(reason) });
    assert.deepEqual(relinked, ['content-tampered']);
    assert.equal(w.link(), `trees/${w.first}/content`);
  } finally { cleanup(w); }
});

test('a reader refuses a volume the host has not landed instead of reading an empty archive', () => {
  const w = world();
  try {
    assert.throws(() => publicContentRoot({ env: w.env }), PublicContentError);
    assert.throws(() => publicContentRoot({ env: { [CONTENT_VOLUME_ENV]: 'relative/path' } }), PublicContentError);
    // Without the variable this is a checkout, and content/ is the tree.
    assert.equal(publicContentRoot({ env: {}, repo: w.repo }), path.join(w.repo, 'content'));
  } finally { cleanup(w); }
});

test("pressman's candidate gets code from the image and the back catalogue from the volume", async () => {
  const w = world();
  try {
    refresh(w.args(), quiet);
    // The image's copy of the public tree: code, and no published editions.
    const source = path.join(w.root, 'image');
    mkdirSync(path.join(source, 'ops'), { recursive: true });
    writeFileSync(path.join(source, 'ops', 'validate-content.mjs'), '// code\n');
    mkdirSync(path.join(source, 'content', 'agents'), { recursive: true });
    const candidate = path.join(w.root, 'candidate');
    await stagePublicSource(source, candidate, undefined, { env: w.env });
    assert.ok(statSync(path.join(candidate, 'ops', 'validate-content.mjs')).isFile());
    assert.ok(statSync(path.join(candidate, 'content', 'agents')).isDirectory());
    assert.ok(statSync(path.join(candidate, 'content', 'editions', '2026-10-01', 'articles', 's-bbbbbbbb.json')).isFile());
    assert.ok(statSync(path.join(candidate, 'content', 'bylines', 'graves.tsv')).isFile());
    assert.equal(lstatSync(path.join(candidate, 'content', 'editions')).isSymbolicLink(), false, 'the candidate is a copy, not a view of the volume');
    // And a candidate that would carry no back catalogue at all is refused.
    await assert.rejects(stagePublicSource(source, path.join(w.root, 'bare'), undefined, { env: {} }), PublicContentError);
  } finally { cleanup(w); }
});

test("staging works from a READ-ONLY image tree, as in production (2026-10-03 EACCES)", async () => {
  const w = world();
  const source = path.join(w.root, 'image-ro');
  try {
    refresh(w.args(), quiet);
    mkdirSync(path.join(source, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(source, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    mkdirSync(path.join(source, 'content', 'agents'), { recursive: true });
    // The image bundle is mounted 0555/0444; cp preserves those modes.
    execFileSync('chmod', ['-R', 'a-w', source]);
    const candidate = path.join(w.root, 'candidate-ro');
    const { makeOwnerWritable } = await import('./production-newsroom.mjs');
    await stagePublicSource(source, candidate, undefined, { env: w.env, makeOwnerWritable });
    assert.ok(statSync(path.join(candidate, 'content', 'editions', '2026-10-01', 'articles', 's-bbbbbbbb.json')).isFile());
    // The caller must be able to clean the candidate up afterwards.
    rmSync(candidate, { recursive: true, force: true });
    assert.equal(existsSync(candidate), false);
  } finally { execFileSync('chmod', ['-R', 'u+w', source]); cleanup(w); }
});

test('every content alarm word is registered, so none of them is silently undeliverable', () => {
  for (const reason of CONTENT_ALARM_REASONS) assert.ok(reason in REASONS, reason);
});
