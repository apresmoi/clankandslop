import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Reporters used to read content/topics.json directly to resolve an
// article's topics[] against the canonical glossary -- 503 lines / ~17KB of
// name/blurb/alias prose, sometimes dumped whole into a context window just
// to check which slugs exist. This script renders the same slug set as a
// flat slug<TAB>name list: ~72 lines, no blurbs, no aliases, cheap to read
// or grep. Aliases are deliberately omitted -- they route to a canonical
// slug that is already listed here, so every alias resolves to a line this
// file already contains, and carrying them would only reintroduce the
// non-canonical noise this file exists to cut.

export function renderTopicsTxt(json) {
  const slugs = Object.keys(json.topics).sort();
  return slugs.map((slug) => `${slug}\t${json.topics[slug].name}`).join('\n') + '\n';
}

export function buildTopicsTxt(repoRoot) {
  const json = JSON.parse(readFileSync(resolve(repoRoot, 'content/topics.json'), 'utf8'));
  const text = renderTopicsTxt(json);
  writeFileSync(resolve(repoRoot, 'content/topics.txt'), text);
  return text;
}

function main() {
  const repoRoot = process.argv[2] ?? process.env.CLANK_NEWSROOM_REPO ?? resolve(import.meta.dirname, '..', '..');
  const text = buildTopicsTxt(repoRoot);
  console.log(`content/topics.txt: ${text.split('\n').length - 1} lines`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
