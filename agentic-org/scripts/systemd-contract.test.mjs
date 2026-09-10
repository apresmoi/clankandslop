import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = (name) => readFileSync(new URL(`../ops/systemd/${name}`, import.meta.url), 'utf8');

test('host job units do not require the retired alarm EnvironmentFile before ExecStart', () => {
  for (const name of ['clank-publish.service', 'clank-cycle-audit.service', 'clank-seam.service']) {
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
