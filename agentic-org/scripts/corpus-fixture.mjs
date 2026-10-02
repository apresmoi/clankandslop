// Builds a research-corpus volume the way the host-side refresh lays a real one
// out: CORPUS.json at the mount root, the dated tree under trees/<commit>/, and
// <edition> as a symlink into that tree — so tests read the corpus over exactly
// the paths the agents read, symlink traversal included. Test fixture only;
// nothing in a container imports this.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE, CORPUS_IDENTITY_VERSION, REPORTERS } from './corpus-contract.mjs';

const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const CAPTURES = [['chatgpt', 'world.md'], ['grok', 'markets.md']];
const STORIES = ['s-0000000a', 's-0000000b'];

export const corpusIdentityFile = (root) => path.join(root, CORPUS_IDENTITY_FILE);
export const corpusDeskIndex = (root, edition, agent) => path.join(root, edition, 'desks', `${agent}.index`);
export const corpusPreparedFile = (root, edition) => path.join(root, edition, 'desks', '_corpus.prepared.json');

export function installCorpusFixture(root, edition, { commit = 'a'.repeat(40), identity = {} } = {}) {
  rmSync(root, { recursive: true, force: true });
  const tree = `trees/${commit}`;
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
  for (const agent of REPORTERS) writeFileSync(corpusDeskIndex(path.join(root, tree), edition, agent), rows);
  writeFileSync(path.join(base, 'desks', '_all.index'), rows);
  writeFileSync(path.join(base, 'desks', '_corpus.prepared.json'), `${JSON.stringify({ version: 'clank.research-corpus.prepared.v1', edition, sources }, null, 2)}\n`);

  symlinkSync(path.join(tree, edition), path.join(root, edition));
  const record = { version: CORPUS_IDENTITY_VERSION, commit, ref: `edition/${edition}`, edition, fetched_at: `${edition}T04:58:03Z`, tree, editions_present: [edition], source_count: sources.length, ...identity };
  writeFileSync(corpusIdentityFile(root), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
