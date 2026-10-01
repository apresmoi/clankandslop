// What a World Desk filing is allowed to believe about the volume it reads.
//
// file_desk ledger.worlddesk reads the SAME host-populated research-corpus mount
// record_assignment reads, and until this suite existed it read it with none of
// record_assignment's refusals: an undeclared mount fell back to a cwd-relative
// repos/newsroom-private, CORPUS.json was never opened, and a missing mount was
// reported as a missing prepared document. So these tests are about three
// distinct causes and three distinct refusals, and every corpus here is a real
// directory with a real CORPUS.json and a real dated symlink into
// trees/<commit>/ — the link-binding check is a question about symlinks on disk
// and a mocked filesystem would answer it about nothing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installCorpusFixture } from './corpus-fixture.mjs';
import { authenticateWorldDeskFiling } from './worlddesk-filing.mjs';

const EDITION = '2026-09-11';
const OTHER_EDITION = '2026-09-10';
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const SOURCE = path.join(import.meta.dirname, 'worlddesk-filing.mjs');

const temporaries = [];
const temporary = (label) => { const dir = mkdtempSync(path.join(os.tmpdir(), `clank-worlddesk-${label}-`)); temporaries.push(dir); return dir; };
test.after(() => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }); });

// A trace and the document it substantiates, in the shape
// ops/worlddesk-contract.mjs requires: 17 of 25 severity triggering is 0.68,
// eight open entries and five on watch, and an unchanged reading is 'steady'.
const traceFor = (edition) => ({
  version: 'clank.worlddesk-trace.v1', edition,
  escalation: { registry: { sha256: '1'.repeat(64) }, index: 0.68, numerator: 17, denominator: 25, terms: [{ id: 'fixture-a', severity: 17, state: 'triggering' }, { id: 'fixture-b', severity: 8, state: 'not_triggering' }] },
  flashpoints: { registry: { sha256: '2'.repeat(64) }, open_conflicts: 8, watch: 5, entries: [...Array.from({ length: 8 }, (_, index) => ({ id: `open-${index}`, status: 'open' })), ...Array.from({ length: 5 }, (_, index) => ({ id: `watch-${index}`, status: 'watch' }))] },
  delta: { word: 'steady', current: 0.68, previous: 0.68 },
});
const documentFor = (edition) => ({ world_desk: { escalation_index: 0.68, delta: 'steady', open_conflicts: 8, watch: 5, derived: true, from: `content/log/${edition}/worlddesk.json`, method: 'clank.escalation-registry.v1 rev 1 · clank.flashpoint-registry.v1 rev 1' } });
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

// The corpus the host lays down, plus the producer's output inside it. The
// worlddesk/ directory is written THROUGH the dated symlink, exactly where the
// real producer writes it, so a test that breaks the link breaks the path to the
// document too — which is the point.
// `prepared: null` / `trace: null` leave the file off the mount; omitting them
// writes the good one. (`undefined` would silently take the default, which is a
// fixture that proves the opposite of what the test name says.)
function mount(label, { edition = EDITION, commit = COMMIT, identity, prepared = documentFor(edition), trace = traceFor(edition) } = {}) {
  const root = path.join(temporary(label), 'corpus');
  installCorpusFixture(root, edition, { commit, ...(identity ? { identity } : {}) });
  const dir = path.join(root, edition, 'worlddesk');
  if (prepared !== null) writeJson(path.join(dir, 'ledger.worlddesk.json'), prepared);
  if (trace !== null) writeJson(path.join(dir, 'trace.json'), trace);
  return root;
}
const filing = (edition = EDITION, document = documentFor(edition)) => ({ edition, event_key: `worlddesk-${edition}`, name: 'ledger.worlddesk', document });
const authenticate = (args, env) => authenticateWorldDeskFiling(args, { env, cwd: path.join(os.tmpdir(), 'clank-worlddesk-never-read') });
const rejection = async (args, env) => { try { await authenticate(args, env); } catch (error) { return error.message; } return assert.fail('the filing was authenticated'); };

test('a World Desk filing refuses an undeclared or relative corpus mount by name, with no cwd fallback', async () => {
  // The decoy is the whole test: a complete, valid corpus AND a valid prepared
  // document sitting at the cwd-relative path the deleted fallback resolved to.
  // If anything in this file still reaches for it, this filing succeeds.
  const decoyCwd = temporary('decoy');
  const decoy = mount('decoy-corpus');
  mkdirSync(path.join(decoyCwd, 'repos'), { recursive: true });
  symlinkSync(decoy, path.join(decoyCwd, 'repos/newsroom-private'));
  for (const declared of [undefined, '', 'repos/newsroom-private', './corpus', path.join('relative', EDITION)]) {
    const env = declared === undefined ? {} : { CLANK_PRIVATE_SOURCE_ROOT: declared };
    const message = await (async () => { try { await authenticateWorldDeskFiling(filing(), { env, cwd: decoyCwd }); } catch (error) { return error.message; } return assert.fail(`mount ${JSON.stringify(declared)} was accepted`); })();
    assert.match(message, /CLANK_PRIVATE_SOURCE_ROOT must be the absolute path/u, `mount ${JSON.stringify(declared)}`);
    assert.match(message, /not declared for this agent/u);
    assert.doesNotMatch(message, /prepared document|refusal at/u, 'an undeclared mount must never be reported as a missing document');
  }
  // And the identical filing against the identical corpus, declared, passes —
  // so what the refusals above reject is the declaration, not the fixture.
  await authenticate(filing(), { CLANK_PRIVATE_SOURCE_ROOT: decoy });
});

