// The MCP servers Spawnfile compiles for one agent, so the newsroom checks can
// keep asserting on resolved values while the Spawnfiles declare the newsroom
// server once under the root's `shared.environment.mcp_servers`.
//
// Mirrors Spawnfile (>= 9ad3c82, SPEC §2.3 "Per-agent placeholders" and the
// team inheritance rules):
//   - an agent entry WITH `transport` is a complete server and replaces the
//     inherited one of the same name;
//   - an agent entry WITHOUT `transport` narrows the inherited server: `tools`
//     replaces the allowlist, `env` merges key by key (agent keys win), every
//     other field is inherited; with nothing to narrow it is an error;
//   - `${workspace}`, `${agent.id}`, `${agent.name}` in command/args/env
//     resolve per agent; any other `${workspace…}`/`${agent.…}` is an error;
//   - an agent naming one server twice is an error.
// The compiler stays the authority: `spawnfile validate`/`compile` refuse the
// same shapes. This exists only so the role checks see what Daimon will see.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseManifest } from './check-instruction-budget.mjs';
import { orgRoot } from './lib.mjs';

export const agentWorkspace = (agent) => `/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/${agent}`;

const RESERVED = /\$\{(workspace|agent\.[^}]*)\}/gu;

const resolveValue = (agent, server, value) => value.replace(RESERVED, (match, name) => {
  if (name === 'workspace') return agentWorkspace(agent);
  if (name === 'agent.id') return `agent:${agent}`;
  if (name === 'agent.name') return agent;
  throw new Error(`${agent} MCP server ${server.name}: unknown placeholder ${match}`);
});

const resolvePlaceholders = (agent, server) => ({
  ...server,
  ...(server.command === undefined ? {} : { command: resolveValue(agent, server, server.command) }),
  ...(server.args === undefined ? {} : { args: server.args.map((arg) => resolveValue(agent, server, arg)) }),
  ...(server.env === undefined ? {} : { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveValue(agent, server, value)])) })
});

export function effectiveMcpServers(agent, manifest, rootManifest) {
  const inherited = new Map((rootManifest?.shared?.environment?.mcp_servers ?? []).map((server) => [server.name, server]));
  const resolved = new Map(inherited), local = new Set();
  for (const entry of manifest.environment?.mcp_servers ?? []) {
    if (local.has(entry.name)) throw new Error(`${agent} declares MCP server ${entry.name} more than once`);
    local.add(entry.name);
    if (entry.transport !== undefined) { resolved.set(entry.name, entry); continue; }
    const base = inherited.get(entry.name);
    if (!base) throw new Error(`${agent} overrides MCP server ${entry.name}, but the root declares no shared server of that name`);
    resolved.set(entry.name, { ...base, ...(entry.tools === undefined ? {} : { tools: entry.tools }), ...(entry.env === undefined ? {} : { env: { ...base.env, ...entry.env } }) });
  }
  return [...resolved.values()].map((server) => resolvePlaceholders(agent, server));
}

export const readRootManifest = (root = orgRoot) => parseManifest(readFileSync(resolve(root, 'Spawnfile'), 'utf8'));

/** The agent manifest with `environment.mcp_servers` replaced by what compiles. */
export function effectiveAgentManifest(agent, bytes, rootManifest = readRootManifest()) {
  const manifest = parseManifest(bytes);
  return { ...manifest, environment: { ...manifest.environment, mcp_servers: effectiveMcpServers(agent, manifest, rootManifest) } };
}
