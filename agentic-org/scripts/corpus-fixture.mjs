// Builds a research-corpus volume the way `spawnfile volume refresh` lays a
// real one out: `.spawnfile-feed.json` at the mount root, the tree under
// trees/<revision>/, and `current` as the relative link to it -- so tests read
// the corpus over exactly the paths the agents read, symlink traversal
// included. Test fixture only; nothing in a container imports this.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_FEED_VERSION, CORPUS_IDENTITY_FILE, CORPUS_RESOURCE, REPORTERS, corpusIdentityFromFeed, corpusRoot } from './corpus-contract.mjs';

const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const CAPTURES = [['chatgpt', 'world.md'], ['grok', 'markets.md']];
const STORIES = ['s-0000000a', 's-0000000b'];

export const corpusIdentityFile = (root) => path.join(root, CORPUS_IDENTITY_FILE);
export const corpusDeskIndex = (root, edition, agent) => path.join(corpusRoot(root), edition, 'desks', `${agent}.index`);
export const corpusPreparedFile = (root, edition) => path.join(corpusRoot(root), edition, 'desks', '_corpus.prepared.json');
/** The revision a fixture lands, derived from its commit so two commits never share a tree. */
export const fixtureRevision = (commit) => createHash('sha256').update(`corpus:${commit}`).digest('hex');

// `feed` overrides fields of Spawnfile's identity record; `source` overrides its
// git provenance. Returns the identity a newsroom record binds.
export function installCorpusFixture(root, edition, { commit = 'a'.repeat(40), feed = {}, source = {} } = {}) {
  rmSync(root, { recursive: true, force: true });
  const tree = `trees/${fixtureRevision(commit)}`;
  const base = path.join(root, tree, edition);
  for (const directory of ['desks', 'stories', 'chatgpt', 'grok']) mkdirSync(path.join(base, directory), { recursive: true });

  const sources = [];
  for (const [site, name] of CAPTURES) {
    const text = `# ${site} capture for ${edition}\n\nraw research, commit ${commit}\n`;
    writeFileSync(path.join(base, site, name), text);
    sources.push({ path: `${site}/${name}`, sha256: digestText(text) });
  }
  for (const [index, story] of STORIES.entries()) writeFileSync(path.join(base, 'stories', `${story}.md`), `# story ${index} for ${edition}\n\nbody\n`);
  const rows = `${STORIES.map((story, index) => `${story}\tA researched story number ${index}`).join('\n')}\n`;
  for (const agent of REPORTERS) writeFileSync(path.join(base, 'desks', `${agent}.index`), rows);
  writeFileSync(path.join(base, 'desks', '_all.index'), rows);
  writeFileSync(path.join(base, 'desks', '_corpus.prepared.json'), `${JSON.stringify({ version: 'clank.research-corpus.prepared.v1', edition, sources }, null, 2)}\n`);

  symlinkSync(tree, corpusRoot(root));
  const record = {
    version: CORPUS_FEED_VERSION, resource: CORPUS_RESOURCE, volume: 'clank-newsroom-corpus', revision: fixtureRevision(commit), tree,
    files: 12, landed_at: `${edition}T07:58:03Z`, source: { kind: 'git', commit, ref: `origin/edition/${edition}`, paths: null, ...source }, ...feed
  };
  writeFileSync(corpusIdentityFile(root), `${JSON.stringify(record, null, 2)}\n`);
  return corpusIdentityFromFeed(record, root);
}
