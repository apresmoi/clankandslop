import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireRuntime } from './check-runtime.mjs';
import { assert, policy, beneath } from './lib.mjs';

export function provision({ edition, privateRoot, apply = false, env = process.env }) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(edition ?? ''), 'edition must be YYYY-MM-DD');
  requireRuntime({ ...env, CLANK_PRIVATE_ROOT: privateRoot ?? env.CLANK_PRIVATE_ROOT });
  const day = resolve(privateRoot, edition);
  assert(beneath(privateRoot, day), 'day path escapes private root');
  const paths = policy.privateDirectories.map((name) => resolve(day, name));
  if (apply) for (const path of paths) { if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  return { dryRun: !apply, paths };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const edition = process.argv[2]; const apply = process.argv.includes('--apply');
  try { console.log(JSON.stringify(provision({ edition, privateRoot: process.env.CLANK_PRIVATE_ROOT, apply }), null, 2)); } catch (error) { console.error(`provision denied: ${error.message}`); process.exitCode = 1; }
}
