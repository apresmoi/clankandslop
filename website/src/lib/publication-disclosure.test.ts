import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPublicationDisclosure } from './publication-disclosure.ts';
const date = '2026-10-27', note = 'Sources reverified; original host landing record unavailable.';

test('front-page disclosure reads the published host note and refuses contradictory records', () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-note-')), dir = join(root, 'editions', date); mkdirSync(dir, { recursive: true });
  assert.equal(loadPublicationDisclosure(date, root), undefined);
  const file = join(dir, 'corpus-provenance.json');
  const good = { version: 'clank.edition-corpus-provenance.v1', edition: date, verification: 'reverified-content', corpus: null, original_fetch_identity: null, original_landing_timestamp: null, disclosure: note };
  writeFileSync(file, JSON.stringify(good)); assert.equal(loadPublicationDisclosure(date, root), note);
  for (const change of [{ edition: '2026-10-28' }, { corpus: {} }, { original_landing_timestamp: '2026-10-27T00:00:00Z' }, { disclosure: '' }]) {
    writeFileSync(file, JSON.stringify({ ...good, ...change })); assert.throws(() => loadPublicationDisclosure(date, root), /Invalid reverified-content/);
  }
  writeFileSync(file, JSON.stringify({ version: good.version, edition: date, corpus: {} })); assert.equal(loadPublicationDisclosure(date, root), undefined);
});