test('a World Desk filing refuses a corpus mount the host has not populated', async () => {
  const absent = path.join(temporary('absent'), 'never-mounted');
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: absent }), /cannot read the research corpus mount — .*cannot be read \(ENOENT\)/u);
  const empty = path.join(temporary('empty'), 'empty-mount');
  mkdirSync(empty, { recursive: true });
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: empty }), /cannot read the research corpus mount — .*holds no entries/u);
});

test('a World Desk filing refuses a corpus with no readable identity record', async () => {
  const missing = mount('identity-missing');
  unlinkSync(path.join(missing, 'CORPUS.json'));
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: missing }), /carries no readable identity record — .*CORPUS\.json is missing or unparseable \(ENOENT\)/u);
  const unparseable = mount('identity-unparseable');
  writeFileSync(path.join(unparseable, 'CORPUS.json'), '{ "version": truncated');
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: unparseable }), /carries no readable identity record/u);
  // A record that parses but breaks the shared contract is refused on the
  // contract's own findings, not re-litigated here.
  const malformed = mount('identity-malformed', { identity: { commit: 'not-a-sha', tree: 'trees/not-a-sha' } });
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: malformed }), /commit must be a 40-character lowercase hex sha/u);
});

test("a World Desk filing refuses a corpus that is not this edition's, naming both days", async () => {
  // The record names another day while the tree and the dated link are this
  // one's: the stale-corpus case, where every path a reader opens resolves.
  const root = mount('wrong-edition', { identity: { edition: OTHER_EDITION, editions_present: [OTHER_EDITION] } });
  const message = await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: root });
  assert.match(message, /cannot trust the research corpus: it is not this edition's/u);
  assert.match(message, new RegExp(`corpus is edition "${OTHER_EDITION}", not ${EDITION}`, 'u'));
  assert.match(message, new RegExp(`this filing is for edition "${EDITION}"`, 'u'));
});

test('a World Desk filing refuses a corpus whose dated link is not bound to the commit its record names', async () => {
  const root = mount('unbound');
  // A second tree, the dated link moved onto it, the record left naming the
  // first: a crashed refresh, or an agent relinking the volume it can write.
  mkdirSync(path.join(root, 'trees', OTHER_COMMIT, EDITION), { recursive: true });
  unlinkSync(path.join(root, EDITION));
  symlinkSync(path.join('trees', OTHER_COMMIT, EDITION), path.join(root, EDITION));
  const message = await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: root });
  assert.match(message, /does not bind edition 2026-09-11 to the commit it claims/u);
  assert.match(message, new RegExp(`CORPUS\\.json names commit ${COMMIT}`, 'u'));
  assert.match(message, /which is outside trees\/a{40}\//u);
  // Real corpus data where the link belongs is not a binding either.
  const replaced = mount('unbound-real');
  unlinkSync(path.join(replaced, EDITION));
  mkdirSync(path.join(replaced, EDITION, 'worlddesk'), { recursive: true });
  writeJson(path.join(replaced, EDITION, 'worlddesk/ledger.worlddesk.json'), documentFor(EDITION));
  writeJson(path.join(replaced, EDITION, 'worlddesk/trace.json'), traceFor(EDITION));
  assert.match(await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: replaced }), /is a real directory on the mount, not a symlink into trees\/a{40}\//u);
});

test('a missing prepared document is reported as a missing document, never as a missing mount', async () => {
  const root = mount('no-document', { prepared: null, trace: null });
  const message = await rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: root, CLANK_PUBLIC_SOURCE_ROOT: path.join(root, 'public-never-reached') });
  assert.match(message, /has a readable research corpus for edition 2026-09-11 but no World Desk document in it/u);
  assert.match(message, /ledger\.worlddesk\.json/u);
  assert.match(message, /refusal at .*refusal\.json/u);
  // The three causes are told apart by their own words, not by a shared one.
  assert.doesNotMatch(message, /CLANK_PRIVATE_SOURCE_ROOT|has not populated it|cannot trust the research corpus/u);
});

test('the three causes never share one message', async () => {
  const absent = path.join(temporary('distinct'), 'never-mounted');
  const stale = mount('distinct-stale', { identity: { edition: OTHER_EDITION, editions_present: [OTHER_EDITION] } });
  const bare = mount('distinct-bare', { prepared: null, trace: null });
  const [mountMessage, corpusMessage, documentMessage] = await Promise.all([absent, stale, bare].map((root) => rejection(filing(), { CLANK_PRIVATE_SOURCE_ROOT: root })));
  assert.equal(new Set([mountMessage, corpusMessage, documentMessage]).size, 3);
  assert.match(mountMessage, /cannot read the research corpus mount/u);
  assert.match(corpusMessage, /cannot trust the research corpus/u);
  assert.match(documentMessage, /no World Desk document in it/u);
  for (const [name, message] of [['mount', mountMessage], ['corpus', corpusMessage]]) assert.doesNotMatch(message, /no World Desk document in it/u, `the ${name} cause borrowed the document's message`);
  assert.doesNotMatch(documentMessage, /cannot read the research corpus mount|cannot trust the research corpus/u);
});

