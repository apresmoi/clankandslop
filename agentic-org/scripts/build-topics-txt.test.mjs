import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTopicsTxt, renderTopicsTxt } from './build-topics-txt.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const realJson = JSON.parse(readFileSync(join(repoRoot, 'content', 'topics.json'), 'utf8'));

const fixture = {
  topics: {
    zebra: { name: 'Zebra', blurb: 'z', aliases: [] },
    alpha: { name: 'Alpha', blurb: 'a', aliases: ['al'] },
    mid: { name: 'Mid Topic', blurb: 'm', aliases: [] }
  }
};

test('rendering is deterministic and sorted by slug', () => {
  const first = renderTopicsTxt(fixture);
  const second = renderTopicsTxt(fixture);
  assert.equal(first, second, 'rendering the same input twice must produce byte-identical output');

  const lines = first.trim().split('\n');
  const slugs = lines.map((line) => line.split('\t')[0]);
  assert.deepEqual(slugs, [...slugs].sort(), 'lines must be sorted by slug ascending');
  assert.deepEqual(slugs, ['alpha', 'mid', 'zebra']);
  assert.equal(first.endsWith('\n'), true, 'output must end with a trailing newline');
});

test('every canonical slug in content/topics.json appears exactly once', () => {
  const text = renderTopicsTxt(realJson);
  const lines = text.trim().split('\n');
  const canonicalSlugs = Object.keys(realJson.topics);

  assert.equal(lines.length, canonicalSlugs.length, 'one line per canonical topic, no more, no fewer');

  const seen = new Map();
  for (const line of lines) {
    const [slug, name] = line.split('\t');
    assert.equal(seen.has(slug), false, `slug ${slug} must appear exactly once`);
    seen.set(slug, name);
  }
  for (const slug of canonicalSlugs) {
    assert.equal(seen.get(slug), realJson.topics[slug].name, `${slug} must render its canonical name`);
  }
});

test('no topic name contains a tab, which would break the slug<TAB>name split', () => {
  const text = renderTopicsTxt(realJson);
  for (const line of text.trim().split('\n')) {
    const fields = line.split('\t');
    assert.equal(fields.length, 2, `line must split into exactly slug and name: ${JSON.stringify(line)}`);
  }
});

test('round-trip: parsing the generated file yields the same slug set as topics.json', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clank-build-topics-txt-'));
  try {
    mkdirSync(join(scratch, 'content'), { recursive: true });
    writeFileSync(join(scratch, 'content', 'topics.json'), JSON.stringify(realJson));

    buildTopicsTxt(scratch);
    const written = readFileSync(join(scratch, 'content', 'topics.txt'), 'utf8');
    const parsedSlugs = written.trim().split('\n').map((line) => line.split('\t')[0]).sort();
    const canonicalSlugs = Object.keys(realJson.topics).sort();

    assert.deepEqual(parsedSlugs, canonicalSlugs);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
