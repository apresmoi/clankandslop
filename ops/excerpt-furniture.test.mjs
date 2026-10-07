import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { excerptFurniture, excerptFurnitureFindings } from './excerpt-furniture.mjs';
import { articleFormatFindings } from './article-format.mjs';

const edition = new URL('../content/editions/2026-10-07/articles/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, edition), 'utf8'));
const rbi = read('s-ecc2ef3b.json');

test('the published RBI excerpt E6 is refused: an ad slug and an "Also read" prompt', () => {
  const e6 = rbi.evidence_box[5].source_note.raw_excerpt;
  assert.match(e6, /Story continues below this ad Also read \|/u);
  assert.deepEqual(excerptFurniture(e6).map((f) => f.kind), ['ad_slug', 'related_link']);
  const findings = excerptFurnitureFindings(rbi);
  assert.deepEqual(findings.map((f) => f.path), ['evidence_box[5].source_note.raw_excerpt', 'evidence_box[5].fragment']);
  assert.ok(findings.every((f) => f.code === 'excerpt_furniture' && f.message.includes('E6')));
});

test('every other excerpt of the 7 October edition is clean', () => {
  for (const name of readdirSync(edition)) {
    const article = read(name);
    const paths = excerptFurnitureFindings(article).map((f) => f.path);
    assert.deepEqual(paths, name === 's-ecc2ef3b.json' ? ['evidence_box[5].source_note.raw_excerpt', 'evidence_box[5].fragment'] : [], name);
  }
});

test('each marker on its own, and the prose that only looks like one', () => {
  for (const furniture of [
    'Rates rose. Advertisement The board met on Tuesday.',
    'Rates rose. ADVERTISEMENT',
    'The board met. Read more: Why the board met',
    'The board met. Related: Five charts on rates',
    'The board met. Click here to get alerts.',
    'Sign up for our free morning newsletter.',
    'The governor spoke at the podium (Image: Reuters/File) before leaving.',
    'Scroll to continue with content',
  ]) assert.ok(excerptFurniture(furniture).length > 0, furniture);
  for (const prose of [
    'The Advertising Standards Authority ruled the campaign misleading.',
    'Officials said they would read more of the filings before ruling.',
    'The story continues to develop as rescuers reach the ship.',
    'Analysts recommended a pause; the minister was not persuaded.',
    'Readers can subscribe to the central bank bulletin, the RBI said.',
    'The phishing email told recipients to click here to reset their passwords.',
    'The campaign asked supporters to sign up for its weekly newsletter before the vote.',
  ]) assert.deepEqual(excerptFurniture(prose), [], prose);
});

test('filing refuses the furniture; the archive profile does not re-judge published editions', () => {
  const filed = articleFormatFindings(rbi, { profile: "filing", topicSlugs: new Set() });
  assert.ok(filed.errors.some((e) => e.code === 'excerpt_furniture'));
  const archived = articleFormatFindings(rbi, { profile: "archive" });
  assert.ok(!archived.errors.some((e) => e.code === 'excerpt_furniture'));
});
