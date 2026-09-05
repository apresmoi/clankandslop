import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { agents, assert, beneath, declaredMoltnetSecretRefs, orgRoot, policy, safeDirectory } from './lib.mjs';

export function checkRuntime(env = process.env) {
  const missing = [];
  const privateRoot = env.CLANK_PRIVATE_ROOT;
  const repositoryRoot = resolve(orgRoot, '..');
  if (!privateRoot || !privateRoot.startsWith('/') || resolve(privateRoot) === repositoryRoot || beneath(repositoryRoot, privateRoot)) missing.push('private-root');
  if (privateRoot && !safeDirectory(privateRoot)) missing.push('private-root-directory');
  const isolated = new Set();
  for (const agent of agents) {
    const key = agent.toUpperCase().replaceAll('-', '_');
    for (const capability of ['HOME', 'XDG', 'WORKSPACE', 'CLI_LOGIN']) {
      const value = env[`CLANK_${key}_${capability}`];
      if (!value || (capability !== 'CLI_LOGIN' && !safeDirectory(value))) missing.push(`${agent}:${capability.toLowerCase()}`);
      if (capability !== 'CLI_LOGIN' && value) { const key = resolve(value); if (isolated.has(key)) missing.push(`${agent}:${capability.toLowerCase()}-not-isolated`); isolated.add(key); }
    }
  }
  for (const capability of ['BROKER', 'MOLTNET', 'NETWORK_POLICY', 'GIT_POLICY']) if (env[`CLANK_${capability}_READY`] !== 'yes') missing.push(capability.toLowerCase().replace('_', '-'));
  for (const secretRef of declaredMoltnetSecretRefs) if (!env[secretRef]) missing.push(`moltnet-secret:${secretRef}`);
  return { ok: missing.length === 0, missing: [...new Set(missing)], capabilities: policy.requiredCapabilities };
}

export function requireRuntime(env = process.env) { const result = checkRuntime(env); assert(result.ok, `runtime admission denied: ${result.missing.join(', ')}`); return result; }
if (process.argv[1] === new URL(import.meta.url).pathname) { const result = checkRuntime(); console.log(result.ok ? 'runtime admission: ready' : `runtime admission: denied (${result.missing.join(', ')})`); process.exitCode = result.ok ? 0 : 1; }
