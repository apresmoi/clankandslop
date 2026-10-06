import test from 'node:test';
import assert from 'node:assert/strict';
import { deskDocumentFindings, deskDocumentKeys, deskOptionalKeys } from './desk-contract.mjs';

const row = (over) => ({ call: 'A dated call that came in by 6 October.', outcome: 'open', prior_p: 0.6, ...over });
const settlements = (...rows) => deskDocumentFindings('ledger.settlements', { resolved_last_edition: rows }, { profile: 'filing' });

test('a settlement row may carry a note, may be cancelled only with one, and carries nothing else', () => {
  assert.deepEqual(settlements(row({ note: 'Checked the corpus; nothing posted.' }), row({ outcome: 'cancelled', note: 'The vote was postponed.' })), []);
  assert.match(settlements(row({ outcome: 'cancelled' })).join(), /cancelled with no note/u);
  assert.match(settlements(row({ note: '' })).join(), /note must be a non-empty string/u);
  assert.match(settlements(row({ state: 'due' })).join(), /unexpected key\(s\) \[state\]/u);
  assert.match(settlements(row({ outcome: 'due' })).join(), /hit\|miss\|open\|cancelled/u);
});

const series = (over) => ({ id: 'DGS10', group: 'rates', label: 'US 10-year Treasury yield', unit: 'percent', decimals: 2, basis: 'close', url: 'https://fred.stlouisfed.org/series/DGS10', value: 4.12, observed: '2026-10-05', previous: 4.09, previous_observed: '2026-10-02', ...over });
const worlddesk = (markets) => deskDocumentFindings('ledger.worlddesk', { world_desk: { escalation_index: 0.4, delta: 'steady', open_conflicts: 1, watch: 2, derived: true, from: 'content/log/2026-10-07/worlddesk.json', method: 'm' }, ...(markets === undefined ? {} : { markets }) }, { profile: 'filing' });
const board = (...rows) => ({ source: 'FRED, Federal Reserve Bank of St. Louis', retrieved_at: '2026-10-06T05:00:00Z', series: rows });

test('markets is optional on ledger.worlddesk and, when present, every number is observed or unavailable', () => {
  assert.deepEqual(deskDocumentKeys('ledger.worlddesk'), ['world_desk'], 'markets is not a required key');
  assert.deepEqual(deskOptionalKeys('ledger.worlddesk'), ['markets']);
  assert.deepEqual(worlddesk(undefined), []);
  assert.deepEqual(worlddesk(board(series(), series({ id: 'SP500', group: 'equities', unit: 'index', previous: undefined, previous_observed: undefined }), { ...series({ id: 'DEXJPUS', group: 'fx' }), value: undefined, observed: undefined, previous: undefined, previous_observed: undefined, unavailable: 'FRED fetch failed: HTTP 503' })), []);
  assert.match(worlddesk(board(series({ unavailable: 'HTTP 503' }))).join(), /unavailable and must carry no value/u);
  assert.match(worlddesk(board(series({ observed: undefined }))).join(), /must carry value and observed/u);
  assert.match(worlddesk(board(series({ previous_observed: '2026-10-05' }))).join(), /earlier day/u);
  assert.match(worlddesk(board(series({ group: 'crypto' }))).join(), /group must be one of/u);
  assert.match(worlddesk(board()).join(), /non-empty array/u);
});
