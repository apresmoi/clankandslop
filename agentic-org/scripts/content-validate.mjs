#!/usr/bin/env node
// The newsroom's rules for a published-content tree, run by Spawnfile as the
// `validate` hook of the `public-content-volume` feed before a staged tree may
// become reachable (agentic-org/Spawnfile). Spawnfile itself proves the tree is
// exactly what git holds at the resolved commit; these are the two facts only
// the newsroom knows:
//
//   1. content/editions holds only dated directories, at least one of them;
//   2. content/bylines is exactly what build-bylines-tsv.mjs renders from those
//      editions -- the same invariant ci.yml diff-checks, re-proven here because a
//      byline index that disagrees with the editions sends a reporter's recall to
//      the wrong story.
//
// As a hook it reads the staged tree from SPAWNFILE_FEED_TREE and exits non-zero
// with the reason on stderr, which lands nothing.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { collectBylineRows, renderAgentTsv } from './build-bylines-tsv.mjs';
import { PublicContentError } from './public-content.mjs';

const EDITION = /^\d{4}-\d{2}-\d{2}$/u;
const fail = (message) => { throw new PublicContentError(message); };

/** Returns the number of published editions; throws PublicContentError naming the first broken rule. */
export function validateContentTree(root) {
  for (const dir of ['content/editions', 'content/bylines']) {
    let stat = null;
    try { stat = lstatSync(path.join(root, dir)); } catch { /* reported below */ }
    if (!stat?.isDirectory()) fail(`${dir}/ is missing from the content tree`);
  }
  const editions = readdirSync(path.join(root, 'content/editions'));
  const undated = editions.filter((name) => !EDITION.test(name));
  if (undated.length) fail(`content/editions holds ${undated.length} undated entr(y/ies): ${undated.slice(0, 3).join(', ')}`);
  if (!editions.length) fail('content/editions holds no published edition');
  let byAgent;
  try { ({ byAgent } = collectBylineRows(root)); } catch (error) { fail(`a published article cannot be read: ${error.message}`); }
  const files = readdirSync(path.join(root, 'content/bylines')).sort();
  const expected = [...byAgent.keys()].sort().map((agent) => `${agent}.tsv`);
  if (files.join('\n') !== expected.join('\n')) fail(`content/bylines carries [${files.join(', ')}], the editions render [${expected.join(', ')}]`);
  for (const agent of byAgent.keys())
    if (readFileSync(path.join(root, 'content/bylines', `${agent}.tsv`), 'utf8') !== renderAgentTsv(byAgent.get(agent))) fail(`content/bylines/${agent}.tsv is not what its editions render -- the byline index would send recall to the wrong story`);
  return editions.length;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const tree = process.env.SPAWNFILE_FEED_TREE;
  try {
    if (!tree || !path.isAbsolute(tree)) fail('SPAWNFILE_FEED_TREE must name the staged tree (this runs as a Spawnfile feed validate hook)');
    console.log(`published content OK: ${validateContentTree(tree)} edition(s)`);
  } catch (error) {
    console.error(`published content refused: ${error.message}`);
    process.exitCode = 1;
  }
}
