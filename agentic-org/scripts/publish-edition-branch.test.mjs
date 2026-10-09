import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBylinesTsv } from './build-bylines-tsv.mjs';
import { buildTopicsTxt } from './build-topics-txt.mjs';
import { PUBLIC_CONTENT_PATHS, isPublicContentPath } from './public-content.mjs';
import {
  BASE_BRANCH, CORPUS_PROVENANCE_FILE, CORPUS_PROVENANCE_VERSION, DEFAULT_LANDED_RECORD, GENERATED_INDEX_PATHS, LANDED_VERSION, EDITION_PUSH_REMOTE, GITHUB_HOST_KEYS, PROTECTED_REFS, PUSH_REMOTES,
  artifactDigest, assertNoForcedPush, assertNotProtectedRef, assertPushableRef, assertRequestedEdition, berlinToday,
  contentOnlyFindings, editionBranch, editionCommitMessage, editionCorpusClaim, hostAssertedProvenance, landedCorpus,
  parseArguments, prepareSshIdentity, publishEditionBranch, pushArgv, pushStagedEditionTree,
  regenerateIndexes, remoteUrl, resolveStagedEdition, sshConfig
} from './publish-edition-branch.mjs';

const scratch = (label) => mkdtempSync(join(tmpdir(), `clank-${label}-`));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' } }).trim();

// A real remote, on disk. Everything below pushes to it for real, so a guard
// that only *claims* to stop a push to main has somewhere to be caught out.
// The base branch carries what the real one carries: the topic registry, and
// the two generated views ci.yml regenerates and diffs. Without them there is
// nothing for the drift check to be wrong about.
const TOPICS_JSON = { topics: { oil: { name: 'Oil', blurb: 'Crude and products.' }, rates: { name: 'Rates', blurb: 'Policy rates.' } } };

function remote({ organization = true } = {}) {
  const root = scratch('remote');
  const bare = join(root, 'origin.git'), seed = join(root, 'seed');
  mkdirSync(bare); mkdirSync(seed);
  git(['init', '-q', '--bare', '-b', BASE_BRANCH], bare);
  git(['init', '-q', '-b', BASE_BRANCH], seed);
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  mkdirSync(join(seed, 'content', 'bylines'), { recursive: true });
  writeFileSync(join(seed, 'content', 'topics.json'), JSON.stringify(TOPICS_JSON));
  buildTopicsTxt(seed);
  buildBylinesTsv(seed);
  writeFileSync(join(seed, 'content', 'bylines', '.keep'), '');
  if (organization) seedOrganization(seed);
  git(['add', '--', 'README.md', 'content', ...(organization ? ['agentic-org'] : [])], seed);
  git(['commit', '-q', '-m', 'chore: seed'], seed);
  git(['push', '-q', bare, `refs/heads/${BASE_BRANCH}:refs/heads/${BASE_BRANCH}`], seed);
  return {
    root, url: bare,
    head: () => git(['rev-parse', `refs/heads/${BASE_BRANCH}`], bare),
    refs: () => git(['for-each-ref', '--format=%(refname)'], bare).split('\n').filter(Boolean),
    // Stands in for merge-edition.yml: the edition branch lands on the base.
    merge: (commit) => git(['update-ref', `refs/heads/${BASE_BRANCH}`, commit], bare)
  };
}

