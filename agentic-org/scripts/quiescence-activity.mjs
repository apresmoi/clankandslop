export const ACTIVITY_PROBE_SOURCE = `
import { readFileSync } from 'node:fs';
try {
  const token = (process.env.SPAWNFILE_DAIMON_CONTROL_TOKEN || readFileSync('/run/clank-newsroom-control/token', 'utf8')).trim();
  if (!token) throw new Error('missing token');
  const response = await fetch('http://127.0.0.1:19700/v2/activity', {
    headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000), redirect: 'error'
  });
  let body;
  if (response.status === 200) {
    const text = await response.text();
    if (Buffer.byteLength(text) > 4000000) throw new Error('activity response exceeds bound');
    body = JSON.parse(text);
  }
  process.stdout.write(JSON.stringify({ status: response.status, body }));
} catch { process.stderr.write('Daimon activity probe failed\\n'); process.exitCode = 1; }
`;

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const ACTIVITY_PROBE = `node --input-type=module -e ${quote(ACTIVITY_PROBE_SOURCE)}`;
const text = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

export function executionAuthority(raw) {
  let response;
  try { response = JSON.parse(raw); } catch { fail('activity probe returned invalid JSON'); }
  if (response?.status === 404) return { authority: 'legacy-receipts', executions: [] };
  if (response?.status !== 200) fail(`activity endpoint returned HTTP ${response?.status ?? 'unknown'}`);
  const activity = response.body;
  if (!object(activity) || activity.version !== 'noopolis.daimon.organization-runtime-activity.v2' || !Array.isArray(activity.items)) fail('invalid v2 activity envelope');
  for (const [index, item] of activity.items.entries()) {
    if (!object(item) || !text(item.agent_id) || !text(item.delivery_id) || !text(item.state)) fail(`invalid activity item ${index}`);
    if (item.active !== undefined && typeof item.active !== 'boolean') fail(`invalid activity item ${index} active flag`);
  }
  if (!Object.hasOwn(activity, 'executions')) return { authority: 'legacy-receipts', executions: [] };
  if (!Array.isArray(activity.executions)) fail('activity executions must be an array');
  for (const [index, execution] of activity.executions.entries()) {
    if (!object(execution) || !text(execution.agent_id) || !text(execution.execution_id)) fail(`activity execution ${index} missing identity`);
    if (execution.state !== 'running') fail(`activity execution ${index} invalid state`);
    if (!Array.isArray(execution.delivery_ids) || !execution.delivery_ids.length || !execution.delivery_ids.every(text)) fail(`activity execution ${index} invalid deliveries`);
  }
  return { authority: 'executions', executions: activity.executions };
}

// Match the complete program emitted by Spawnfile's Docker healthcheck, never arbitrary node processes.
export const HEALTHCHECK_PROGRAM = "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fetch(`http://127.0.0.1:${c.host.port}/healthz`).then(async r=>{if(!r.ok||JSON.stringify(await r.json())!==JSON.stringify({status:'ok'}))process.exit(1)}).catch(()=>process.exit(1))";
export function isRuntimeHealthcheck(args) {
  for (const node of ['node', '/usr/local/bin/node']) {
    const prefix = `${node} -e ${HEALTHCHECK_PROGRAM} `;
    if (args.startsWith(prefix) && /^\/var\/lib\/spawnfile\/instances\/daimon\/[\w.-]+\/daimon\/[\w.-]+\.json$/u.test(args.slice(prefix.length))) return true;
  }
  return false;
}
