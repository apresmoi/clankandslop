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