// A slice of the organization tree: the newsroom entrypoints and one agent
// Spawnfile, so an edition branch is cut from something shaped like `main`.
function seedOrganization(root) {
  mkdirSync(join(root, 'agentic-org', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'agentic-org', 'agents', 'cogsworth'), { recursive: true });
  writeFileSync(join(root, 'agentic-org', 'scripts', 'production-newsroom.mjs'), 'export const newsroom = 1;\n');
  writeFileSync(join(root, 'agentic-org', 'scripts', 'production-newsroom-mcp.mjs'), 'export const mcp = 1;\n');
  writeFileSync(join(root, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'), 'agent: cogsworth\n');
}

// What the image is built from at a commit: every tracked file the
// `newsroom-runtime` bundle archives, i.e. everything but the published content
// (agentic-org/Spawnfile excludes exactly PUBLIC_CONTENT_PATHS), with its blob id.
const imageInputs = (root, rev = 'HEAD') => git(['ls-tree', '-r', rev], root).split('\n').filter(Boolean)
  .filter((line) => !isPublicContentPath(line.split('\t')[1]));

function stagedEdition(edition) {
  const root = scratch('staged');
  const directory = join(root, 'content', 'editions', edition);
  mkdirSync(join(directory, 'articles'), { recursive: true });
  // A real article row, so the byline index the base branch carries genuinely
  // goes stale the moment this edition is added to the tree.
  writeFileSync(join(directory, 'articles', 'one.json'), `${JSON.stringify({ id: 'one', edition_date: edition, section: 'world', epistemic: 'fact', topics: ['oil'], headline: 'A headline', byline: { desk: 'Test Desk', agents: ['Cogsworth'] } })}\n`);
  return { root, source: directory, path: `content/editions/${edition}` };
}

// Exactly what ci.yml does: run both generators over the checked-out tree and
// require neither to change anything.
function ciDriftCheck(workdir) {
  buildTopicsTxt(workdir);
  buildBylinesTsv(workdir);
  return git(['status', '--porcelain'], workdir);
}

test('the edition branch is derived from the date and nothing else may be pushed', () => {
  assert.equal(editionBranch('2026-09-05'), 'edition/2026-09-05');
  assert.equal(assertPushableRef('edition/2026-09-05'), 'edition/2026-09-05');
  for (const ref of ['main', 'refs/heads/main', 'edition/main', 'master', 'staging', 'gh-pages', 'HEAD', 'edition/../main', 'edition/2026-09-05/../../main', 'edition/2026-9-5', 'edition/', '', 'edition/2026-09-05 ', undefined, 42])
    assert.throws(() => assertPushableRef(ref), /not an edition branch|protected ref|well-formed/u, String(ref));
});

test('the protected-ref refusal stands on its own, whatever the branch pattern allows', () => {
  assert.equal(assertNotProtectedRef('edition/2026-09-05'), 'edition/2026-09-05');
  assert.equal(assertNotProtectedRef('release/candidate'), 'release/candidate');
  for (const ref of ['main', 'refs/heads/main', 'edition/main', 'master', 'staging', 'gh-pages', 'HEAD', 'topic/HEAD', 'edition/../main', 'edition//2026-09-05', 'edition/./x'])
    assert.throws(() => assertNotProtectedRef(ref), /protected ref|well-formed/u, ref);
  assert.throws(() => assertNotProtectedRef(7), /must be a string/u);
});

test('the push argv is fast-forward, single-ref, and refuses every destructive flag', () => {
  assert.deepEqual(pushArgv('git@host:owner/repo.git', 'edition/2026-09-05'), ['push', '--porcelain', 'git@host:owner/repo.git', 'refs/heads/edition/2026-09-05:refs/heads/edition/2026-09-05']);
  assert.throws(() => pushArgv('git@host:owner/repo.git', 'main'), /not an edition branch|protected ref/u);
  for (const argument of ['-f', '--force', '--force-with-lease', '--mirror', '--delete', '-d', '--all', '--tags', '--prune', '--receive-pack=evil', '+refs/heads/main:refs/heads/main', '+edition/2026-09-05', ':refs/heads/main'])
    assert.throws(() => assertNoForcedPush(['push', argument]), /refused|forced refspec|deletes a remote ref/u, argument);
  assert.throws(() => assertNoForcedPush(['push', 7]), /must be strings/u);
});

test('the publisher may only ever address the public repository', () => {
  assert.equal(EDITION_PUSH_REMOTE, 'clankandslop');
  assert.equal(remoteUrl(EDITION_PUSH_REMOTE), 'git@clankandslop.deploy:apresmoi/clankandslop.git');
  // The private repository is not in the table at all: nothing here reaches it.
  assert.deepEqual(Object.keys(PUSH_REMOTES), ['clankandslop']);
  for (const name of ['main', 'master', 'staging', 'gh-pages', 'HEAD']) assert.ok(PROTECTED_REFS.includes(name), name);
});

test('the ssh config binds the operator key per remote and pins the host key', () => {
  const rendered = sshConfig('/scratch', '/keys/clankandslop');
  for (const declared of Object.values(PUSH_REMOTES)) {
    assert.match(rendered, new RegExp(`Host ${declared.alias}\\n  HostName ${declared.host}\\n  User git\\n  IdentityFile /keys/clankandslop\\n  IdentitiesOnly yes`, 'u'));
  }
  assert.match(rendered, /StrictHostKeyChecking yes/u);
  assert.match(rendered, /UserKnownHostsFile \/scratch\/known_hosts/u);
  assert.ok(GITHUB_HOST_KEYS.every((line) => line.startsWith('github.com ssh-ed25519 ')));
});

test('the ssh identity references the operator key and never copies it', async () => {
  const root = scratch('identity');
  const keyFile = join(root, 'clankandslop');
  writeFileSync(keyFile, 'PRIVATE-KEY-MATERIAL\n', { mode: 0o600 });
  const directory = join(root, 'ssh');
  const identity = await prepareSshIdentity(directory, keyFile);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(identity.configFile).mode & 0o777, 0o600);
  assert.match(identity.sshCommand, /^ssh -F .*\/config -o BatchMode=yes$/u);
  // The key stays exactly where the operator put it: nothing in the scratch
  // directory contains the material, only a path to it.
  for (const name of readdirSync(directory)) assert.doesNotMatch(readFileSync(join(directory, name), 'utf8'), /PRIVATE-KEY-MATERIAL/u, name);
  assert.match(readFileSync(identity.configFile, 'utf8'), new RegExp(`IdentityFile ${keyFile}`, 'u'));
  await assert.rejects(prepareSshIdentity(directory, join(root, 'absent')), /is not readable/u);
  await assert.rejects(prepareSshIdentity(directory, 'relative/key'), /must be absolute/u);
  await assert.rejects(prepareSshIdentity(directory, root), /is not a file/u);
});

// Shapes a promoted artifact the way stage_release does, and the receipt the
// way pressman writes it FROM INSIDE THE CONTAINER: `staging_root` is the
// workspace symlink pressman sees, which is not the path the host reads the
// same volume at. A receipt binding that compares those two strings refuses
// every real artifact; verified against the first one ever produced, on the box
// on 2026-09-06.
const CONTAINER_STAGING = '/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/pressman/staging';
async function promoted(edition, short, seed = '{"page":"front"}\n') {
  const root = scratch('staging'), artifact = `${edition}-${short}`;
  const directory = join(root, artifact, 'content', 'editions', edition);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'front.json'), seed);
  symlinkSync(artifact, join(root, 'current-edition'));
  const state = scratch('state'), receipts = join(state, 'editions', edition, 'receipts');
  mkdirSync(receipts, { recursive: true });
  const receipt = {
    version: 'clank.newsroom-release-receipt.v1', state: 'staged', edition,
    composition_digest: `sha256:${short}${'0'.repeat(48)}`,
    artifact_digest: await artifactDigest(join(root, artifact)),
    staging_root: `${CONTAINER_STAGING}/${artifact}`
  };
  const file = join(receipts, `staged-${short}.json`);
  const write = (value) => writeFileSync(file, JSON.stringify(value));
  write(receipt);
  return { root, state, artifact, artifactPath: join(root, artifact), receipts, receipt, write };
}

// --- the host's provenance fixtures ------------------------------------------
// Two records on opposite sides of the agent boundary. `commission` writes the
// composition receipt the CONTAINER produced — the claim, forgeable in principle
// because uid 2000 owns the corpus volume root. `landed` writes the host's own
// root-owned answer, outside the volume, which the container cannot read.
const CORPUS_A = 'a1b2c3d4'.repeat(5), CORPUS_B = 'b9c8d7e6'.repeat(5);
const CONTAINER_FETCHED_AT = '2026-01-01T00:00:00Z', HOST_LANDED_AT = '2026-09-08T04:05:06Z';

