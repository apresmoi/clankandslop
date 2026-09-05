import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export const orgRoot = resolve(import.meta.dirname, '..');
export const policy = JSON.parse(readFileSync(resolve(orgRoot, 'policies/runtime.json'), 'utf8'));
export const agents = ['klaxon', 'cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta', 'brass', 'spike', 'ledger', 'caslon', 'pressman'];
export const sensors = new Set(['klaxon']);
export const reporters = new Set(['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta']);
export const digest = /^sha256:[a-f0-9]{64}$/;
export const privateKinds = new Set(policy.privateDirectories);
export const declaredMoltnetSecretRefs = Object.freeze([...readFileSync(resolve(orgRoot, 'Spawnfile'), 'utf8').matchAll(/\b(?:secret|token_secret):\s*([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));

// Secret names an agent declares under `environment.secrets` as required. The
// value never appears here or anywhere in the tree: Spawnfile resolves the name
// at deploy through `--env-file`, and admission below refuses to start without
// it, exactly as it does for the Moltnet tokens.
export const declaredRequiredAgentSecretRefs = Object.freeze(agents.flatMap((agent) => {
  const bytes = readFileSync(resolve(orgRoot, 'agents', agent, 'Spawnfile'), 'utf8');
  const lines = bytes.split('\n');
  const start = lines.findIndex((line) => /^\s{2}secrets:\s*$/.test(line));
  if (start < 0) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s+#/.test(line)) continue;
    if (!/^\s+- /.test(line)) break;
    const match = /name:\s*([A-Z][A-Z0-9_]*),\s*required:\s*true/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}));

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function beneath(root, target) { const rel = relative(resolve(root), resolve(target)); return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`${sep}..${sep}`); }
export function safeDirectory(path) { return existsSync(path) && statSync(path).isDirectory(); }
export function releaseFor(edition, offset = '+02:00') { return `${edition}T16:00:00${offset}[Europe/Berlin]`; }
