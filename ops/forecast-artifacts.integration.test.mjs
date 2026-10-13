import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateRenderedEvidence } from './validate-rendered-evidence.mjs';
import { ledgerHistory, missingLedgerRows } from './open-clocks.mjs';
import { archiveLedger } from './ledger-archive.mjs';
import { deskDocumentFindings } from './desk-contract.mjs';

const repo = resolve(import.meta.dirname, '..');
const firstDate = '2026-10-14', date = '2026-10-16';
const first = 'Yes if a named outlet reports at least 300,000 tonnes loaded by 16:00 UTC on 16 October 2026; no if no such report is posted.';
const negated = first.replace('if a named', 'if no named').replace('no if no such', 'no if such');
const vote = 'Yes if the council wins 64 or more seats by 12 October 2026; no if it wins 63 or fewer.';
const negative = 'The council does not pass the budget by 30 November 2026.';
const negativeFirst = 'The council does not approve the levy by 30 November 2026.';
const clean = 'Published: October 11, 2026 The senators issued a joint statement opposing the imports.';
const navigation = `Senator Website Skip to content About Contact Order A Flag Home Logo Link ${clean}`;
const write = (root, path, document) => writeFileSync(resolve(root, path), JSON.stringify(document));
const read = (root, path) => readFileSync(resolve(root, path), 'utf8');
const text = html => html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
const evidence = excerpt => [{ source: 'Council', fragment: excerpt, as_of: date, source_note: { source_kind: 'public_url', source_id: 'E1', used_by_agent: 'Foreman', retrieved_at: '2026-10-13T12:00:00Z', source_url: 'https://example.org/statement', raw_excerpt: excerpt } }];
const article = (day, id, label, p, excerpt) => ({ id, edition_date: day, section: 'world', kicker: 'Test', headline: 'A published call', deck: 'A synthetic regression article.', epistemic: 'forecast', byline: { desk: 'Macro Desk', agents: ['Foreman'] }, timestamp: '12:00 UTC', revision: 1, confidence: { label, value: p }, body: ['The council issued a statement [E1].', 'The dated condition is still awaiting verification [E1].'], refs: ['E1'], evidence_box: evidence(excerpt) });

function fixture(root, excerpt) {
  for (const name of ['ops', 'website', 'content', 'agentic-org']) cpSync(resolve(repo, name), resolve(root, name), { recursive: true, filter: file => !file.split('/').some(part => ['node_modules', 'dist', '.astro', '.git', '.runtime'].includes(part)) });
  symlinkSync(resolve(repo, 'website/node_modules'), resolve(root, 'website/node_modules'));
  const config = resolve(root, 'website/astro.config.mjs');
  writeFileSync(config, readFileSync(config, 'utf8').replace('defineConfig({', "defineConfig({ cacheDir: './.astro/cache', vite: { cacheDir: './.astro/vite' },"));
  rmSync(resolve(root, 'content/editions'), { recursive: true });
  for (const day of [firstDate, date]) {
    const base = `content/editions/${day}`;
    for (const folder of ['desk', 'articles', 'pages']) mkdirSync(resolve(root, base, folder), { recursive: true });
    write(root, `${base}/desk/caslon.chrome.json`, { date: day, edition_no: '1000', volume: 'I', issued_at: `${day}T12:00:00Z`, revision: 1, tagline: 'Fixture', next_bell: '18:00 UTC', compiled_by: ['Foreman'], lead_story_id: day === firstDate ? 'first' : 'update' });
    write(root, `${base}/desk/caslon.weather.json`, { weather: null });
    write(root, `${base}/desk/ledger.worlddesk.json`, { world_desk: { escalation_index: 0.1, delta: 'steady', open_conflicts: 1, watch: 1 } });
    write(root, `${base}/desk/ledger.settlements.json`, { resolved_last_edition: day === firstDate ? [] : [{ call: vote, outcome: 'miss', prior_p: 0.28, event_outcome: false, note: 'The official table awarded 59 seats, below the threshold of 64.' }] });
    const blocks = [{ block: 'ForecastLedger', props: { meta: '999 stale open calls', open_calls: [] } }, { block: 'TrackRecord', props: { resolved: 'edition' } }];
    write(root, `${base}/pages/front.json`, { edition: day, page: 'front', title: 'Test front', active: '/', head: [], flow: [] });
    write(root, `${base}/pages/tape.json`, { edition: day, page: 'tape', title: 'Test tape', active: '/tape', head: blocks, flow: [] });
  }
  write(root, `content/editions/${firstDate}/articles/first.json`, article(firstDate, 'first', first, 0.42, clean));
  write(root, `content/editions/${firstDate}/articles/vote.json`, article(firstDate, 'vote', vote, 0.28, clean));
  write(root, `content/editions/${date}/articles/update.json`, article(date, 'update', negated, 0.67, excerpt));
  const budget = article(firstDate, 'budget', negative, 0.67, clean);
  Object.assign(budget.confidence, { event_id: 'budget', negated: true });
  write(root, `content/editions/${firstDate}/articles/budget.json`, budget);
  const explicit = article(date, 'explicit', negativeFirst, 0.67, clean);
  explicit.confidence.negated = true;
  explicit.dissent = { agent: 'Tinkerton', p: 0.2, argument: 'The council is unlikely to leave the levy unapproved.' };
  write(root, `content/editions/${date}/articles/explicit.json`, explicit);
}