function commission(staged, edition, { commit = CORPUS_A, corpus } = {}) {
  const digest = staged.receipt.composition_digest;
  const file = join(staged.receipts, `composed-${digest.slice(7)}.json`);
  const identity = { version: 'clank.research-corpus.identity.v1', commit, ref: `refs/remotes/origin/edition/${edition}`, edition, fetched_at: CONTAINER_FETCHED_AT, tree: `trees/${commit}` };
  const value = { version: 'clank.newsroom-receipt.v1', kind: 'composed', edition, event_key: 'wake-1', digest, composition: { tree: { articles: [] }, corpus: corpus === null ? undefined : { ...identity, ...corpus } } };
  const write = (next) => writeFileSync(file, JSON.stringify(next));
  write(value);
  return { file, value, write };
}

// Spawnfile's host record for the research-corpus feed, serving the edition's
// branch. `body` replaces it whole; `identity` overrides fields of its identity.
const HOST_REVISION = 'e'.repeat(64);
const hostRecord = (edition, { commit = CORPUS_A, landed_at = HOST_LANDED_AT, identity = {} } = {}) => ({
  version: 'spawnfile.volume-feed-landed.v1', revision: HOST_REVISION, tree: HOST_REVISION, trees: [HOST_REVISION], heals: {}, identity_sha256: 'f'.repeat(64),
  identity: { version: 'spawnfile.volume-feed.v1', resource: 'research-corpus', volume: 'clank-newsroom-corpus', revision: HOST_REVISION, tree: `trees/${HOST_REVISION}`, files: 9, landed_at, source: { kind: 'git', commit, ref: `origin/edition/${edition}`, paths: [edition] }, ...identity }
});
function landed(edition, { body, ...options } = {}) {
  const file = join(scratch('landed'), 'landed.json');
  writeFileSync(file, JSON.stringify(body ?? hostRecord(edition, options)));
  return file;
}

// A promoted artifact whose records agree with the host: the ordinary case every
// refusal below is a deviation from.
async function provenanced(edition, short, options = {}) {
  const staged = await promoted(edition, short);
  const composed = commission(staged, edition, options.claim);
  return { ...staged, composed, landed: landed(edition, options.host) };
}

test('only a promoted artifact can be resolved, and the receipt must agree with it', async () => {
  const root = scratch('staging');
  await assert.rejects(resolveStagedEdition(root), /no promoted edition/u);
  await assert.rejects(resolveStagedEdition('relative'), /must be an absolute path/u);
  const staged = await promoted('2026-09-05', 'abcdef0123456789');
  const resolved = await resolveStagedEdition(staged.root);
  assert.equal(resolved.edition, '2026-09-05');
  assert.equal(resolved.editionPath, 'content/editions/2026-09-05');
  // The receipt pressman actually writes — container path and all — is ACCEPTED.
  // This is the case the old path comparison refused, and the reason `--state`
  // could never be passed by an unattended timer.
  assert.equal((await resolveStagedEdition(staged.root, { stateRoot: staged.state })).receipt.state, 'staged');
  // A receipt naming a different artifact directory is still refused, whatever
  // volume it was written against: the directory NAME is the artifact identity.
  staged.write({ ...staged.receipt, staging_root: `${CONTAINER_STAGING}/2026-09-05-0123456789abcdef` });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /but current-edition points at/u);
  // And the name has to be the one stage_release derives from the composition
  // it recorded, so a promoted directory that belongs to another composition
  // cannot be published under this receipt.
  staged.write({ ...staged.receipt, composition_digest: `sha256:${'b'.repeat(64)}` });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /is not the artifact this composition produced/u);
  staged.write({ ...staged.receipt, artifact_digest: undefined });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /carries no artifact_digest/u);
  staged.write(staged.receipt);
  writeFileSync(join(staged.receipts, 'staged-0000000000000000.json'), JSON.stringify(staged.receipt));
  assert.equal((await resolveStagedEdition(staged.root, { stateRoot: staged.state })).receipt.composition_digest, staged.receipt.composition_digest);
});

test('a staging volume edited after the build is caught by the artifact digest', async () => {
  const staged = await promoted('2026-09-05', 'abcdef0123456789');
  assert.equal((await resolveStagedEdition(staged.root, { stateRoot: staged.state })).receipt.state, 'staged');
  // One byte, in a file the edition directory does not even contain. The path
  // comparison this replaced could not see it; the digest is the whole point.
  writeFileSync(join(staged.artifactPath, 'README.md'), 'tampered\n');
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /the staging volume changed after pressman built it/u);
});

