#!/usr/bin/env node
// No model involved: every check here is a scripted assertion against the
// real newsroom code and the real compiled workspace, runnable in CI.
//
// This exists because a 12-agent newsroom run burned 84% of 17.6M tokens on
// agents reverse-engineering tool contracts they had no way to satisfy from
// their wake. Check 1 is the direct regression test for that: it constructs
// a file_article call the way a reporter actually can — from its own agent
// identity and the brief text its wake carried, nothing else — and asserts
// it is accepted. It fails against the pre-fix contract and passes after.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileArticle, recordAssignment } from './production-newsroom.mjs';

const scriptsDir = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(scriptsDir, '..', '..');
const agentsDir = path.join(repoRoot, 'agentic-org', 'agents');
const compiledAgentsRoot = path.join(repoRoot, '.spawn-local', 'container', 'rootfs', 'var', 'lib', 'spawnfile', 'instances', 'daimon', 'daimon-organization', 'workspace', 'agents');

const findings = [];
let failed = false;
const record = (check, status, detail) => {
  findings.push({ check, status, detail });
  if (status === 'fail') failed = true;
  console.log(`[${status.toUpperCase().padEnd(8)}] ${check}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// 1. Contract derivability: file_article accepts a call built from only the
//    agent's own identity and its wake-carried brief — no assignment_event_key,
//    no assigned id.
// ---------------------------------------------------------------------------
async function checkContractDerivability() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-preflight-'));
  const savedAgent = process.env.CLANK_NEWSROOM_AGENT, savedRoot = process.env.CLANK_EDITION_STATE_ROOT;
  process.env.CLANK_EDITION_STATE_ROOT = path.join(temporary, 'state');
  const edition = '2026-08-25';
  const evidenceUrl = 'https://source.example/court-clock-tiktok';
  try {
    process.env.CLANK_NEWSROOM_AGENT = 'brass';
    await recordAssignment({
      edition, event_key: 'schedule:assignment-preflight',
      assignments: [
        { id: 'court-clock-tiktok', owner: 'tinkerton', brief: 'Report the mechanism for the court-clock TikTok story, and the fact that would show it wrong, at least two independent domains.', evidence_refs: [evidenceUrl] },
        { id: 'filler-1', owner: 'cogsworth', brief: 'Filler brief text for a second assignment slot today.', evidence_refs: [] },
        { id: 'filler-2', owner: 'sprockett', brief: 'Filler brief text for a third assignment slot today.', evidence_refs: [] },
        { id: 'filler-3', owner: 'foreman', brief: 'Filler brief text for a fourth assignment slot today.', evidence_refs: [] },
        { id: 'filler-4', owner: 'graves', brief: 'Filler brief text for a fifth assignment slot today.', evidence_refs: [] }
      ]
    });
    // Everything below is what a reporter's wake actually contains: its own
    // name and a natural-language brief. It has never seen assignment_event_key
    // or the id the editor chose — both are deliberately absent.
    process.env.CLANK_NEWSROOM_AGENT = 'tinkerton';
    const wakeDerivedArticle = {
      edition_date: edition, section: 'policy', kicker: 'Policy', headline: 'Court Clock Runs on TikTok Time',
      deck: 'A deck describing the court-clock TikTok mechanism and the reading that would undo it.', epistemic: 'fact',
      byline: { desk: 'Policy Desk', agents: ['Tinkerton'] }, timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30',
      topics: ['policy'], body: ['One.', 'Two.', 'Three.', 'Four.'], key_numbers: [],
      evidence_box: [{ source: 'Court filing', fragment: 'the clock', as_of: edition, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: 'Tinkerton', source_url: evidenceUrl, retrieved_at: `${edition}T10:00:00Z` } }],
      refs: ['E1']
    };
    const result = await fileArticle({ edition, event_key: 'wake:preflight-tinkerton-1', article: wakeDerivedArticle });
    if (result.article_id !== 'court-clock-tiktok') record('contract-derivability: file_article accepts a wake-derived call', 'fail', `resolved to unexpected article_id "${result.article_id}"`);
    else record('contract-derivability: file_article accepts a wake-derived call', 'pass', `resolved to "${result.article_id}" from (edition, owner) alone`);
  } catch (error) {
    record('contract-derivability: file_article accepts a wake-derived call', 'fail', `rejected: ${error.message}`);
  } finally {
    if (savedAgent === undefined) delete process.env.CLANK_NEWSROOM_AGENT; else process.env.CLANK_NEWSROOM_AGENT = savedAgent;
    if (savedRoot === undefined) delete process.env.CLANK_EDITION_STATE_ROOT; else process.env.CLANK_EDITION_STATE_ROOT = savedRoot;
    await rm(temporary, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Schema non-empty: every mcp_newsroom_* tool's inputSchema types every
//    property beyond edition/event_key, by actually talking JSON-RPC to the
//    real stdio server for each role.
// ---------------------------------------------------------------------------
function mcpToolsList(role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, 'production-newsroom-mcp.mjs')], { env: { ...process.env, CLANK_NEWSROOM_AGENT: role }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`mcp server for "${role}" timed out; stderr: ${err}`)); }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const lines = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const response = lines.find((line) => line.id === 2);
        resolve(response?.result?.tools ?? []);
      } catch (error) { reject(new Error(`could not parse mcp output for "${role}": ${error.message}; raw: ${out}`)); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    child.stdin.end();
  });
}
const isTyped = (schema) => typeof schema?.type === 'string' || Array.isArray(schema?.enum) || typeof schema?.properties === 'object';
async function checkSchemasNonEmpty() {
  const roles = ['klaxon', 'brass', 'cogsworth', 'spike', 'ledger', 'caslon', 'pressman'];
  for (const role of roles) {
    let tools;
    try { tools = await mcpToolsList(role); } catch (error) { record(`schema-non-empty: ${role}`, 'fail', error.message); continue; }
    if (tools.length === 0) { record(`schema-non-empty: ${role}`, 'fail', 'tools/list returned no tools'); continue; }
    for (const tool of tools) {
      const properties = tool.inputSchema?.properties ?? {};
      const propertyNames = Object.keys(properties);
      const extraNames = propertyNames.filter((name) => name !== 'edition' && name !== 'event_key');
      const requiredExtra = (tool.inputSchema?.required ?? []).filter((name) => name !== 'edition' && name !== 'event_key');
      if (requiredExtra.some((name) => !isTyped(properties[name]))) { record(`schema-non-empty: ${tool.name}`, 'fail', `a required property beyond edition/event_key is untyped ({}): ${JSON.stringify(requiredExtra.filter((name) => !isTyped(properties[name])))}`); continue; }
      if (extraNames.some((name) => !isTyped(properties[name]))) { record(`schema-non-empty: ${tool.name}`, 'fail', `a declared property is untyped ({}): ${JSON.stringify(extraNames.filter((name) => !isTyped(properties[name])))}`); continue; }
      record(`schema-non-empty: ${tool.name}`, 'pass', `${extraNames.length} typed propert${extraNames.length === 1 ? 'y' : 'ies'} beyond edition/event_key: ${extraNames.join(', ') || 'none required'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Every path mentioned in an agent's AGENTS.md resolves in its compiled
//    workspace, when that workspace exists.
// ---------------------------------------------------------------------------
async function checkAgentPathsResolve() {
  if (!existsSync(compiledAgentsRoot)) { record('agent-paths-resolve', 'skip', `no compiled workspace at ${compiledAgentsRoot} — run a local spawnfile compile first`); return; }
  const agentIds = (await readdir(agentsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  // A path candidate is a backtick span that looks like a real file reference
  // (a slash, or a known doc/code extension) — not a dotted identifier like
  // `caslon.chrome` (a desk name) or a prose fraction.
  const pathPattern = /`([\w./<>-]+)`/g;
  const extensionPattern = /\.(md|json|mjs|js|ts|yaml|yml)$/iu;
  const skip = new Set(['./repos/', '/', '.']);
  for (const agentId of agentIds) {
    const agentsMdPath = path.join(agentsDir, agentId, 'AGENTS.md');
    if (!existsSync(agentsMdPath)) continue;
    const text = await readFile(agentsMdPath, 'utf8');
    const candidates = new Set();
    for (const match of text.matchAll(pathPattern)) { const value = match[1]; if (!skip.has(value) && (value.includes('/') || extensionPattern.test(value))) candidates.add(value); }
    const workspaceDir = path.join(compiledAgentsRoot, agentId);
    if (!existsSync(workspaceDir)) { record(`agent-paths-resolve: ${agentId}`, 'skip', `no compiled workspace directory for ${agentId}`); continue; }
    // Content paths are relative to the mounted public-content bundle
    // (`repos/newsroom`, per the agent's own Spawnfile), not the bare
    // workspace root — only AGENTS.md/TEAM.md and the like are baked there
    // directly. `spawnfile compile` does not materialize resource mounts, so
    // when repos/newsroom is absent here we can only skip those candidates,
    // not fail them.
    const mountDir = path.join(workspaceDir, 'repos', 'newsroom');
    const mountAvailable = existsSync(mountDir);
    for (const candidate of candidates) {
      const templated = candidate.includes('<');
      const checkPath = templated ? candidate.slice(0, candidate.indexOf('<')).replace(/\/$/, '') : candidate;
      const label = `agent-paths-resolve: ${agentId} \`${candidate}\``;
      if (existsSync(path.join(workspaceDir, checkPath))) { record(label, 'pass', `resolved directly in workspace${templated ? ' (checked ancestor of templated path)' : ''}`); continue; }
      if (mountAvailable) {
        const resolves = existsSync(path.join(mountDir, checkPath));
        record(label, resolves ? 'pass' : 'fail', resolves ? `resolved under mounted repos/newsroom${templated ? ' (checked ancestor of templated path)' : ''}` : `does not resolve under ${workspaceDir} or ${mountDir}`);
      } else {
        record(label, 'skip', 'not baked into the static workspace and repos/newsroom is not mounted in this compiled snapshot — cannot verify without a running container');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Skill inventory: .codex/skills/* in the compiled workspace matches the
//    agent's declared skills; extras are reported, not failed.
// ---------------------------------------------------------------------------
async function checkSkillInventory() {
  if (!existsSync(compiledAgentsRoot)) { record('skill-inventory', 'skip', `no compiled workspace at ${compiledAgentsRoot}`); return; }
  const agentIds = (await readdir(agentsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const agentId of agentIds) {
    const spawnfilePath = path.join(agentsDir, agentId, 'Spawnfile');
    if (!existsSync(spawnfilePath)) continue;
    const spawnfileText = await readFile(spawnfilePath, 'utf8');
    const declared = new Set([...spawnfileText.matchAll(/skills\/([a-z0-9-]+)/g)].map((match) => match[1]));
    const skillsDir = path.join(compiledAgentsRoot, agentId, '.codex', 'skills');
    if (!existsSync(skillsDir)) { record(`skill-inventory: ${agentId}`, 'skip', `no .codex/skills directory for ${agentId}`); continue; }
    const actual = new Set((await readdir(skillsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const missing = [...declared].filter((name) => !actual.has(name));
    const extra = [...actual].filter((name) => !declared.has(name));
    if (missing.length > 0) record(`skill-inventory: ${agentId}`, 'fail', `declared skill(s) missing from compiled workspace: ${missing.join(', ')}`);
    else record(`skill-inventory: ${agentId}`, 'pass', `all ${declared.size} declared skill(s) present in .codex/skills`);
    if (extra.length > 0) record(`skill-inventory: ${agentId} extras`, 'advisory', `compiled workspace carries undeclared skill(s): ${extra.join(', ')} (not currently a failure)`);
  }
}

async function main() {
  console.log('=== Newsroom contract preflight (no model) ===\n');
  await checkContractDerivability();
  await checkSchemasNonEmpty();
  await checkAgentPathsResolve();
  await checkSkillInventory();
  const counts = { pass: 0, fail: 0, skip: 0, advisory: 0 };
  for (const finding of findings) counts[finding.status]++;
  console.log(`\nSummary: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.advisory} advisory`);
  if (failed) { console.log('PREFLIGHT FAILED'); process.exitCode = 1; } else { console.log('PREFLIGHT PASSED'); }
}
main().catch((error) => { console.error('preflight crashed:', error); process.exitCode = 1; });