test('the corpus gate is additive: a valid filing and the stale carry-forward are unchanged', async () => {
  // 1. The ordinary path: prepared document, its trace, a trustworthy corpus.
  await authenticate(filing(), { CLANK_PRIVATE_SOURCE_ROOT: mount('valid') });

  // 2. A genuine refusal carried forward. The prior public derived document and
  //    its public trace are real files under a real public root, so this is the
  //    whole stale-carry-forward rule running, not a stub of it.
  const root = mount('refusal', { prepared: null, trace: { version: 'clank.worlddesk-trace.v1', edition: EDITION, escalation: { index: null, unresolved: ['flashpoint-registry unreachable'] } } });
  writeJson(path.join(root, EDITION, 'worlddesk/refusal.json'), { version: 'clank.worlddesk-trace.v1', edition: EDITION, refused: true, unresolved: ['flashpoint-registry unreachable'] });
  const publicRoot = path.join(temporary('public'), 'newsroom');
  writeJson(path.join(publicRoot, 'content/editions', OTHER_EDITION, 'desk/ledger.worlddesk.json'), documentFor(OTHER_EDITION));
  writeJson(path.join(publicRoot, 'content/log', OTHER_EDITION, 'worlddesk.json'), traceFor(OTHER_EDITION));
  const env = { CLANK_PRIVATE_SOURCE_ROOT: root, CLANK_PUBLIC_SOURCE_ROOT: publicRoot };
  const carried = documentFor(OTHER_EDITION); carried.world_desk.delta = 'stale';
  await authenticate(filing(EDITION, carried), env);
  // And it is still the carry-forward rule that it was: anything but the prior
  // document with only delta changed is still refused in its own words.
  assert.match(await rejection(filing(EDITION, documentFor(OTHER_EDITION)), env), /fallback must carry the latest prior derived public World Desk document/u);
  // A refusal still has to come off a corpus this edition can be filed against.
  const unmounted = { ...env, CLANK_PRIVATE_SOURCE_ROOT: path.join(temporary('refusal-unmounted'), 'never-mounted') };
  assert.match(await rejection(filing(EDITION, carried), unmounted), /cannot read the research corpus mount/u);
});

test('the source carries no cwd-relative corpus fallback for anybody to reintroduce', () => {
  // Comments are stripped first: this file's own prose explains the deleted
  // fallback by name, and an assertion that a comment can satisfy is not an
  // assertion. Every surviving line is code.
  const code = readFileSync(SOURCE, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /newsroom-private/u, 'the corpus mount must come from the environment, never from a path baked into this file');
  assert.doesNotMatch(code, /CLANK_PRIVATE_SOURCE_ROOT\s*(\?\?|\|\|)/u, 'an undeclared corpus mount must refuse, not default');
});

// The gate has to be reached through the real tool, not only through the
// function: file_desk validates the document's shape first, and a gate that sits
// behind an unreachable branch is a comment. Needs the private state adapter
// because every newsroom operation runs inside its transaction.
test('file_desk ledger.worlddesk refuses an unreadable corpus through the real tool', { skip: !process.env.CLANK_NEWSROOM_STATE_ADAPTER && 'private newsroom state adapter unavailable; run the private integration gate' }, async () => {
  const { fileDesk } = await import('./production-newsroom.mjs');
  const previous = { agent: process.env.CLANK_NEWSROOM_AGENT, state: process.env.CLANK_EDITION_STATE_ROOT, privateRoot: process.env.CLANK_PRIVATE_SOURCE_ROOT };
  process.env.CLANK_NEWSROOM_AGENT = 'ledger';
  process.env.CLANK_EDITION_STATE_ROOT = path.join(temporary('tool'), 'state');
  try {
    delete process.env.CLANK_PRIVATE_SOURCE_ROOT;
    await assert.rejects(fileDesk(filing()), /CLANK_PRIVATE_SOURCE_ROOT must be the absolute path/u);
    process.env.CLANK_PRIVATE_SOURCE_ROOT = mount('tool-wrong-edition', { identity: { edition: OTHER_EDITION, editions_present: [OTHER_EDITION] } });
    await assert.rejects(fileDesk(filing()), /cannot trust the research corpus: it is not this edition's/u);
    process.env.CLANK_PRIVATE_SOURCE_ROOT = mount('tool-valid');
    assert.equal((await fileDesk(filing())).name, 'ledger.worlddesk');
  } finally {
    for (const [key, value] of [['CLANK_NEWSROOM_AGENT', previous.agent], ['CLANK_EDITION_STATE_ROOT', previous.state], ['CLANK_PRIVATE_SOURCE_ROOT', previous.privateRoot]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