test('the artifact digest is the producer rule: sorted names, typed entries, no symlinks', async () => {
  const root = scratch('digest');
  mkdirSync(join(root, 'b'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'one\n');
  writeFileSync(join(root, 'b', 'c.txt'), 'two\n');
  const digest = await artifactDigest(root);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  // Content-addressed: same bytes, same digest, whatever the directory is called.
  const copy = scratch('digest');
  mkdirSync(join(copy, 'b'), { recursive: true });
  writeFileSync(join(copy, 'a.txt'), 'one\n');
  writeFileSync(join(copy, 'b', 'c.txt'), 'two\n');
  assert.equal(await artifactDigest(copy), digest);
  writeFileSync(join(copy, 'b', 'c.txt'), 'three\n');
  assert.notEqual(await artifactDigest(copy), digest);
  // A symlink in a release artifact is a refusal, exactly as it is in the
  // producer: a hash that follows links describes something other than the tree.
  symlinkSync('/etc/passwd', join(root, 'link'));
  await assert.rejects(artifactDigest(root), /contains a symlink/u);
});

test('the promoted link may not escape the staging volume', async () => {
  const root = scratch('staging');
  symlinkSync('/etc', join(root, 'current-edition'));
  await assert.rejects(resolveStagedEdition(root), /must name a sibling directory/u);
  const other = scratch('staging');
  symlinkSync('../elsewhere', join(other, 'current-edition'));
  await assert.rejects(resolveStagedEdition(other), /must name a sibling directory/u);
  const undated = scratch('staging');
  mkdirSync(join(undated, 'not-an-edition'));
  symlinkSync('not-an-edition', join(undated, 'current-edition'));
  await assert.rejects(resolveStagedEdition(undated), /does not begin with an edition date/u);
});

test('the command line refuses to run without a staging volume or a key', () => {
  assert.throws(() => parseArguments([]), /--staging/u);
  assert.throws(() => parseArguments(['--staging', '/s']), /--key/u);
  assert.throws(() => parseArguments(['--staging', '/s', '--nope', 'x']), /unknown argument/u);
  assert.throws(() => parseArguments(['--staging']), /requires a value/u);
  assert.deepEqual(parseArguments(['--staging', '/s', '--dry-run']), { dryRun: true, staging: '/s' });
});

test('an unattended caller must name the edition, and naming it binds the receipt', () => {
  assert.deepEqual(parseArguments(['--staging', '/s', '--state', '/t', '--edition', 'today', '--dry-run']), { dryRun: true, staging: '/s', state: '/t', edition: 'today' });
  assert.equal(parseArguments(['--staging', '/s', '--state', '/t', '--edition', '2026-09-05', '--dry-run']).edition, '2026-09-05');
  for (const value of ['tomorrow', '2026-9-5', '', 'edition/2026-09-05', '2026-09-05 '])
    assert.throws(() => parseArguments(['--staging', '/s', '--state', '/t', '--edition', value, '--dry-run']), /must be "today" or YYYY-MM-DD/u, value);
  // The two halves of an unattended publication are not separable: the date
  // proves current-edition is not stale, the receipt proves the bytes are the
  // ones pressman built. `--edition` without `--state` is refused outright.
  assert.throws(() => parseArguments(['--staging', '/s', '--edition', 'today', '--dry-run']), /--edition requires --state/u);
});

test('the timer publishes today\'s paper or nothing, on the Berlin clock', () => {
  // 2026-09-06 17:00 Berlin is 15:00 UTC. Berlin remains the edition clock for
  // timer runs and manual retries near local midnight.
  assert.equal(berlinToday(new Date('2026-09-06T15:00:00Z')), '2026-09-06');
  assert.equal(berlinToday(new Date('2026-09-06T22:30:00Z')), '2026-09-07');
  assert.equal(assertRequestedEdition('2026-09-06', undefined), '2026-09-06');
  assert.equal(assertRequestedEdition('2026-09-06', 'today', new Date('2026-09-06T15:00:00Z')), '2026-09-06');
  assert.equal(assertRequestedEdition('2026-09-06', '2026-09-06'), '2026-09-06');
  // A stale current-edition — yesterday's paper, or a rehearsal's — is the
  // failure this exists for: it refuses and nothing is pushed.
  assert.throws(() => assertRequestedEdition('2026-09-05', 'today', new Date('2026-09-06T15:00:00Z')), /the promoted edition is 2026-09-05, but "today" means 2026-09-06/u);
  assert.throws(() => assertRequestedEdition('2026-09-05', '2026-09-06'), /the promoted edition is 2026-09-05/u);
  assert.throws(() => assertRequestedEdition('2026-09-05', 'tomorrow'), /must be "today" or YYYY-MM-DD/u);
});

test('the byline view is rebuilt from the branch tree, and nothing that feeds the image is', async () => {
  assert.deepEqual(GENERATED_INDEX_PATHS, ['content/bylines']);
  await assert.rejects(regenerateIndexes('relative/tree'), /must be an absolute path/u);

  const tree = scratch('tree');
  mkdirSync(join(tree, 'content', 'editions', '2026-09-05', 'articles'), { recursive: true });
  writeFileSync(join(tree, 'content', 'topics.json'), JSON.stringify(TOPICS_JSON));
  seedOrganization(tree);
  git(['init', '-q', '-b', BASE_BRANCH], tree);
  git(['add', '-A'], tree);
  writeFileSync(join(tree, 'content', 'editions', '2026-09-05', 'articles', 'one.json'), JSON.stringify({ id: 'one', edition_date: '2026-09-05', section: 'world', epistemic: 'fact', topics: ['oil'], headline: 'A headline', byline: { desk: 'Test Desk', agents: ['Cogsworth'] } }));
  const spawnfile = readFileSync(join(tree, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'), 'utf8');

  const first = await regenerateIndexes(tree);
  assert.deepEqual(first.bylines, ['content/bylines/cogsworth.tsv']);
  assert.equal(first.articles, 1);
  assert.match(readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8'), /^2026-09-05\tone\tworld\tfact\toil\tA headline$/mu);
  // No repin, no topic view: the Spawnfile pins are exactly what they were.
  assert.equal(readFileSync(join(tree, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'), 'utf8'), spawnfile);
  assert.throws(() => readFileSync(join(tree, 'content', 'topics.txt')), /ENOENT/u);

  // A pure function of the tree: a second run is byte-identical, which is what
  // keeps a retried push rebuilding the same commit object.
  const before = readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8');
  await regenerateIndexes(tree);
  assert.equal(readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8'), before);
});

test('an edition commit may carry published content and nothing else', () => {
  assert.deepEqual(contentOnlyFindings(['content/editions/2026-09-05/articles/one.json', 'content/bylines/cogsworth.tsv']), []);
  for (const name of ['agentic-org/agents/cogsworth/Spawnfile', 'agentic-org/newsroom-runtime-bundle.json', 'content/topics.txt', 'content/agents/vesta.json', 'website/src/x.ts', 'content/editions-but-not-really'])
    assert.equal(contentOnlyFindings([name]).length, 1, name);
  // merge-edition.yml spells the same list in YAML; the two cannot drift apart.
  const workflow = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'merge-edition.yml'), 'utf8');
  const allowed = /^\s*ALLOWED_PATHS: "([^"]*)"$/mu.exec(workflow)?.[1].split(/\s+/u).filter(Boolean);
  assert.deepEqual(allowed, [...PUBLIC_CONTENT_PATHS]);
  assert.doesNotMatch(workflow, /CHECKSUM_ONLY/u, 'nothing under agentic-org/ is admitted on any leash any more');
});

test('a staged tree outside the published content is refused before anything is pushed', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-11');
  const work = scratch('work');
  await assert.rejects(pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-11'), editionSource: staged.source, editionPath: 'agentic-org/agents/cogsworth/smuggled',
    workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-11')
  }), /is not published content the content volume serves/u);
  assert.deepEqual(origin.refs(), ['refs/heads/main']);
  assert.equal(origin.head(), before);
});

test('a real push creates the edition branch and leaves main exactly where it was', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-09');
  const work = scratch('work');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-09'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-09')
  });
  assert.equal(result.branch, 'edition/2026-09-09');
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.equal(result.base, before);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-09', 'refs/heads/main']);
  assert.equal(origin.head(), before, 'main moved');
  const bare = origin.url;
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%s', result.commit], { encoding: 'utf8' }).trim(), 'chore(edition): add the 2026-09-09 edition');
  assert.match(execFileSync('git', ['-C', bare, 'show', `${result.commit}:content/editions/2026-09-09/articles/one.json`], { encoding: 'utf8' }), /"id":"one"/u);
  // The pushed tree is what ci.yml will check out: regenerating both indexes
  // over it must leave the working tree clean, which is `git diff --exit-code`.
  const checkout = scratch('ci');
  git(['clone', '-q', '--branch', result.branch, bare, checkout], checkout);
  assert.equal(ciDriftCheck(checkout), '', 'the pushed branch would fail the CI drift check');
  // The commit is pinned to the edition's release instant, so a retry after a
  // failed push rebuilds the identical object rather than a new one.
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%aI', result.commit], { encoding: 'utf8' }).trim(), '2026-09-09T18:00:00+02:00');
});

