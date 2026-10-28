import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reverifiedCorpusProvenance } from '../agentic-org/scripts/reverified-corpus.mjs';
import { proofFor, DISCLOSURE } from '../agentic-org/scripts/reverified-corpus.fixture.mjs';
const repo = path.resolve(import.meta.dirname, '..');
const write = (root, file, value) => writeFileSync(path.join(root, file), JSON.stringify(value));

test('the approved host disclosure renders visibly on the current and archived October 27 fronts only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-disclosure-'));
  try {
    for (const name of ['website', 'content', 'ops']) cpSync(path.join(repo, name), path.join(root, name), { recursive: true, filter: file => !file.split('/').some(part => ['node_modules', 'dist', '.astro', '.git', '.runtime'].includes(part)) });
    symlinkSync(path.join(repo, 'website/node_modules'), path.join(root, 'website/node_modules'));
    const config = path.join(root, 'website/astro.config.mjs');
    writeFileSync(config, readFileSync(config, 'utf8').replace('defineConfig({', "defineConfig({ cacheDir: './.astro/cache', vite: { cacheDir: './.astro/vite' },"));
    rmSync(path.join(root, 'content/editions'), { recursive: true });
    for (const day of ['2026-10-26', '2026-10-27']) {
      const base = `content/editions/${day}`;
      for (const folder of ['desk', 'pages', 'articles']) mkdirSync(path.join(root, base, folder), { recursive: true });
      write(root, `${base}/desk/caslon.chrome.json`, { date: day, edition_no: '1000', volume: 'I', issued_at: `${day}T12:00:00Z`, revision: 1, tagline: 'Fixture', next_bell: '18:00 UTC', compiled_by: ['Foreman'], lead_story_id: 'fixture' });
      write(root, `${base}/desk/caslon.weather.json`, { weather: null });
      write(root, `${base}/desk/ledger.worlddesk.json`, { world_desk: { escalation_index: 0.1, delta: 'steady', open_conflicts: 1, watch: 1 } });
      write(root, `${base}/desk/ledger.settlements.json`, { resolved_last_edition: [] });
      for (const page of ['front', 'tape']) write(root, `${base}/pages/${page}.json`, { edition: day, page, title: 'Fixture', active: page === 'front' ? '/' : '/tape', head: [], flow: [] });
      write(root, `${base}/articles/fixture.json`, { id: 'fixture', edition_date: day, section: 'world', kicker: 'Fixture', headline: 'A fixture record', deck: 'A publication disclosure fixture.', epistemic: 'fact', byline: { desk: 'Macro Desk', agents: ['Foreman'] }, timestamp: '12:00 UTC', revision: 1, body: ['A dated fixture statement.'], refs: [], evidence_box: [] });
    }
    const staged = { edition: '2026-10-27', receipt: { composition_digest: `sha256:${'a'.repeat(64)}`, artifact_digest: `sha256:${'b'.repeat(64)}` } };
    const proof = proofFor(staged), file = path.join(root, 'proof.json'); writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
    const provenance = { version: 'clank.edition-corpus-provenance.v1', ...reverifiedCorpusProvenance(file, staged, proof.audit.latest_stage.claim) };
    write(root, 'content/editions/2026-10-27/corpus-provenance.json', provenance);
    const output = execFileSync('npm', ['run', 'build'], { cwd: path.join(root, 'website'), encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.match(output, /OK — rendered evidence/);
    for (const file of ['index.html', 'editions/2026-10-27/index.html']) {
      const html = readFileSync(path.join(root, 'website/dist', file), 'utf8');
      const notice = html.match(/<p\b[^>]*class="publication-disclosure"[^>]*>([^<]+)<\/p>/u);
      assert.equal(notice?.[1], DISCLOSURE, `visible disclosure missing on ${file}`);
      assert.doesNotMatch(notice[0], /hidden|display:\s*none/);
      assert.equal((html.match(/Sources reverified;/gu) ?? []).length, 1);
    }
    assert.doesNotMatch(readFileSync(path.join(root, 'website/dist/editions/2026-10-26/index.html'), 'utf8'), /Sources reverified;/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
