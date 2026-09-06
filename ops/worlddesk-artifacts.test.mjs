// The producer's World Desk artifacts, checked against the contract this repo
// actually enforces — not against a copy of it.
//
// sensors/automation/desk-worlddesk.mjs lives in the private producer repo and
// cannot import ops/desk-contract.mjs. This test closes that gap from the other
// end: it reads the documents the producer actually shipped under
// content/log/<date>/ and runs them through the real deskDocumentFindings, so
// a producer change that violates the contract fails HERE, in the repo whose
// build the contract protects.
//
// It also checks the two things that make a published number checkable rather
// than merely present: every escalation term names a URL a reader can
// re-fetch, and every counted flashpoint expands into the stories and URLs
// that qualified it.
//
// Run: node --test ops/worlddesk-artifacts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deskDocumentFindings, EDITION_PART_FILES } from './desk-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logRoot = resolve(root, 'content', 'log');
const editions = readdirSync(logRoot).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
const read = (date, name) => JSON.parse(readFileSync(resolve(logRoot, date, name), 'utf-8'));

test('there is at least one derived World Desk reading to check', () => {
  assert.ok(editions.length > 0, 'content/log/ carries no dated derive output');
});

for (const date of editions) {
  test(`${date}: the prepared desk documents satisfy ops/desk-contract.mjs`, () => {
    assert.deepEqual(deskDocumentFindings('ledger.worlddesk', read(date, 'ledger.worlddesk.json')), []);
    assert.deepEqual(deskDocumentFindings('caslon.weather', read(date, 'caslon.weather.json')), []);
  });

  // The producer adds derived/from/method inside world_desk. The contract
  // rejects unexpected TOP-LEVEL keys only, so this must stay clean — if a
  // future contract tightens the inner object, this is where it surfaces
  // before an edition build crashes on it.
  test(`${date}: the derivation stamp rides inside world_desk without breaking the contract`, () => {
    const document = read(date, 'ledger.worlddesk.json');
    assert.deepEqual(Object.keys(document), ['world_desk']);
    assert.equal(document.world_desk.derived, true);
    assert.equal(document.world_desk.from, `content/log/${date}/worlddesk.json`);
    assert.deepEqual(deskDocumentFindings('ledger.worlddesk', document), []);
  });

  test(`${date}: world_desk.from resolves, and the trace reproduces every published number`, () => {
    const document = read(date, 'ledger.worlddesk.json').world_desk;
    const trace = read(date, 'worlddesk.json');
    assert.equal(trace.version, 'clank.worlddesk-trace.v1');
    assert.equal(trace.edition, date);

    // Recompute the index from the trace's own terms rather than trusting it.
    const denominator = trace.escalation.terms.reduce((sum, t) => sum + t.severity, 0);
    const numerator = trace.escalation.terms.filter((t) => t.state === 'triggering').reduce((sum, t) => sum + t.severity, 0);
    assert.equal(denominator, trace.escalation.denominator);
    assert.equal(numerator, trace.escalation.numerator);
    assert.equal(document.escalation_index, Number((numerator / denominator).toFixed(4)));

    // Counts must equal the entries the trace actually classified.
    assert.equal(document.open_conflicts, trace.flashpoints.entries.filter((e) => e.status === 'open').length);
    assert.equal(document.watch, trace.flashpoints.entries.filter((e) => e.status === 'watch').length);
    assert.equal(document.delta, trace.delta.word);
  });

  test(`${date}: every escalation term names a source a reader can re-fetch`, () => {
    const trace = read(date, 'worlddesk.json');
    assert.ok(trace.escalation.terms.length > 0);
    for (const term of trace.escalation.terms) {
      assert.match(term.source_url, /^https:\/\//, `${term.id} has no https source_url`);
      assert.ok(term.threshold_basis?.percentile, `${term.id} does not say how its threshold was set`);
      assert.ok(Number.isFinite(term.threshold), `${term.id} has no frozen threshold`);
      if (term.state !== 'unresolved') {
        assert.ok(Number.isFinite(term.observed), `${term.id} is resolved but carries no observation`);
        assert.match(term.observed_at, /^\d{4}-\d{2}-\d{2}$/, `${term.id} does not say when it was observed`);
        assert.ok(Number.isFinite(term.max_stale_days), `${term.id} does not state its staleness allowance`);
        assert.ok(term.stale_days <= term.max_stale_days, `${term.id} is resolved but staler than its own allowance`);
      }
    }
    // No unresolved term may coexist with a published index.
    if (trace.escalation.index !== null) assert.deepEqual(trace.escalation.unresolved, []);
  });

  test(`${date}: every counted flashpoint expands into named stories and source URLs`, () => {
    const trace = read(date, 'worlddesk.json');
    const policy = trace.flashpoints.policy;
    for (const entry of trace.flashpoints.entries) {
      if (entry.status === 'dormant') {
        assert.ok(entry.evidence_count < policy.watch_min_stories, `${entry.id} is dormant but carries evidence`);
        continue;
      }
      const rows = entry.evidence.length > 0 ? entry.evidence : entry.prior_evidence ?? [];
      assert.ok(rows.length > 0, `${entry.id} is ${entry.status} with no evidence at all`);
      for (const row of rows) {
        assert.match(row.story_id, /^s-[0-9a-f]+$/, `${entry.id} evidence has no story id`);
        assert.match(row.source_url, /^https?:\/\//, `${entry.id} evidence row ${row.story_id} has no source URL`);
        assert.ok(Array.isArray(row.matched) && row.matched.length > 0, `${entry.id} does not say which term fired`);
        assert.ok(row.observed_at, `${entry.id} evidence row ${row.story_id} has no observation time`);
      }
      if (entry.status === 'open') assert.ok(entry.evidence.length >= policy.open_min_stories);
    }
  });

  test(`${date}: delta is derived, and a first reading is not dressed as a direction`, () => {
    const trace = read(date, 'worlddesk.json');
    if (trace.delta.previous === null) {
      assert.equal(trace.delta.word, 'first reading');
      assert.equal(trace.delta.previous_edition, null);
      assert.equal(trace.delta.change, null);
    } else {
      assert.ok(['rising', 'easing', 'steady'].includes(trace.delta.word));
      assert.equal(trace.delta.change, Number((trace.delta.current - trace.delta.previous).toFixed(4)));
    }
  });

  test(`${date}: the trace states what the number does NOT measure`, () => {
    const trace = read(date, 'worlddesk.json');
    assert.ok(trace.review.not_measured.length > 0, 'a published index with no stated limits is a claim, not a measurement');
    assert.match(trace.reads.escalation_index, /severity/);
  });
}

test('the derive output does not add a fifth desk part', () => {
  // compose-gate.mjs requires exactly four documents under an edition's desk/,
  // counted by readdir. The producer's artifacts therefore live under
  // content/log/<date>/ and never beside them.
  assert.equal(EDITION_PART_FILES.length, 4);
  const editionsRoot = resolve(root, 'content', 'editions');
  for (const date of readdirSync(editionsRoot).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))) {
    const deskDir = resolve(editionsRoot, date, 'desk');
    let names;
    try { names = readdirSync(deskDir).filter((n) => n.endsWith('.json')); } catch { continue; }
    assert.deepEqual(names.sort(), [...EDITION_PART_FILES].sort(), `${date}/desk carries something other than the four parts`);
  }
});
