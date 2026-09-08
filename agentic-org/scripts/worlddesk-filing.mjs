import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, worldDeskCanonicalFindings } from '../../ops/worlddesk-contract.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const within = (base, ...parts) => {
  const value = path.resolve(base, ...parts);
  if (value !== base && !value.startsWith(`${base}${path.sep}`)) throw new Error('path escaped authority');
  return value;
};

export async function authenticateWorldDeskFiling(args, { env = process.env, cwd = process.cwd() } = {}) {
  const base = path.resolve(env.CLANK_PRIVATE_SOURCE_ROOT ?? path.join(cwd, 'repos/newsroom-private'));
  const dir = within(base, args.edition, 'worlddesk');
  const preparedPath = path.join(dir, 'ledger.worlddesk.json'), tracePath = path.join(dir, 'trace.json');
  const prepared = await readJson(preparedPath).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires mounted private prepared document at repos/newsroom-private/${args.edition}/worlddesk/ledger.worlddesk.json`); throw error; });
  const trace = await readJson(tracePath).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires mounted private trace at repos/newsroom-private/${args.edition}/worlddesk/trace.json`); throw error; });
  if (canonicalJson(prepared) !== canonicalJson(args.document)) throw new Error('ledger.worlddesk document does not match the mounted private prepared document; copy the producer payload verbatim');
  if (trace.edition !== args.edition) throw new Error(`ledger.worlddesk trace edition ${JSON.stringify(trace.edition)} does not match filing edition ${args.edition}`);
  const findings = worldDeskCanonicalFindings(args.document, trace);
  if (findings.length > 0) throw new Error(`ledger.worlddesk trace does not substantiate the filed figures — ${findings.join('; ')}`);
}
