import test from 'node:test';
import assert from 'node:assert/strict';
import schedule from '../policies/schedule.json' with { type: 'json' };
import { clockFromPolicy, isBerlinRelease, releaseClock } from './release-time.mjs';

test('the evening schedule preserves earlier receipt identities',()=>{
  assert.equal(releaseClock('2026-09-07'),'16:00');
  assert.equal(releaseClock('2026-09-08'),'22:00');
  assert.equal(releaseClock('2026-09-09'),'18:00');
  assert.ok(isBerlinRelease('2026-08-16','2026-08-16T16:00:00+02:00[Europe/Berlin]'));
  assert.ok(isBerlinRelease('2026-09-08','2026-09-08T22:00:00+02:00[Europe/Berlin]'));
  assert.ok(isBerlinRelease('2026-09-09','2026-09-09T18:00:00+02:00[Europe/Berlin]'));
  assert.equal(isBerlinRelease('2026-09-09','2026-09-09T22:00:00+02:00[Europe/Berlin]'),false);
  assert.equal(isBerlinRelease('2026-09-09','2026-09-09T16:00:00+02:00[Europe/Berlin]'),false);
});

test('named-zone release clocks account for winter and invalid calendar dates',()=>{
  assert.ok(isBerlinRelease('2026-11-01','2026-11-01T18:00:00+01:00[Europe/Berlin]'));
  assert.equal(isBerlinRelease('2026-11-01','2026-11-01T18:00:00+02:00[Europe/Berlin]'),false);
  assert.equal(isBerlinRelease('2026-02-30','2026-02-30T16:00:00+01:00[Europe/Berlin]'),false);
});

test('release clock history is required, not reconstructed from the current deadline',()=>{
  const changed = structuredClone(schedule);
  delete changed.release_clock;
  assert.throws(()=>clockFromPolicy(changed,'2026-09-08'),/release_clock history missing/);
});
