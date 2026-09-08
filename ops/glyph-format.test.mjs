import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { glyphFormatFindings, glyphSelectionFindings } from './glyph-format.mjs';

test('glyph scale accepts supported bounds and rejects invisible or overflowing values', () => {
  for (const scale of [0.001, 0.6, 0.82, 0.86, 0.9, 1]) assert.deepEqual(glyphSelectionFindings({ shape: 'chip', scale }), []);
  assert.deepEqual(glyphSelectionFindings({ shape: 'chip' }), []);
  for (const scale of [0, -1, 1.01, Number.NaN, Infinity, '0.6', null])
    assert.ok(glyphSelectionFindings({ shape: 'chip', scale }).some(f => f.includes('scale')), String(scale));
});

test('every archived page glyph selection remains valid', () => {
  const editions = new URL('../content/editions/', import.meta.url);
  let count = 0;
  for (const date of readdirSync(editions).filter(d => /^\d{4}-\d{2}-\d{2}$/u.test(d))) {
    const pages = new URL(`${date}/pages/`, editions);
    for (const file of readdirSync(pages).filter(f => f.endsWith('.json'))) {
      const page = JSON.parse(readFileSync(new URL(file, pages)));
      const walk = blocks => { for (const b of blocks) {
        if (b.block === 'GlyphArt') { count++; assert.deepEqual(glyphSelectionFindings(b.props), [], `${date}/${file}`); }
        if (b.block === 'Grid') for (const column of b.props.columns) walk(column);
      } };
      walk(page.head); walk(page.flow);
    }
  }
  assert.ok(count > 0, 'the archive supplied real page glyph selections');
});

test('archive glyphs preserve right-trimmed rows and separate dark art', () => {
  for (const name of ['songbook-sosa', 'songbook-miloj', 'songbook-candombe']) {
    const value = JSON.parse(readFileSync(new URL(`../content/editions/2026-07-12/glyphs/${name}.json`, import.meta.url)));
    assert.deepEqual(glyphFormatFindings(value, name), []);
  }
});

test('empty, oversized and malformed glyphs fail before rendering', () => {
  const glyph = {name: 'microchip', cols: 2, rows: 2, art: '##\n #'};
  assert.deepEqual(glyphFormatFindings(glyph), []);
  for (const change of [{art:'  \n  '}, {cols:401}, {rows:1}, {art:'###\n #'}, {art:'\t#\n #'}, {artDark:'   '}]) assert.ok(glyphFormatFindings({...glyph, ...change}).length);
  assert.ok(glyphFormatFindings(glyph, 'other').length);
});

test('a generated glyph has one unambiguous selector; eclipse must select its scene', () => {
  assert.deepEqual(glyphSelectionFindings({glyph:'microchip'}), []);
  for (const props of [{glyph:'../secret'}, {glyph:{}}, {glyph:'microchip', shape:'chip'}, {glyph:'microchip', roll:'chip'}, {shape:'eclipse'}, {roll:'eclipse'}]) assert.ok(glyphSelectionFindings(props).length);
  assert.deepEqual(glyphSelectionFindings({shape:'eclipse', roll:'eclipse'}), []);
});
