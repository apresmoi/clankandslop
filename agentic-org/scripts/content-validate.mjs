// What a staged public content tree must prove before it may become reachable.
//
// It is published `main`, which CI already gated -- so these are not editorial
// checks, they are "did the host extract what git says, completely, in a shape
// every reader understands":
//
//   1. every path git holds under content/editions and content/bylines at the
//      commit is present, and nothing else is (an archive that stopped early, or
//      a tar that exited 0 having written nothing, is a refusal -- not a smaller
//      back catalogue);
//   2. content/editions holds only dated directories, at least one of them;
//   3. content/bylines is exactly what build-bylines-tsv.mjs renders from those
//      editions -- the same invariant ci.yml diff-checks, re-proven here because a
//      byline index that disagrees with the editions sends a reporter's recall to
//      the wrong story.
//
// Returns the number of published editions.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { collectBylineRows, renderAgentTsv } from './build-bylines-tsv.mjs';
import { PUBLIC_CONTENT_PATHS, PublicContentError } from './public-content.mjs';

const EDITION = /^\d{4}-\d{2}-\d{2}$/u;
const fail = (message) => { throw new PublicContentError(message); };

const walk = (root, prefix, out = []) => {
  for (const name of readdirSync(path.join(root, prefix)).sort()) {
    const key = `${prefix}/${name}`, stat = lstatSync(path.join(root, key));
    if (stat.isDirectory()) walk(root, key, out);
    else if (stat.isFile()) out.push(key);
    else fail(`${key} is neither a file nor a directory -- git never holds that in published content`);
  }
  return out;
};

export function validateContentTree(root, { repo, commit, exec }) {
  for (const dir of ['content/editions', 'content/bylines']) {
    let stat = null;
    try { stat = lstatSync(path.join(root, dir)); } catch { /* reported below */ }
    if (!stat?.isDirectory()) fail(`${dir}/ is missing from the extracted tree for ${commit.slice(0, 7)}`);
  }
  const want = exec('git', ['-C', repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', commit, '--', ...PUBLIC_CONTENT_PATHS]).toString().split('\0').filter(Boolean).sort();
  const got = [...walk(root, 'content/editions'), ...walk(root, 'content/bylines')].sort();
  const wantSet = new Set(want), gotSet = new Set(got);
  const missing = want.filter((name) => !gotSet.has(name)), extra = got.filter((name) => !wantSet.has(name));
  if (missing.length || extra.length) fail(`the extracted content for ${commit.slice(0, 7)} is not what git holds: ${missing.length} missing (${missing.slice(0, 3).join(', ')}), ${extra.length} extra (${extra.slice(0, 3).join(', ')})`);
  const editions = readdirSync(path.join(root, 'content/editions'));
  const undated = editions.filter((name) => !EDITION.test(name));
  if (undated.length) fail(`content/editions holds ${undated.length} undated entr(y/ies): ${undated.slice(0, 3).join(', ')}`);
  if (!editions.length) fail(`content/editions at ${commit.slice(0, 7)} holds no published edition`);
  let byAgent;
  try { ({ byAgent } = collectBylineRows(root)); } catch (error) { fail(`a published article at ${commit.slice(0, 7)} cannot be read: ${error.message}`); }
  const files = readdirSync(path.join(root, 'content/bylines')).sort();
  const expected = [...byAgent.keys()].sort().map((agent) => `${agent}.tsv`);
  if (files.join('\n') !== expected.join('\n')) fail(`content/bylines carries [${files.join(', ')}], the editions render [${expected.join(', ')}]`);
  for (const agent of byAgent.keys())
    if (readFileSync(path.join(root, 'content/bylines', `${agent}.tsv`), 'utf8') !== renderAgentTsv(byAgent.get(agent))) fail(`content/bylines/${agent}.tsv is not what its editions render -- the byline index would send recall to the wrong story`);
  return editions.length;
}
