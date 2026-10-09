import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alarmFor } from './release-notify.mjs';

const script = new URL('./release-notify.mjs', import.meta.url).pathname;
const notification = (fields = {}) => ({ version: 'spawnfile.release-notification.v1', reason: 'post-deploy-failed', deployment: 'clank-and-slop', host: 'h', identity: `sha256:${'a'.repeat(64)}`, message: 'bootstrap exited 1', at: '2026-10-09T00:00:00.000Z', ...fields });

// Spawnfile runs the notifier as an executable with no shell and no arguments.
const run = (input, environment) => spawnSync(script, [], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...environment } });

test('maps Spawnfile reasons onto the fixed alarm vocabulary and keeps the exact word', () => {
  assert.deepEqual(alarmFor(notification({ reason: 'release-deferred', identity: null, message: 'pending 25h' })), { reason: 'release-deferred', message: 'spawnfile release release-deferred: pending 25h' });
  const failed = alarmFor(notification());
  assert.equal(failed.reason, 'deploy-failed');
  assert.match(failed.message, /^spawnfile release post-deploy-failed \(sha256:aaaaaaaaaaaa\): bootstrap exited 1$/u);
  assert.throws(() => alarmFor({ reason: 'x' }), /release-notification\.v1/u);
});

test('records the notification in the alarm spool and exits 0 on a host without a channel', () => {
  const spool = mkdtempSync(path.join(tmpdir(), 'clank-release-notify-'));
  try {
    assert.ok(statSync(script).mode & 0o111, 'the notifier must be executable: Spawnfile runs it directly');
    const result = run(`${JSON.stringify(notification())}\n`, { CLANK_ALARM_SPOOL: spool, CLANK_ALARM_HOST: 'test' });
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(spool).filter((name) => name.endsWith('.deploy-failed.json'));
    assert.equal(files.length, 1, readdirSync(spool).join(', '));
    const body = JSON.parse(readFileSync(path.join(spool, files[0]), 'utf8'));
    assert.match(JSON.stringify(body), /post-deploy-failed/u);
  } finally { rmSync(spool, { recursive: true, force: true }); }
});

test('refuses input that is not a release notification', () => {
  const spool = mkdtempSync(path.join(tmpdir(), 'clank-release-notify-'));
  try {
    assert.equal(run('not json', { CLANK_ALARM_SPOOL: spool }).status, 64);
    assert.equal(run(JSON.stringify({ version: 'other' }), { CLANK_ALARM_SPOOL: spool }).status, 64);
    assert.deepEqual(readdirSync(spool), []);
  } finally { rmSync(spool, { recursive: true, force: true }); }
});