test('a push aimed at main is refused before git runs and the remote is untouched', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-05');
  const work = scratch('work');
  for (const branch of ['main', 'refs/heads/main', 'edition/main', 'staging']) {
    await assert.rejects(pushStagedEditionTree({
      url: origin.url, branch, editionSource: staged.source, editionPath: staged.path,
      workdir: join(work, 'repo'), home: join(work, 'home'), message: 'chore: nope'
    }), /not an edition branch|protected ref/u, branch);
  }
  assert.deepEqual(origin.refs(), ['refs/heads/main']);
  assert.equal(origin.head(), before);
});

test('the commit carries only the edition directory, whatever else is in the tree', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-06');
  const work = scratch('work'), workdir = join(work, 'repo');
  mkdirSync(join(workdir, '.home'), { recursive: true });
  // Scratch the run leaves behind in its own workdir: a credential-shaped file
  // and the git home the push runs under. Neither may ride along in the commit.
  writeFileSync(join(workdir, '.home', 'leftover-key'), 'PRIVATE\n');
  writeFileSync(join(workdir, 'stray.txt'), 'not part of the edition\n');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-06'), editionSource: staged.source, editionPath: staged.path,
    workdir, home: join(work, 'home'), message: editionCommitMessage('2026-09-06')
  });
  const files = execFileSync('git', ['-C', origin.url, 'diff', '--name-only', `${result.base}..${result.commit}`], { encoding: 'utf8' }).trim().split('\n');
  // The edition directory and the byline view ci.yml diff-checks -- and nothing
  // else: not the stray file, not the git home, and NOT an image input,
  // which is what used to make every edition a release.
  assert.deepEqual(files.sort(), ['content/bylines/cogsworth.tsv', 'content/editions/2026-09-06/articles/one.json']);
  assert.deepEqual(contentOnlyFindings(files), []);
});

test('a retry of the same edition converges, and changed content is refused rather than forced', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-07');
  const work = scratch('work');
  let attempt = 0;
  const call = () => pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-07'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, `repo-${attempt += 1}`), home: join(work, 'home'), message: editionCommitMessage('2026-09-07')
  });
  const first = await call();
  // The commit is fully determined by the base, the staged tree, the pinned
  // author identity and the pinned release instant, so a retry after a network
  // failure rebuilds the same object and the push is a no-op fast-forward.
  const second = await call();
  assert.equal(second.commit, first.commit);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-07', 'refs/heads/main']);
  // Different staged content is a different commit that is not a descendant of
  // what is already on the branch. Without a force flag git must refuse it.
  writeFileSync(join(staged.source, 'articles', 'two.json'), '{"id":"two"}\n');
  await assert.rejects(call(), /non-fast-forward|rejected|failed/iu);
  assert.equal(execFileSync('git', ['-C', origin.url, 'rev-parse', 'refs/heads/edition/2026-09-07'], { encoding: 'utf8' }).trim(), first.commit);
});

test('an edition already merged into the base is a quiet success, not a nightly alarm', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-09');
  const work = scratch('work');
  let attempt = 0;
  const call = () => pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-09'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, `repo-${attempt += 1}`), home: join(work, 'home'), message: editionCommitMessage('2026-09-09')
  });
  const first = await call();
  assert.equal(first.pushed, true);
  assert.equal(first.already_published, false);
  // merge-edition.yml merges it. The timer fires again the next night with the
  // same `current-edition` still on the volume: there is nothing to push, and
  // saying so is a success. An error here raises the alarm every night after a
  // successful publication, which is how an alarm stops being read.
  origin.merge(first.commit);
  const second = await call();
  assert.equal(second.already_published, true);
  assert.equal(second.pushed, false);
  assert.equal(second.commit, origin.head());
  assert.equal(second.generated, null, 'nothing is regenerated for a branch that will not be built');
});

