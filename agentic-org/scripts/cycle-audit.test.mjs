import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditError, LADDER, audit, countReceipts, parseArgs, stagingState } from './cycle-audit.mjs';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'clank-audit-test-'));
const receipt = (directory, kind, index) => writeFileSync(path.join(directory, `${kind}-${String(index).padStart(16, '0')}.json`), '{}');

function world(edition, kinds, { promote = false } = {}) {
  const root = scratch();
  const state = path.join(root, 'state');
  const staging = path.join(root, 'staging');
  mkdirSync(staging, { recursive: true });
  if (kinds !== null) {
    const receipts = path.join(state, 'editions', edition, 'receipts');
    mkdirSync(receipts, { recursive: true });
    kinds.forEach((kind, index) => receipt(receipts, kind, index));
  } else mkdirSync(state, { recursive: true });
  if (promote) {
    const artifact = path.join(staging, `${edition}-1200`);
    mkdirSync(path.join(artifact, 'content', 'editions', edition), { recursive: true });
    symlinkSync(`${edition}-1200`, path.join(staging, 'current-edition'));
  }
  return { root, options: { edition, state, staging, require: 'composed', quiet: true } };
}

test('the ladder rungs are the receipt kinds the newsroom actually writes', () => {
  assert.deepEqual(LADDER, ['assigned', 'filed', 'reviewed', 'composed', 'staged']);
});

test('a cycle that produced nothing at all is named as such', () => {
  const { root, options } = world('2026-09-06', null);
  try {
    const result = audit(options);
    assert.equal(result.ok, false);
    assert.equal(result.exists, false);
    assert.match(result.summary, /no edition state at all today/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cycle that stopped part way names the rung it reached', () => {
  const { root, options } = world('2026-09-06', ['assigned', 'filed', 'filed', 'reviewed']);
  try {
    const result = audit(options);
    assert.equal(result.ok, false);
    assert.equal(result.highest, 'reviewed');
    assert.equal(result.receipts.counts.filed, 2);
    assert.match(result.summary, /stopped at reviewed; composed was required/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a composed edition satisfies the default requirement', () => {
  const { root, options } = world('2026-09-06', ['assigned', 'filed', 'reviewed', 'composed']);
  try {
    const result = audit(options);
    assert.equal(result.ok, true);
    assert.equal(result.highest, 'composed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a promoted staging artifact counts as staged even before a staged receipt lands', () => {
  const { root, options } = world('2026-09-06', ['assigned', 'filed', 'reviewed', 'composed'], { promote: true });
  try {
    const result = audit({ ...options, require: 'staged' });
    assert.equal(result.staging.promoted, true);
    assert.equal(result.ok, true);
    assert.equal(result.highest, 'staged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a current-edition link pointing at yesterday is not today s edition', () => {
  const { root, options } = world('2026-09-06', ['composed'], { promote: true });
  try {
    const stale = stagingState(options.staging, '2026-09-07');
    assert.equal(stale.promoted, false);
    assert.match(stale.reason, /points at 2026-09-06-1200, not at 2026-09-07/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('desk-filed is counted separately — a day of desk files alone is still no edition', () => {
  const { root, options } = world('2026-09-06', ['desk-filed', 'desk-filed', 'assigned']);
  try {
    const result = audit(options);
    assert.equal(result.receipts.counts.filed, 0);
    assert.equal(result.receipts.other['desk-filed'], 2);
    assert.equal(result.highest, 'assigned');
    assert.equal(result.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file that is not a receipt cannot be mistaken for one', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'INDEX'), '');
    writeFileSync(path.join(directory, 'composed.json'), '{}');
    writeFileSync(path.join(directory, 'composed-abcdef01.json'), '{}');
    assert.equal(countReceipts(directory).counts.composed, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unknown --require rung is refused', () => {
  assert.throws(() => parseArgs(['--require=published']), AuditError);
  assert.equal(parseArgs(['--require=staged']).require, 'staged');
});
