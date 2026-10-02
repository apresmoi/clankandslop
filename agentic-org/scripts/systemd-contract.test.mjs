import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const unitDir = new URL('../ops/systemd/', import.meta.url);
const unit = (name) => readFileSync(new URL(name, unitDir), 'utf8');
// ENUMERATED, not listed. This read `['clank-publish.service',
// 'clank-cycle-audit.service', 'clank-seam.service']`, so the three units added
// when the corpus moved out of the image -- corpus-refresh, epoch-roll (since retired), release
// -- were outside the one contract that is supposed to hold for every host job,
// and nothing said so. An allowlist of names stops covering the thing you add
// next, silently, which is the same defect as a test that restates the number it
// guards. The template unit has its own test below.
const serviceUnits = readdirSync(unitDir).filter((name) => name.endsWith('.service') && !name.includes('@')).sort();

test('every host job unit is covered, and the list cannot fall behind the directory', () => {
  assert.ok(serviceUnits.length >= 5, `expected at least the five known host job units, found ${serviceUnits.length}: ${serviceUnits.join(', ')}`);
  for (const name of ['clank-publish.service', 'clank-cycle-audit.service', 'clank-seam.service', 'clank-corpus-refresh.service', 'clank-release.service'])
    assert.ok(serviceUnits.includes(name), `${name} is missing from ops/systemd -- a host job unit must be tracked in the repository`);
});

test('host job units do not require the retired alarm EnvironmentFile before ExecStart', () => {
  for (const name of serviceUnits) {
    const text = unit(name);
    assert.doesNotMatch(text, /EnvironmentFile=\/etc\/clank-alarm\/alarm\.env/u, `${name} must not fail before ExecStart on the retired alarm env file`);
    assert.match(text, /OnFailure=clank-alarm@%n\.service/u, `${name} must still raise the alarm on service failure`);
  }
});

test('the alarm handler itself uses the local standalone recorder, not the retired ntfy environment', () => {
  const text = unit('clank-alarm@.service');
  assert.doesNotMatch(text, /^EnvironmentFile=.*alarm\.env$/mu, 'the retired env file must not block or configure the local alarm');
  assert.doesNotMatch(text, /^ExecStart=.*alarm\.mjs/mu, 'the handler must not reactivate the legacy network alarm');
  assert.match(text, /^Environment=CLANK_ALARM_SCOPE=--system$/mu, 'system units must read systemd state through the system manager');
  assert.match(text, /^StateDirectory=clank-alarm$/mu, 'the local alarm must have a durable systemd-owned log directory');
  assert.match(text, /^ExecStart=\/usr\/local\/lib\/clank-alarm\/clank-alarm\.sh %i$/mu, 'the standalone local recorder must run');
});