test('an edition lands green on an organization base without touching any image input', async () => {
  // The published editions are not in the source bundle, so an edition branch
  // changes no image input and needs no rebuild.
  for (const organization of [true, false]) {
    const origin = remote({ organization });
    const staged = stagedEdition('2026-09-10');
    const work = scratch('work');
    const result = await pushStagedEditionTree({
      url: origin.url, branch: editionBranch('2026-09-10'), editionSource: staged.source, editionPath: staged.path,
      workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-10')
    });
    assert.equal(result.pushed, true);
    const files = execFileSync('git', ['-C', origin.url, 'diff', '--name-only', `${result.base}..${result.commit}`], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(files.sort(), ['content/bylines/cogsworth.tsv', 'content/editions/2026-09-10/articles/one.json']);
    if (organization) assert.deepEqual(imageInputs(origin.url, result.commit), imageInputs(origin.url, result.base), 'an edition commit changes nothing the image is built from');
  }
});

test('the edition path may not escape the branch', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-05');
  const work = scratch('work');
  for (const editionPath of ['/etc', '../outside', 'content/../../outside']) {
    await assert.rejects(pushStagedEditionTree({
      url: origin.url, branch: editionBranch('2026-09-05'), editionSource: staged.source, editionPath,
      workdir: join(work, 'repo'), home: join(work, 'home'), message: 'chore: nope'
    }), /must stay inside the branch/u, editionPath);
  }
});

test('end to end: a promoted artifact becomes an edition branch on a real remote', async () => {
  const origin = remote(), before = origin.head();
  const staging = scratch('staging'), state = scratch('state');
  const artifact = '2026-09-08-fedcba9876543210';
  const editionDir = join(staging, artifact, 'content', 'editions', '2026-09-08');
  mkdirSync(join(editionDir, 'pages'), { recursive: true });
  writeFileSync(join(editionDir, 'pages', 'front.json'), '{"page":"front"}\n');
  symlinkSync(artifact, join(staging, 'current-edition'));
  const receipts = join(state, 'editions', '2026-09-08', 'receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, 'staged-fedcba9876543210.json'), JSON.stringify({
    state: 'staged', edition: '2026-09-08',
    composition_digest: `sha256:fedcba9876543210${'0'.repeat(48)}`,
    artifact_digest: await artifactDigest(join(staging, artifact)),
    staging_root: `${CONTAINER_STAGING}/${artifact}`
  }));
  // The two provenance records: what the container composed against, and what
  // the host says it landed. They agree, so this edition may be published.
  writeFileSync(join(receipts, `composed-fedcba9876543210${'0'.repeat(48)}.json`), JSON.stringify({
    kind: 'composed', edition: '2026-09-08', digest: `sha256:fedcba9876543210${'0'.repeat(48)}`,
    composition: { tree: { articles: [] }, corpus: { version: 'clank.research-corpus.identity.v1', commit: CORPUS_A, ref: 'refs/remotes/origin/edition/2026-09-08', edition: '2026-09-08', fetched_at: CONTAINER_FETCHED_AT, tree: `trees/${CORPUS_A}` } }
  }));
  const landedFile = landed('2026-09-08');

  const key = join(scratch('keys'), 'clankandslop');
  writeFileSync(key, 'unused-for-a-file-remote\n', { mode: 0o600 });
  const result = await publishEditionBranch({ staging, state, key, landed: landedFile }, origin.url);
  assert.equal(result.edition, '2026-09-08');
  assert.equal(result.branch, 'edition/2026-09-08');
  assert.equal(result.pushed, true);
  assert.equal(result.published, false);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-08', 'refs/heads/main']);
  assert.equal(origin.head(), before, 'main moved');
  assert.equal(execFileSync('git', ['-C', origin.url, 'show', `${result.commit}:content/editions/2026-09-08/pages/front.json`], { encoding: 'utf8' }), '{"page":"front"}\n');
  // THE PUSHED ARTIFACT CARRIES THE HOST'S ASSERTION. Not a copy of the
  // container's record: the commit and the instant are the host's, and the
  // container's own `fetched_at` appears nowhere in the published tree.
  const published = execFileSync('git', ['-C', origin.url, 'show', `${result.commit}:content/editions/2026-09-08/${CORPUS_PROVENANCE_FILE}`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(published), {
    version: CORPUS_PROVENANCE_VERSION, edition: '2026-09-08', asserted_by: 'host',
    corpus: { commit: CORPUS_A, tree: `trees/${HOST_REVISION}`, landed_at: HOST_LANDED_AT },
    commissioned_ref: 'refs/remotes/origin/edition/2026-09-08'
  });
  // `corpus` carries the host's values only — the branch name is the container's
  // word and sits outside what `asserted_by: host` vouches for.
  assert.equal(JSON.parse(published).corpus.ref, undefined);
  assert.doesNotMatch(published, new RegExp(CONTAINER_FETCHED_AT, 'u'));
  // A dry run builds the same commit and touches nothing on the remote.
  const dry = await publishEditionBranch({ staging, state, dryRun: true, landed: landedFile }, origin.url);
  assert.equal(dry.pushed, false);
  assert.equal(dry.commit, result.commit);
  // The remote is a compile-time constant: no command line can redirect it.
  assert.throws(() => parseArguments(['--staging', '/s', '--url', 'git@evil.invalid:x/y.git']), /unknown argument/u);
  assert.throws(() => parseArguments(['--staging', '/s', '--remote', 'other']), /unknown argument/u);
});

// --- provenance the host asserts, not the container --------------------------
// uid 2000 — the agents' own uid — owns the corpus volume root, and the
// container's ownership guard rechowns it on every start, so a `CORPUS.json` on
// the mount and every receipt derived from it are self-asserted by the agents
// they are supposed to constrain. Verified on the production host:
// `docker exec --user 2000:2000 … 'echo forged > <volume>/CORPUS.json'` CREATES
// the file. These are the refusals that stop that claim from becoming the
// published paper's provenance.