test('built publication scores NO correctly, renders the complementary update, shares counts and refuses final contamination', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'forecast-artifacts-'));
  try {
    const privateRoot = process.env.CLANK_PRIVATE_SOURCE_ROOT;
    const stripFurniture = privateRoot ? (await import(pathToFileURL(resolve(privateRoot, 'sensors/automation/excerpt-furniture.mjs')))).stripFurniture : () => clean;
    const cleaned = stripFurniture(navigation);
    assert.equal(cleaned, clean);
    fixture(root, cleaned);
    const carry = async (day, document) => {
      if (privateRoot) {
        const { carryOpenCalls } = await import(pathToFileURL(resolve(privateRoot, 'sensors/automation/desk-prep.mjs')));
        const prep = { document, review: {} };
        await carryOpenCalls(prep, root, day);
        assert.equal(prep.review.carry_unavailable, undefined);
        return prep.document;
      }
      const history = ledgerHistory(archiveLedger(resolve(root, 'content'), { before: day }));
      return { ...document, resolved_last_edition: [...document.resolved_last_edition, ...missingLedgerRows(history, day, document)] };
    };
    const ledgerPath = `content/editions/${date}/desk/ledger.settlements.json`;
    const carried = await carry(date, JSON.parse(read(root, ledgerPath)));
    const budgetRow = carried.resolved_last_edition.find(row => row.event_id === 'budget');
    assert.ok(budgetRow);
    assert.equal(budgetRow.negated, false);
    assert.equal(budgetRow.prior_p, 0.33);
    assert.deepEqual(deskDocumentFindings('ledger.settlements', carried, { profile: 'filing' }), []);
    write(root, ledgerPath, carried);
    const output = execFileSync('npm', ['run', 'build'], { cwd: resolve(root, 'website'), encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    assert.match(output, /OK — rendered evidence/);
    for (const path of ['tape/index.html', `editions/${date}/tape/index.html`]) {
      const html = read(root, `website/dist/${path}`), plain = text(html);
      assert.match(plain, /3 open calls/);
      assert.match(plain, /42% → 33%/);
      const levy = (html.match(/<div class="ledger-row\b[^]*?(?=<div class="ledger-row\b|<p class="ledger-foot")/gu) ?? []).find(row => row.includes('The council approves the levy'));
      assert.ok(levy, 'First negative publication renders an affirmative question');
      assert.match(levy, /class="ledger-p"[^]*?0\.33/);
      assert.match(levy, /class="ledger-dis"[^]*?Tinkerton[^]*?80%/);
      assert.doesNotMatch(plain, /The council does not approve|The council does not pass/);
      assert.equal((html.match(/class="ledger-row /gu) ?? []).length, 3);
      assert.match(plain, /Record to date · 1 hit · 0 miss/);
      assert.match(html, /tr-state hit/);
      assert.match(plain, /0\.28/);
      assert.doesNotMatch(plain, /999 stale/);
    }
    const method = text(read(root, 'website/dist/method/index.html'));
    assert.match(method, /1 settled calls: 1 hits and 0 misses/);
    assert.match(method, /Another 3 are open: 3 not yet due and 0 due/);
    assert.match(method, /0\.078 Brier score, the paper/);
    const original = text(read(root, `website/dist/editions/${firstDate}/tape/index.html`));
    assert.doesNotMatch(original, /42% → 33%/);
    assert.match(original, /0\.42/);
    const settledDate = '2026-10-17';
    const settledBase = `content/editions/${settledDate}`;
    for (const folder of ['desk', 'articles', 'pages']) mkdirSync(resolve(root, settledBase, folder), { recursive: true });
    for (const name of ['caslon.weather', 'ledger.worlddesk']) cpSync(resolve(root, `content/editions/${date}/desk/${name}.json`), resolve(root, `${settledBase}/desk/${name}.json`));
    const chrome = JSON.parse(read(root, `content/editions/${date}/desk/caslon.chrome.json`));
    write(root, `${settledBase}/desk/caslon.chrome.json`, { ...chrome, date: settledDate, issued_at: `${settledDate}T12:00:00Z`, lead_story_id: 'closing' });
    write(root, `${settledBase}/articles/closing.json`, { ...article(settledDate, 'closing', '', 0.5, clean), confidence: undefined, epistemic: 'fact' });
    const closing = await carry(settledDate, { resolved_last_edition: [{ call: negated, prior_p: 0.67, outcome: 'miss', event_outcome: true, note: 'The deadline passed without a qualifying named loading report.' }] });
    const closingBudget = closing.resolved_last_edition.find(row => row.event_id === 'budget');
    assert.ok(closingBudget);
    Object.assign(closingBudget, { outcome: 'hit', event_outcome: false });
    assert.deepEqual(deskDocumentFindings('ledger.settlements', closing, { profile: 'filing' }), []);
    write(root, `${settledBase}/desk/ledger.settlements.json`, closing);
    for (const page of ['front', 'tape']) {
      const layout = JSON.parse(read(root, `content/editions/${date}/pages/${page}.json`));
      write(root, `${settledBase}/pages/${page}.json`, { ...layout, edition: settledDate });
    }
    execFileSync('npm', ['run', 'build'], { cwd: resolve(root, 'website'), encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    const settledMethod = text(read(root, 'website/dist/method/index.html'));
    assert.match(settledMethod, /3 settled calls: 3 hits and 0 misses/);
    // (.28² + .42² + .33²)/3 = .12123: use each first-publication probability.
    assert.match(settledMethod, /0\.121 Brier score, the paper/);
    assert.match(settledMethod, /Another 1 are open:/);
    for (const path of ['tape/index.html', `editions/${settledDate}/tape/index.html`]) {
      const html = read(root, `website/dist/${path}`), settledTape = text(html);
      assert.match(settledTape, /1 open call/);
      assert.match(settledTape, /Settled · hit Yes if a named outlet/);
      assert.match(settledTape, /Settled · hit Yes if The council passes the budget/);
      assert.match(settledTape, /Record to date · 3 hit · 0 miss/);
      assert.match(settledTape, /0\.42/);
      assert.equal((html.match(/class="ledger-row /gu) ?? []).length, 1);
      assert.doesNotMatch(html.match(/<div class="ledger-row\b[^]*?(?=<p class="ledger-foot")/u)?.[0] ?? '', /passes the budget/);
    }
    const recordPath = `website/dist/editions/${date}/articles/update/index.html`;
    const record = read(root, recordPath);
    assert.match(record, /The senators issued a joint statement/);
    assert.doesNotMatch(record, /Skip to content|Order A Flag/);
    assert.match(validateRenderedEvidence(root, date), /2 articles/);
    // Mutation is after rendering: a clean source cannot route around this gate.
    for (const navigation of ['Skip&#32;to <b>content</b>', 'Skip  to content', 'Order A\nFlag', 'Skip&#9;to content', 'Order A<br>Flag']) {
      writeFileSync(resolve(root, recordPath), record.replace(cleaned, navigation + ' ' + cleaned));
      assert.throws(() => validateRenderedEvidence(root, date), /navigation: (?:Skip to content|Order A Flag)/);
    }
    writeFileSync(resolve(root, recordPath), record.replace('class="excerpt"', 'class="removed-excerpt"'));
    assert.throws(() => validateRenderedEvidence(root, date), /raw_excerpt count/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
