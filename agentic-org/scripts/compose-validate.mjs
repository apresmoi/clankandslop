// The release validator, run on the candidate edition before compose_edition
// records anything.
//
// On 2026-10-21 Caslon composed a paper whose caslon.chrome `compiled_by` named
// "Caslon" and "Ledger". compose accepted it; Pressman's build then ran
// ops/validate-content.mjs, which accepts only the bylined reporters under
// content/agents, and the edition did not ship. A composition the release
// would reject is not a composition, so compose now asks the same validator,
// not a copy of its rules.
//
// The candidate is laid out the way the release candidate is: the composed
// edition's documents under content/editions/<date>/, beside the image's
// personas, topics and fixtures and the published editions, which are earlier
// coverage only. Only the candidate edition is judged.
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateContent } from '../../ops/validate-content.mjs';

const KINDS = ['articles', 'desk', 'pages', 'maps', 'glyphs'];

/** Returns the validator's error lines for the candidate edition; `read(kind, name)` returns the document compose would record. */
export async function candidateValidationErrors({ edition, tree, read, publicRoot, editionsRoot }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-compose-validate-'));
  try {
    const content = path.join(temporary, 'content'), editions = path.join(content, 'editions');
    await mkdir(editions, { recursive: true });
    for (const name of ['agents', 'topics.json', 'fixtures']) await symlink(path.join(publicRoot, 'content', name), path.join(content, name));
    for (const date of await readdir(editionsRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
      if (date !== edition && /^\d{4}-\d{2}-\d{2}$/u.test(date)) await symlink(path.join(editionsRoot, date), path.join(editions, date));
    for (const kind of KINDS) {
      if (!(tree[kind] ?? []).length) continue;
      await mkdir(path.join(editions, edition, kind), { recursive: true });
      for (const name of tree[kind]) await writeFile(path.join(editions, edition, kind, `${name}.json`), `${JSON.stringify(await read(kind, name), null, 2)}\n`);
    }
    return validateContent(temporary, { only: edition }).errors;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function assertCandidateValidates(input) {
  const errors = await candidateValidationErrors(input);
  if (errors.length) throw new Error(`composition refused — ops/validate-content.mjs, the check Pressman's build runs, rejects this edition, so nothing was composed and Pressman was not asked. Validator errors: ${errors.map(line => `✗ ${line}`).join('; ')}. Correct the documents you own (file_desk caslon.chrome / caslon.weather, lay_pages) and compose again; a defect in a reporter's piece goes to its owner and Spike`);
}
