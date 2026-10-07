import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { articleFormatFindings, KEY_NUMBERS } from './article-format.mjs';

// key_numbers print on the Tape (KeyFigures.astro), so file_article holds them
// to what the Tape can set: 2–6 figures, a value of at most ten characters
// (the 84px mono column), a plain label of 2–48 characters.
const read = (file) => JSON.parse(readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8'));
const topicSlugs = Object.keys(read('topics.json').topics);
const published = read('editions/2026-09-11/articles/s-df5507bc.json');
const context = { owner: 'sprockett', topicSlugs };
const keyErrors = (key_numbers, profile = 'filing') => articleFormatFindings({ ...published, key_numbers }, { ...context, profile }).errors.filter((e) => e.code === 'key_numbers');
const figure = (value, label = 'Ten-day average', dir) => ({ label, value, ...(dir ? { dir } : {}) });
const two = [figure('7'), figure('11', 'Prior day transits')];

test('the limits are the ones the Tape renders cleanly', () => {
  assert.deepEqual({ ...KEY_NUMBERS }, { min: 2, max: 6, value: 10, labelMin: 2, labelMax: 48 });
  assert.deepEqual(keyErrors(published.key_numbers), [], 'a filed Hormuz forecast already fits');
});

test('two to six figures file; none, one or seven are refused with the reason', () => {
  assert.deepEqual(keyErrors(two), []);
  assert.deepEqual(keyErrors(Array.from({ length: 6 }, (_, i) => figure(String(i + 1)))), []);
  for (const count of [0, 1, 7]) {
    const errors = keyErrors(Array.from({ length: count }, (_, i) => figure(String(i + 1))));
    assert.equal(errors.length, 1, `${count} figures`);
    assert.equal(errors[0].path, 'article.key_numbers');
    assert.match(errors[0].message, new RegExp(`must carry 2 to 6 figures, got ${count} — they are printed on the Tape`, 'u'));
  }
});

test('a value of ten characters files and eleven is refused, counted in characters not bytes', () => {
  assert.deepEqual(keyErrors([figure('€930m'), figure('about 44%'), figure('1234567890'), figure('≤384')]), []);
  const errors = keyErrors([...two, figure('€930 million')]);
  assert.deepEqual(errors.map((e) => e.path), ['article.key_numbers[2].value']);
  assert.match(errors[0].message, /"€930 million" is 12 characters; the Tape prints at most 10 — a number with its unit/u);
  assert.equal(keyErrors([...two, figure('12345678901')]).length, 1);
  assert.equal(keyErrors([...two, figure('12\n34')]).length, 1, 'a value is one line');
});

test('a label is a plain phrase of two to forty-eight characters', () => {
  assert.deepEqual(keyErrors([...two, figure('3', 'x'.repeat(48))]), []);
  for (const label of ['x', 'x'.repeat(49), 'Ten-day average.', 'Transits;', 'Transits [E1]', '**Transits**', 'Ten-day\naverage']) {
    const errors = keyErrors([...two, figure('3', label)]);
    assert.ok(errors.length >= 1 && errors.every((e) => e.path === 'article.key_numbers[2].label'), JSON.stringify(label));
  }
});

test('the limits bind new filings only; the archive keeps what it published', () => {
  const legacy = [figure('v4-flash-vision-exp', 'Model'), figure('not shipped', 'Weights.')];
  assert.equal(keyErrors(legacy).length, 3);
  assert.deepEqual(keyErrors(legacy, 'archive'), []);
  assert.deepEqual(keyErrors([], 'archive'), []);
});
