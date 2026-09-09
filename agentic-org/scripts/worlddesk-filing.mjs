import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, worldDeskCanonicalFindings } from '../../ops/worlddesk-contract.mjs';

const date = /^\d{4}-\d{2}-\d{2}$/u;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const maybeJson = async file => readJson(file).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
const within = (base, ...parts) => {
  const value = path.resolve(base, ...parts);
  if (value !== base && !value.startsWith(`${base}${path.sep}`)) throw new Error('path escaped authority');
  return value;
};
const tracePath = trace => {
  const match = /^content\/log\/(\d{4}-\d{2}-\d{2})\/worlddesk\.json$/u.exec(trace ?? '');
  if (!match) throw new Error('ledger.worlddesk prior derived document has an invalid trace path');
  return match[1];
};
const validTrace = (document, trace) => {
  const findings = worldDeskCanonicalFindings(document, trace);
  if (findings.length > 0) throw new Error(`ledger.worlddesk trace does not substantiate the filed figures — ${findings.join('; ')}`);
};

async function latestPriorDerived(publicRoot, edition) {
  const editionsRoot = within(publicRoot, 'content/editions');
  const entries = await readdir(editionsRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries.filter(item => item.isDirectory()).map(item => item.name).filter(name => date.test(name) && name < edition).sort().reverse()) {
    const document = await maybeJson(within(editionsRoot, entry, 'desk/ledger.worlddesk.json'));
    if (document === undefined) continue;
    if (document?.world_desk?.derived !== true) throw new Error(`ledger.worlddesk latest prior published World Desk document (${entry}) is not a derived filing`);
    const traceEdition = tracePath(document.world_desk.from);
    if (traceEdition > entry) throw new Error('ledger.worlddesk prior derived document points at a future trace');
    const trace = await maybeJson(within(publicRoot, 'content/log', traceEdition, 'worlddesk.json'));
    if (trace === undefined) throw new Error(`ledger.worlddesk prior derived document (${entry}) is missing its public trace`);
    const canonical = structuredClone(document);
    canonical.world_desk.delta = trace.delta?.word;
    validTrace(canonical, trace);
    return { edition: entry, document };
  }
  throw new Error(`ledger.worlddesk fallback requires a prior public derived World Desk trace before ${edition}`);
}

async function authenticateFallback({ args, privateRoot, publicRoot }) {
  const dir = within(privateRoot, args.edition, 'worlddesk');
  const refusal = await maybeJson(path.join(dir, 'refusal.json'));
  if (refusal === undefined) throw new Error(`ledger.worlddesk requires mounted private prepared document at repos/newsroom-private/${args.edition}/worlddesk/ledger.worlddesk.json`);
  if (refusal.version !== 'clank.worlddesk-trace.v1' || refusal.edition !== args.edition || refusal.refused !== true) throw new Error('ledger.worlddesk current refusal is malformed');
  const currentTrace = await readJson(path.join(dir, 'trace.json')).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires mounted private trace at repos/newsroom-private/${args.edition}/worlddesk/trace.json`); throw error; });
  if (currentTrace.version !== 'clank.worlddesk-trace.v1' || currentTrace.edition !== args.edition || currentTrace.escalation?.index !== null || !Array.isArray(currentTrace.escalation?.unresolved) || currentTrace.escalation.unresolved.length === 0) throw new Error('ledger.worlddesk current refusal trace is malformed');
  if (canonicalJson(refusal.unresolved) !== canonicalJson(currentTrace.escalation.unresolved)) throw new Error('ledger.worlddesk current refusal does not match its trace');
  const prior = await latestPriorDerived(publicRoot, args.edition);
  const expected = structuredClone(prior.document);
  expected.world_desk.delta = 'stale';
  if (canonicalJson(expected) !== canonicalJson(args.document)) throw new Error(`ledger.worlddesk fallback must carry the latest prior derived public World Desk document (${prior.edition}) with only delta changed to stale`);
}

export async function authenticateWorldDeskFiling(args, { env = process.env, cwd = process.cwd() } = {}) {
  if (!date.test(args.edition)) throw new Error(`ledger.worlddesk edition ${JSON.stringify(args.edition)} must be YYYY-MM-DD`);
  const privateRoot = path.resolve(env.CLANK_PRIVATE_SOURCE_ROOT ?? path.join(cwd, 'repos/newsroom-private'));
  const publicRoot = path.resolve(env.CLANK_PUBLIC_SOURCE_ROOT ?? path.join(cwd, 'repos/newsroom'));
  const dir = within(privateRoot, args.edition, 'worlddesk');
  const preparedPath = path.join(dir, 'ledger.worlddesk.json'), traceFile = path.join(dir, 'trace.json');
  const prepared = await maybeJson(preparedPath);
  if (prepared === undefined) return authenticateFallback({ args, privateRoot, publicRoot });
  const trace = await readJson(traceFile).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires mounted private trace at repos/newsroom-private/${args.edition}/worlddesk/trace.json`); throw error; });
  if (canonicalJson(prepared) !== canonicalJson(args.document)) throw new Error('ledger.worlddesk document does not match the mounted private prepared document; copy the producer payload verbatim');
  if (trace.edition !== args.edition) throw new Error(`ledger.worlddesk trace edition ${JSON.stringify(trace.edition)} does not match filing edition ${args.edition}`);
  validTrace(args.document, trace);
}
