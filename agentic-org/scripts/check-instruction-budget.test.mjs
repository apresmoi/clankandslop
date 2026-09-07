import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DAIMON_APPEND_POINTER_ALLOWANCE,
  DAIMON_MAX_INSTRUCTION_BYTES,
  INSTRUCTION_BUDGET_BYTES,
  ManifestParseError,
  agentInstructions,
  instructionBudgetFindings,
  listAgents,
  parseManifest
} from './check-instruction-budget.mjs';

const orgRoot = path.resolve(import.meta.dirname, '..');
const manifest = (relative) => readFileSync(path.join(orgRoot, relative), 'utf8');

test('every declared agent Spawnfile, and the organization Spawnfile, parses', () => {
  const agents = listAgents();
  assert.equal(agents.length, 12);
  for (const agent of agents) {
    const parsed = parseManifest(manifest(`agents/${agent}/Spawnfile`));
    assert.equal(parsed.kind, 'agent', `agents/${agent}/Spawnfile is not kind: agent`);
    assert.equal(parsed.name, agent, `agents/${agent}/Spawnfile names ${parsed.name}`);
    assert.equal(parsed.runtime.name, 'daimon');
    assert.ok(parsed.workspace.docs.system, `agents/${agent}/Spawnfile declares no workspace.docs.system`);
  }
  const org = parseManifest(manifest('Spawnfile'));
  assert.equal(org.kind, 'team');
});

// The defect this file exists for: `slot: "forecast"` written unescaped inside
// brass's double-quoted schedule prompt closed the scalar 1,800 characters
// early. `spawnfile compile` rejected the whole organization with a YAML
// structure error; nothing in the repository noticed.
test('an unescaped quote inside a double-quoted scalar is rejected', () => {
  const broken = 'schedule:\n  kind: cron\n  prompt: "mark it slot: "forecast" and move on."\n';
  assert.throws(() => parseManifest(broken), ManifestParseError);
  const escaped = 'schedule:\n  kind: cron\n  prompt: "mark it slot: \\"forecast\\" and move on."\n';
  assert.equal(parseManifest(escaped).schedule.prompt, 'mark it slot: "forecast" and move on.');
});

test('brass still carries the escaped forecast slot in its conference prompt', () => {
  const brass = parseManifest(manifest('agents/brass/Spawnfile'));
  assert.match(brass.schedule.prompt, /mark exactly that assignment slot: "forecast"/u);
});

test('the reader is fail-closed on constructs it does not implement', () => {
  for (const source of [
    'a: |\n  block scalar\n',
    'a: &anchor value\n',
    "a: 'single quoted'\n",
    'a: "never closed\n',
    'a:\n\tb: tabbed\n',
    'a: 1\n  b: 2\n',
    'a: 1\na: 2\n'
  ]) assert.throws(() => parseManifest(source), ManifestParseError, `accepted: ${JSON.stringify(source)}`);
});

test('block sequences, compact items and flow collections read as YAML does', () => {
  const parsed = parseManifest([
    'resources:',
    '  - { id: one, mode: readonly }',
    '  - id: two',
    '    tools: [a, b]',
    '    env: { K: v, N: 900 }',
    'flags: { on: true, off: false, none: null }'
  ].join('\n'));
  assert.deepEqual(parsed, {
    resources: [{ id: 'one', mode: 'readonly' }, { id: 'two', tools: ['a', 'b'], env: { K: 'v', N: 900 } }],
    flags: { on: true, off: false, none: null }
  });
});

// The formula is Spawnfile's, in src/runtime/daimon/config.ts: every entry of
// workspace.docs rendered as `# <role>\n\n<content>`, joined and trimmed.
test('instructions are built from every declared workspace doc', () => {
  const { docs, instructions } = agentInstructions('caslon');
  assert.deepEqual(docs, { system: 'AGENTS.md' });
  const brief = readFileSync(path.join(orgRoot, 'agents/caslon/AGENTS.md'), 'utf8');
  assert.equal(instructions, `# system\n\n${brief}`.trim());
});

test('every agent compiles inside the Daimon instruction budget', () => {
  const { findings, rows } = instructionBudgetFindings();
  assert.deepEqual(findings, []);
  assert.equal(rows.length, 12);
  assert.equal(INSTRUCTION_BUDGET_BYTES, DAIMON_MAX_INSTRUCTION_BYTES - DAIMON_APPEND_POINTER_ALLOWANCE);
  for (const row of rows) assert.ok(row.bytes <= INSTRUCTION_BUDGET_BYTES, `${row.agent}: ${row.bytes} bytes`);
});

// Mutation check: the budget has to be able to go red, and it has to count
// EVERY declared doc rather than AGENTS.md alone — a second workspace doc is
// how the ceiling gets crossed next.
test('the budget reports an agent that outgrows it, counting every declared doc', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-instruction-budget-'));
  try {
    const agent = path.join(root, 'agents', 'padded');
    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(agent, 'Spawnfile'), [
      'spawnfile_version: "0.1"',
      'kind: agent',
      'name: padded',
      'runtime:',
      '  name: daimon',
      'workspace:',
      '  docs: { system: AGENTS.md, pages: PAGES.md }',
      ''
    ].join('\n'));
    writeFileSync(path.join(agent, 'AGENTS.md'), 'brief\n');
    writeFileSync(path.join(agent, 'PAGES.md'), `${'x'.repeat(INSTRUCTION_BUDGET_BYTES)}\n`);
    const { findings, rows } = instructionBudgetFindings(root);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].docs, ['AGENTS.md', 'PAGES.md']);
    assert.match(findings[0], /^padded compiles to \d+ instruction bytes, \d+ over the 16133-byte budget/u);
    assert.ok(findings.some((finding) => /instruction codepoints/u.test(finding)), 'codepoint ceiling not reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The lifted floor is a mounted workspace document, the same shape as
// agents/caslon/PAGES.md: it is never compiled into anyone's instructions, and
// every brief that used to carry it inline now names the path it can `cat`.
test('the shared floor is a mounted document every brief that used it points at', () => {
  const floor = readFileSync(path.join(orgRoot, 'FLOOR.md'), 'utf8');
  assert.match(floor, /^# The floor\n/u);
  const pointing = listAgents().filter((agent) => {
    const brief = readFileSync(path.join(orgRoot, `agents/${agent}/AGENTS.md`), 'utf8');
    return brief.includes('repos/newsroom/agentic-org/FLOOR.md');
  });
  assert.deepEqual(pointing, ['brass', 'caslon', 'cogsworth', 'foreman', 'graves', 'klaxon', 'ledger', 'pressman', 'spike', 'sprockett', 'tinkerton', 'vesta']);
  for (const agent of pointing) {
    const { instructions } = agentInstructions(agent);
    assert.ok(!instructions.includes('## The roster'), `${agent} still carries the floor inline`);
  }
});
