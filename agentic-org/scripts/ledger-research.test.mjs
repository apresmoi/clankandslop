import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLedgerDeskOpen, ledgerFilingNext, ledgerRequestId, ledgerResearchRequest } from './ledger-research.mjs';
import { openDueCalls } from '../../ops/ledger-archive.mjs';

const edition = '2026-10-07';
const calls = [{ call: 'Alito remains off the bench for Suncor when argument begins on 5 October 2026', deadline: '2026-10-05' }, { call: 'YES if the IEA posts a 100 million barrel schedule by 16:00 UTC on 6 October 2026', deadline: '2026-10-06' }];

test('Ledger asks the sensor itself, in one request the sensor accepts', () => {
  const value = JSON.parse(ledgerResearchRequest(edition, calls));
  assert.deepEqual(Object.keys(value), ['kind', 'request_id', 'from', 'edition', 'story_id', 'question', 'discriminator']);
  assert.equal(value.kind, 'research.request.v1');
  assert.equal(value.request_id, ledgerRequestId(edition));
  assert.equal(value.from, 'ledger');
  assert.match(value.question, /\(1\) Alito remains off the bench.*\[deadline 2026-10-05\] \(2\) YES if the IEA/u);
  const many = Array.from({ length: 40 }, (_, index) => ({ call: `Call number ${index} ${'x'.repeat(200)}`, deadline: null }));
  const capped = JSON.parse(ledgerResearchRequest(edition, many));
  assert.ok(Buffer.byteLength(capped.question) <= 1200, 'the sensor drops a question over 1200 bytes');
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 2048);
});

test('a filing that keeps due calls open says how to ask; one with none says nothing', () => {
  assert.equal(ledgerFilingNext(edition, []), undefined);
  const next = ledgerFilingNext(edition, calls);
  assert.match(next, /2 due call\(s\) stay open.*send this exact text with moltnet_send on network clank-newsroom to room:research.*before Caslon composes: \{"kind":"research\.request\.v1"/u);
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