test('the corpus claim is read from the composition the staged receipt names', async () => {
  const staged = await promoted('2026-09-11', 'abcdef0123456789');
  const digest = staged.receipt.composition_digest;
  // No composition receipt yet: the records carry no corpus identity, which is
  // the backfill case and NOT a malformed-records throw.
  const absent = await editionCorpusClaim(staged.state, '2026-09-11', digest);
  assert.equal(absent.claim, null);
  assert.match(absent.reason, /is missing or unparseable/u);
  const composed = commission(staged, '2026-09-11');
  assert.deepEqual((await editionCorpusClaim(staged.state, '2026-09-11', digest)).claim,
    { commit: CORPUS_A, ref: 'refs/remotes/origin/edition/2026-09-11', tree: `trees/${CORPUS_A}` });
  // An edition composed before provenance existed: the receipt is there, the
  // corpus is not. Overridable, so it reports rather than throws.
  composed.write({ ...composed.value, composition: { tree: { articles: [] } } });
  assert.equal((await editionCorpusClaim(staged.state, '2026-09-11', digest)).claim, null);
  // A corpus record that contradicts ITSELF is broken records, never a backfill:
  // it throws, and no operator flag can wave it through.
  for (const corpus of [{ commit: 'nope' }, { edition: '2026-09-12' }, { tree: `trees/../${CORPUS_B}` }, { commit: CORPUS_A.toUpperCase() }]) {
    composed.write({ ...composed.value, composition: { tree: { articles: [] }, corpus: { ...composed.value.composition.corpus, ...corpus } } });
    await assert.rejects(editionCorpusClaim(staged.state, '2026-09-11', digest), /malformed research-corpus identity/u, JSON.stringify(corpus));
  }
  // A receipt that describes a different composition than the one staged.
  composed.write({ ...composed.value, digest: `sha256:${'c'.repeat(64)}` });
  await assert.rejects(editionCorpusClaim(staged.state, '2026-09-11', digest), /is not the composed receipt/u);
  await assert.rejects(editionCorpusClaim('relative', '2026-09-11', digest), /must be an absolute path/u);
  await assert.rejects(editionCorpusClaim(staged.state, '2026-09-11', undefined), /records no composition digest/u);
});

test('the host corpus record is read from outside the volume and every defect refuses', async () => {
  // Spawnfile keeps it beside the volume, root-owned, never inside it.
  assert.equal(DEFAULT_LANDED_RECORD, '/var/lib/docker/volumes/clank-newsroom-corpus/spawnfile-feed/landed.json');
  assert.equal(LANDED_VERSION, 'spawnfile.volume-feed-landed.v1');
  assert.deepEqual(landedCorpus(landed('2026-09-11'), '2026-09-11'), { commit: CORPUS_A, tree: `trees/${HOST_REVISION}`, landed_at: HOST_LANDED_AT });
  assert.throws(() => landedCorpus(join(scratch('landed'), 'absent.json'), '2026-09-11'), /does not exist[\s\S]*does not publish provenance the container asserted about itself/u);
  assert.throws(() => landedCorpus('relative/landed.json', '2026-09-11'), /must be absolute/u);
  assert.throws(() => landedCorpus(landed('2026-09-10'), '2026-09-11'), /has no entry for edition 2026-09-11/u);
  const good = hostRecord('2026-09-11');
  for (const [label, body] of [
    ['a version this job does not read', { ...good, version: 'spawnfile.volume-feed-landed.v2' }],
    ['another volume', { ...good, identity: { ...good.identity, resource: 'public-content-volume' } }],
    ['a commit that is not a sha', { ...good, identity: { ...good.identity, source: { ...good.identity.source, commit: 'short' } } }],
    ['a serving tree that is not the identity\'s', { ...good, tree: 'c'.repeat(64) }],
    ['no instant it landed at', { ...good, identity: { ...good.identity, landed_at: undefined } }]
  ]) assert.throws(() => landedCorpus(landed('2026-09-11', { body }), '2026-09-11'), /cannot be trusted/u, label);
  writeFileSync(join(scratch('landed'), 'x.json'), '');
});

