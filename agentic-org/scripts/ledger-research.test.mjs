import assert from 'node:assert/strict';
import test from 'node:test';
import { LEDGER_REQUESTS_MAX, assertLedgerDeskOpen, ledgerFilingNext, ledgerRequestId, ledgerResearchRequest } from './ledger-research.mjs';
import { openDueCalls } from '../../ops/ledger-archive.mjs';

const edition = '2026-10-07';
const calls = [{ call: 'Alito remains off the bench for Suncor when argument begins on 5 October 2026', deadline: '2026-10-05' }, { call: 'YES if the IEA posts a 100 million barrel schedule by 16:00 UTC on 6 October 2026', deadline: '2026-10-06' }];

test('Ledger asks the sensor itself, one whole call per request, under an id stable across refiles', () => {
  const value = JSON.parse(ledgerResearchRequest(edition, calls[0]));
  assert.deepEqual(Object.keys(value), ['kind', 'request_id', 'from', 'edition', 'story_id', 'question', 'discriminator']);
  assert.equal(value.kind, 'research.request.v1');
  assert.equal(value.from, 'ledger');
  assert.match(value.request_id, /^ledger-2026-10-07-call-[0-9a-f]{10}$/u);
  assert.equal(value.request_id, ledgerRequestId(edition, `  ${calls[0].call.toUpperCase()} `), 'the id survives whitespace and case');
  assert.notEqual(value.request_id, ledgerRequestId(edition, calls[1].call));
  assert.match(value.question, /\(deadline 2026-10-05\).*The call: Alito remains off the bench for Suncor when argument begins on 5 October 2026$/u, 'the whole call, criteria included');
  const huge = JSON.parse(ledgerResearchRequest(edition, { call: 'x'.repeat(5000), deadline: null }));
  assert.ok(Buffer.byteLength(huge.question) <= 1200 && Buffer.byteLength(JSON.stringify(huge)) <= 2048, 'the sensor drops anything larger');
});

test('a filing that keeps due calls open lists one request per call, up to the cap, and says what is left', () => {
  assert.equal(ledgerFilingNext(edition, []), undefined);
  const next = ledgerFilingNext(edition, calls);
  assert.match(next, /2 due call\(s\) stay open.*own moltnet_send on network clank-newsroom to room:research.*before Caslon composes/u);
  assert.equal([...next.matchAll(/"kind":"research\.request\.v1"/gu)].length, 2);
  const six = Array.from({ length: LEDGER_REQUESTS_MAX + 2 }, (_, index) => ({ call: `Call ${index} settles on a dated official record`, deadline: '2026-10-06' }));
  const capped = ledgerFilingNext(edition, six);
  assert.equal([...capped.matchAll(/"kind":"research\.request\.v1"/gu)].length, LEDGER_REQUESTS_MAX);
  assert.match(capped, /2 more due call\(s\) are not asked today/u);
});

test('a Ledger refile after composition is refused, unless it changes nothing', () => {
  assert.throws(() => assertLedgerDeskOpen('ledger.settlements', edition, { composed: true }), /is composed; refiling ledger\.settlements now would change the desk the composition sealed.*Nothing was recorded/u);
  assert.throws(() => assertLedgerDeskOpen('ledger.worlddesk', edition, { composed: true }), /is composed/u);
  assert.doesNotThrow(() => assertLedgerDeskOpen('ledger.settlements', edition, { composed: true, unchanged: true }));
  assert.doesNotThrow(() => assertLedgerDeskOpen('ledger.settlements', edition, { composed: false }));
  // Caslon recomposes after its own desk refile, so its desk stays open.
  assert.doesNotThrow(() => assertLedgerDeskOpen('caslon.chrome', edition, { composed: true }));
});

test('the due calls Ledger asks about are the archive calls past deadline its filing keeps open', () => {
  const due = openDueCalls('2026-10-07', { resolved_last_edition: [] });
  assert.ok(due.length > 0, 'the archive carries calls due by 7 October');
  for (const entry of due) assert.ok(entry.deadline === null || entry.deadline < '2026-10-07', `${entry.call} is not yet due`);
  const settled = openDueCalls('2026-10-07', { resolved_last_edition: due.map(({ call }) => ({ call, outcome: 'miss', prior_p: 0.5 })) });
  assert.deepEqual(settled, [], 'a call the filing settles is not asked about');
});
