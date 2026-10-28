import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentRoot } from './edition.ts';

export function loadPublicationDisclosure(date: string, root = contentRoot): string | undefined {
  const file = resolve(root, 'editions', date, 'corpus-provenance.json');
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (record.verification !== 'reverified-content') return undefined;
  if (record.version !== 'clank.edition-corpus-provenance.v1' || record.edition !== date || record.corpus !== null || record.original_fetch_identity !== null || record.original_landing_timestamp !== null || typeof record.disclosure !== 'string' || !record.disclosure.trim()) {
    throw new Error(`Invalid reverified-content disclosure for ${date}`);
  }
  return record.disclosure;
}