test('nothing is pushed when the host cannot vouch for the corpus behind an edition', async () => {
  const edition = '2026-09-12';
  const origin = remote(), before = origin.head();
  const key = join(scratch('keys'), 'clankandslop');
  writeFileSync(key, 'unused-for-a-file-remote\n', { mode: 0o600 });
  const refuses = async (options, pattern, label) => {
    await assert.rejects(publishEditionBranch({ key, ...options }, origin.url, { warn: () => {} }), pattern, label);
    assert.deepEqual(origin.refs(), ['refs/heads/main'], label);
    assert.equal(origin.head(), before, label);
  };

  // 1. The edition's records carry no corpus identity at all.
  const bare = await promoted(edition, 'abcdef0123456789');
  await refuses({ staging: bare.root, state: bare.state, landed: landed(edition) },
    /carries no research-corpus identity in its own records[\s\S]*--allow-unprovenanced-edition/u, 'no claim');
  // 2. The host's record is not there, so only the container's word is.
  const ok = await provenanced(edition, 'abcdef0123456789');
  await refuses({ staging: ok.root, state: ok.state, landed: join(scratch('landed'), 'absent.json') },
    /does not exist[\s\S]*does not publish provenance the container asserted about itself/u, 'no host record');
  // 3. The host's record is unparseable.
  const broken = join(scratch('landed'), 'landed.json');
  writeFileSync(broken, '{ not json');
  await refuses({ staging: ok.root, state: ok.state, landed: broken }, /cannot be trusted[\s\S]*unreadable/u, 'unparseable host record');
  // 4. The host landed nothing for THIS edition.
  await refuses({ staging: ok.root, state: ok.state, landed: landed('2026-09-13') }, /has no entry for edition 2026-09-12/u, 'wrong edition');
  // 5. THE ONE THE FORGERY LOOKS LIKE: the container claims one corpus and the
  //    host landed another. The host's record is the one with authority.
  await refuses({ staging: ok.root, state: ok.state, landed: landed(edition, { commit: CORPUS_B }) },
    new RegExp(`was commissioned against corpus ${CORPUS_A}[\\s\\S]*but the host landed ${CORPUS_B}`, 'u'), 'commits disagree');
  // 6. Without --state there are no durable records to read the claim out of,
  //    so provenance cannot be established and the job refuses rather than
  //    publishing with it unknown.
  await refuses({ staging: ok.root, landed: landed(edition) }, /requires --state/u, 'no state root');
  // And none of it is overridable except the missing claim: the flag does not
  // rescue a disagreement between the host and the container.
  await refuses({ staging: ok.root, state: ok.state, landed: landed(edition, { commit: CORPUS_B }), allowUnprovenanced: true },
    /the host's record is the one with authority/u, 'the override cannot wave through a mismatch');
});

test('the one-time backfill must be asked for, says so loudly, and is recorded in the branch', async () => {
  const edition = '2026-09-14';
  const origin = remote();
  const staged = await promoted(edition, 'abcdef0123456789');
  const key = join(scratch('keys'), 'clankandslop');
  writeFileSync(key, 'unused-for-a-file-remote\n', { mode: 0o600 });
  const warned = [];
  const result = await publishEditionBranch(
    { staging: staged.root, state: staged.state, key, landed: landed(edition), allowUnprovenanced: true },
    origin.url, { warn: (line) => warned.push(line) });
  assert.equal(result.pushed, true);
  assert.match(warned.join('\n'), /PUBLISHING 2026-09-14 AS UNPROVENANCED/u);
  assert.deepEqual(result.provenance, {
    version: CORPUS_PROVENANCE_VERSION, edition, asserted_by: 'host', corpus: null,
    unprovenanced: 'this edition predates host-asserted corpus provenance and was published with --allow-unprovenanced-edition'
  });
  // Recorded in the tree, not only in the console: the published paper says of
  // itself that it cannot prove which research backed it.
  const workdir = scratch('backfill');
  git(['clone', '-q', origin.url, workdir], workdir);
  assert.equal(JSON.parse(execFileSync('git', ['-C', workdir, 'show', `${result.commit}:content/editions/${edition}/${CORPUS_PROVENANCE_FILE}`], { encoding: 'utf8' })).corpus, null);
  // It is a flag a person passes on purpose, and it is never the default.
  assert.equal(parseArguments(['--staging', '/s', '--dry-run']).allowUnprovenanced, undefined);
  assert.equal(parseArguments(['--staging', '/s', '--dry-run', '--allow-unprovenanced-edition']).allowUnprovenanced, true);
});

test('the host corpus record path is a flag, an env override, or the one default', async () => {
  assert.equal(parseArguments(['--staging', '/s', '--dry-run', '--landed', '/elsewhere/landed.json']).landed, '/elsewhere/landed.json');
  assert.equal(parseArguments(['--staging', '/s', '--dry-run', '--landed=/elsewhere/landed.json']).landed, '/elsewhere/landed.json');
  assert.equal(parseArguments(['--staging', '/s', '--dry-run']).landed, undefined);
  const edition = '2026-09-15';
  const ok = await provenanced(edition, 'abcdef0123456789');
  const staged = await resolveStagedEdition(ok.root, { stateRoot: ok.state });
  const previous = process.env.CLANK_CORPUS_LANDED;
  try {
    process.env.CLANK_CORPUS_LANDED = ok.landed;
    assert.equal((await hostAssertedProvenance({ state: ok.state }, staged)).landed_record, ok.landed);
    // The flag wins over the environment, and the default is used when neither
    // is given — which on a box without the record is a refusal, not a pass.
    const other = landed(edition, { commit: CORPUS_B });
    await assert.rejects(hostAssertedProvenance({ state: ok.state, landed: other }, staged), /but the host landed/u);
    delete process.env.CLANK_CORPUS_LANDED;
    await assert.rejects(hostAssertedProvenance({ state: ok.state }, staged), new RegExp(DEFAULT_LANDED_RECORD.replaceAll('/', '\\/').replaceAll('.', '\\.'), 'u'));
  } finally {
    if (previous === undefined) delete process.env.CLANK_CORPUS_LANDED; else process.env.CLANK_CORPUS_LANDED = previous;
  }
});

test('the provenance record is stable across runs, so a retried push converges', async () => {
  const edition = '2026-09-16';
  const origin = remote();
  const ok = await provenanced(edition, 'abcdef0123456789');
  const options = { staging: ok.root, state: ok.state, landed: ok.landed, dryRun: true };
  const first = await publishEditionBranch(options, origin.url);
  const second = await publishEditionBranch(options, origin.url, { now: new Date('2027-01-01T00:00:00Z') });
  // Nothing in the record moves with the clock: every field comes from a durable
  // record, so the retry rebuilds the identical commit object.
  assert.equal(second.commit, first.commit);
  assert.deepEqual(second.provenance, first.provenance);
  // And the file does not break the already-published path: once merge-edition.yml
  // has landed the branch, the nightly timer must still see nothing to do rather
  // than a tree that differs by a provenance file it writes itself.
  const key = join(scratch('keys'), 'clankandslop');
  writeFileSync(key, 'unused-for-a-file-remote\n', { mode: 0o600 });
  const pushed = await publishEditionBranch({ ...options, dryRun: false, key }, origin.url);
  assert.equal(pushed.pushed, true);
  origin.merge(pushed.commit);
  const again = await publishEditionBranch({ ...options, dryRun: false, key }, origin.url);
  assert.equal(again.already_published, true, 'the provenance file must not look like drift on a republished edition');
  assert.equal(again.pushed, false);
});
