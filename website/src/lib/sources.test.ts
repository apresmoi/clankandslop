import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentRoot } from './edition.ts';
import { creditedSpeakers, outletKey, sourceCounts, sourceLine, type RecordRow } from './sources.ts';

const row = (url: string, excerpt: string, extra: Partial<NonNullable<RecordRow['source_note']>> = {}, source = ''): RecordRow =>
  ({ source, fragment: excerpt, source_note: { source_url: url, source_kind: 'public_url', raw_excerpt: excerpt, ...extra } });

test('the 7 October RBI story: twelve references, four outlets, three independent', () => {
  const article = JSON.parse(readFileSync(resolve(contentRoot, 'editions/2026-10-07/articles/s-ecc2ef3b.json'), 'utf-8'));
  const counts = sourceCounts(article.evidence_box);
  // The Indian Express quotes "RBI Governor Sanjay Malhotra said": it relays the RBI.
  assert.deepEqual(counts, { references: 12, outlets: 4, independent: 3 });
  assert.equal(sourceLine(counts), '12 references · 4 outlets · 3 independent');
});

test('one registrable domain is one outlet; a social network is one outlet per account', () => {
  assert.equal(outletKey(row('https://www.bbc.co.uk/news/x', '')), 'bbc');
  assert.equal(outletKey(row('https://bbc.com/news/y', '')), 'bbc');
  assert.equal(outletKey(row('https://rbi.org.in/Scripts/a.aspx', '')), 'rbi');
  assert.equal(outletKey(row('https://edition.cnn.com/a', '')), 'cnn');
  assert.equal(outletKey(row('https://x.com/SecWar/status/1', '')), 'x.com/secwar');
  assert.equal(outletKey(row('https://x.com/Bulgaria_PM/status/2', '')), 'x.com/bulgaria_pm');
  assert.equal(outletKey(row('https://twitter.com/Reuters/status/1', '')), 'x.com/reuters');
  assert.equal(outletKey({ source: 'Ledger', source_note: { source_kind: 'computed' } }), null);
});

test('an excerpt that credits another cited outlet folds into it', () => {
  const rows = [
    row('https://rbi.org.in/a', 'The MPC voted unanimously to increase the policy repo rate by 25 bps to 5.50 per cent.', {}, 'Reserve Bank of India'),
    row('https://indianexpress.com/b', 'Announcing the policy, RBI Governor Sanjay Malhotra said activity held its momentum.'),
    row('https://livemint.com/c', 'Economists polled by Mint expected a pause until August.'),
  ];
  assert.deepEqual(sourceCounts(rows), { references: 3, outlets: 3, independent: 2 });
});

test('outlets that credit the same named speaker count once', () => {
  const rows = [
    row('https://www.bta.bg/en/a', 'Bulgaria is conducting a rescue operation, Prime Minister Rumen Radev said here on Tuesday.'),
    row('https://apnews.com/article/b', 'Bulgarian Prime Minister Rumen Radev said two commercial vessels were struck by drones.'),
  ];
  assert.deepEqual(creditedSpeakers(rows[1].source_note!.raw_excerpt!), ['Bulgarian Prime Minister Rumen Radev']);
  assert.deepEqual(sourceCounts(rows), { references: 2, outlets: 2, independent: 1 });
});

test('a publisher match does not skip the speaker: three outlets, one statement', () => {
  const rows = [
    row('https://rbi.org.in/a', 'The MPC voted unanimously to increase the policy repo rate.', {}, 'Reserve Bank of India'),
    row('https://indianexpress.com/b', 'RBI Governor Sanjay Malhotra said activity held its momentum.'),
    row('https://livemint.com/c', 'Sanjay Malhotra said the stance had changed.'),
  ];
  assert.equal(sourceCounts(rows).independent, 1);
});

test('two outlets citing the same uncited agency count once', () => {
  const rows = [
    row('https://a.example/1', 'Two tankers were struck overnight, according to a Reuters report.'),
    row('https://b.example/2', 'Citing a Reuters report, the paper said a third ship turned back.'),
  ];
  assert.equal(sourceCounts(rows).independent, 1);
});

test('a ten-word run of identical text folds two outlets: a reprinted wire story', () => {
  const wire = 'the ministry confirmed that both tankers had been cleared to leave the anchorage at dawn';
  assert.equal(sourceCounts([row('https://a.example/1', `Officials spoke late. ${wire}.`), row('https://b.example/2', `${wire}, a port agent added.`)]).independent, 1);
  assert.equal(sourceCounts([row('https://a.example/1', 'the ministry confirmed that both tankers left'), row('https://b.example/2', 'the ministry confirmed that both ships stayed')]).independent, 2);
});

test('attributed reporting and rows without a captured excerpt are outlets, never independent', () => {
  const rows = [
    row('https://apnews.com/a', 'Thirteen people were killed and more than 30 injured.'),
    // An attributed row that kept an excerpt anyway: the checker never saw that text.
    { source: 'Reuters', source_note: { source_url: 'https://www.reuters.com/x', source_kind: 'public_url', evidence: 'attributed_unchecked', raw_excerpt: 'Reuters reported the ship was hit twice before it sank.' } },
    { source: 'NBC', source_note: { source_url: 'https://www.nbcnews.com/y', source_kind: 'public_url', provenance_note: 'Quoted by the research capture but NOT confirmed against the source page.' } },
    { source: 'Ledger', source_note: { source_kind: 'computed' } },
  ];
  assert.deepEqual(sourceCounts(rows), { references: 4, outlets: 3, independent: 1 });
});

test('the line reads in the singular when it has to', () => {
  assert.equal(sourceLine({ references: 1, outlets: 1, independent: 1 }), '1 reference · 1 outlet · 1 independent');
});
