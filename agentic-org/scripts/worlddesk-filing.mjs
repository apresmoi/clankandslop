import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE, corpusIdentityFindings, corpusLinkFindings, verifyCorpusFreshness } from './corpus-contract.mjs';
import { canonicalJson, worldDeskCanonicalFindings } from '../../ops/worlddesk-contract.mjs';
import { CONTENT_VOLUME_ENV, publicEditionsRoot } from './public-content.mjs';

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

// THE MOUNT IS A DECLARATION, NOT A DEFAULT
// -----------------------------------------
// Everything this module reads on the private side comes off the research-corpus
// volume the host populates from outside the container. An undeclared mount used
// to resolve to a cwd-relative repos/newsroom-private, so the only thing between
// a World Desk filing and a read off a path nobody mounted was the env line in
// ledger's Spawnfile — a declaration that reads as enforcement and enforces
// nothing, which is the defect family this newsroom has lost editions to. There
// is no fallback path in this file any more: an absent or relative
// CLANK_PRIVATE_SOURCE_ROOT is a refusal that names the variable.
const CORPUS_TAIL = 'Nothing was filed. The host populates this mount from outside the container, so there is nothing here to retry or work around: say so in room:release and end the turn';
const corpusMount = env => {
  const declared = env.CLANK_PRIVATE_SOURCE_ROOT;
  if (typeof declared !== 'string' || !declared.startsWith('/')) throw new Error(`ledger.worlddesk cannot read the research corpus because the mount is not declared for this agent — CLANK_PRIVATE_SOURCE_ROOT must be the absolute path the day's research corpus is mounted at, got ${JSON.stringify(declared ?? null)}. ${CORPUS_TAIL}`);
  return path.resolve(declared);
};

// THE SAME CORPUS CHECK record_assignment MAKES, OVER THE SAME PREDICATES
// ----------------------------------------------------------------------
// The World Desk document on this mount is derived from the day's corpus, so a
// corpus that is missing, empty, unreadable, another edition's, or whose dated
// link is not bound to the commit its own record names makes the filing exactly
// as unpublishable as a lineup commissioned against one. corpusIdentityFindings
// and corpusLinkFindings are imported rather than restated so this read can
// never drift weaker than Brass's read of the same volume — a second copy of the
// rules is how the two sides came apart the first time. Every check fails
// closed, including on an unexpected throw out of a predicate.
async function assertCorpus(base, edition) {
  let entries;
  try { entries = await readdir(base); } catch (error) { throw new Error(`ledger.worlddesk cannot read the research corpus mount — ${base} cannot be read (${error.code ?? error.message}), so the host has not populated it. ${CORPUS_TAIL}`); }
  if (entries.length === 0) throw new Error(`ledger.worlddesk cannot read the research corpus mount — ${base} holds no entries, so the host has not populated it. ${CORPUS_TAIL}`);
  const file = within(base, CORPUS_IDENTITY_FILE);
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw new Error(`ledger.worlddesk cannot trust the research corpus: it carries no readable identity record — ${file} is missing or unparseable (${error.code ?? error.message}). ${CORPUS_TAIL}`); }
  let findings;
  try { findings = corpusIdentityFindings(value, { edition }); } catch (error) { findings = [`the identity record could not be checked: ${error.message}`]; }
  if (!Array.isArray(findings) || findings.length > 0) throw new Error(`ledger.worlddesk cannot trust the research corpus: it is not this edition's — it declares edition ${JSON.stringify(value?.edition ?? null)} and this filing is for edition ${JSON.stringify(edition)}: ${(Array.isArray(findings) ? findings : ['the identity check returned no findings']).join('; ')}. ${CORPUS_TAIL}`);
  let unbound;
  try { unbound = corpusLinkFindings(base, edition, value.commit); } catch (error) { unbound = [`the dated link could not be resolved: ${error.message}`]; }
  if (!Array.isArray(unbound) || unbound.length > 0) throw new Error(`ledger.worlddesk cannot trust the research corpus: it does not bind edition ${edition} to the commit it claims — ${CORPUS_IDENTITY_FILE} names commit ${value.commit}, but ${(Array.isArray(unbound) ? unbound : ['the binding check returned no findings']).join('; ')}. Filing off this mount would derive the World Desk from one commit while the record names another. ${CORPUS_TAIL}`);
  // FRESHNESS IN, TREE OUT, AND THE ASYMMETRY IS DELIBERATE.
  // verifyCorpusFreshness reads _corpus.prepared.json and checks that this really
  // is the prepared research for this edition and that its declared sources still
  // digest to the raw captures on the mount. That is the "not silently serving
  // stale research" property, and a World Desk figure derived from last night's
  // captures under today's date is exactly the thing nobody downstream can see.
  // A dated directory with the right name and no prepared metadata at all used to
  // be filed from without complaint.
  //
  // verifyCorpusTree is NOT called here, and must not be added: it requires all
  // six reporter desk indexes and every story file they name. A World Desk filing
  // does not rest on reporter desks -- it reads worlddesk/ and nothing else -- so
  // requiring them would refuse a legitimate filing over research that has no
  // bearing on it. Brass's read calls it because a LINEUP does rest on those
  // desks. One mount, two readers, two different things to be true.
  try { verifyCorpusFreshness(base, edition); } catch (error) { throw new Error(`ledger.worlddesk cannot trust the research corpus: it is not the prepared research for edition ${edition} — ${error.message}. ${CORPUS_TAIL}`); }
}

// Prior published editions are served by the content volume, the public trace
// log (`content/log`) by the image: public-content.mjs owns which is which.
async function latestPriorDerived(publicRoot, edition, env) {
  const editionsRoot = env[CONTENT_VOLUME_ENV] ? publicEditionsRoot({ env }) : within(publicRoot, 'content/editions');
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

// Reached only once the mount is declared and its corpus has been accepted for
// this edition, so an absent refusal.json here means the producer has written
// neither a document nor a refusal — never that the mount is missing. The two
// used to share one message, and an error naming a document costs a wake looking
// for a file on a path that was never mounted.
async function authenticateFallback({ args, privateRoot, publicRoot, env }) {
  const dir = within(privateRoot, args.edition, 'worlddesk');
  const refusal = await maybeJson(path.join(dir, 'refusal.json'));
  if (refusal === undefined) throw new Error(`ledger.worlddesk has a readable research corpus for edition ${args.edition} but no World Desk document in it: neither a prepared document at ${path.join(dir, 'ledger.worlddesk.json')} nor a refusal at ${path.join(dir, 'refusal.json')} exists, so the World Desk producer has not written this edition yet`);
  if (refusal.version !== 'clank.worlddesk-trace.v1' || refusal.edition !== args.edition || refusal.refused !== true) throw new Error('ledger.worlddesk current refusal is malformed');
  const currentTrace = await readJson(path.join(dir, 'trace.json')).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires the private trace beside the refusal at ${path.join(dir, 'trace.json')}`); throw error; });
  if (currentTrace.version !== 'clank.worlddesk-trace.v1' || currentTrace.edition !== args.edition || currentTrace.escalation?.index !== null || !Array.isArray(currentTrace.escalation?.unresolved) || currentTrace.escalation.unresolved.length === 0) throw new Error('ledger.worlddesk current refusal trace is malformed');
  if (canonicalJson(refusal.unresolved) !== canonicalJson(currentTrace.escalation.unresolved)) throw new Error('ledger.worlddesk current refusal does not match its trace');
  const prior = await latestPriorDerived(publicRoot, args.edition, env);
  const expected = { world_desk: { ...structuredClone(prior.document.world_desk), delta: 'stale' } };
  const { markets: _, ...filedDesk } = args.document;
  if (canonicalJson(expected) !== canonicalJson(filedDesk)) throw new Error(`ledger.worlddesk fallback must carry the latest prior derived public World Desk document (${prior.edition}) with only delta changed to stale`);
  await assertMarkets(dir, args.document);
}

// TODAY'S MARKETS, EVEN ON A STALE WORLD DESK DAY
// -----------------------------------------------
// The producer writes the Tape's FRED board to worlddesk/markets.json whether
// or not the escalation index refused, and embeds it in ledger.worlddesk.json
// on a derived day. Either way the filed `markets` must be that file, byte for
// canonical byte: a board Ledger dropped would leave the Tape's "rates · FX ·
// commodities · equities" promise unkept, and a board Ledger edited would put
// a number on the page nobody observed. No file, no board.
async function assertMarkets(dir, document) {
  const markets = await maybeJson(path.join(dir, 'markets.json'));
  if (markets === undefined) {
    if (document.markets !== undefined) throw new Error(`ledger.worlddesk carries "markets" but the producer wrote no ${path.join(dir, 'markets.json')} for this edition — remove "markets"; the board is copied, never authored`);
    return;
  }
  if (canonicalJson(markets) !== canonicalJson(document.markets)) throw new Error(`ledger.worlddesk "markets" must be ${path.join(dir, 'markets.json')} copied verbatim (the producer's FRED board for this edition) — copy that file's contents as the "markets" key and file again`);
}

export async function authenticateWorldDeskFiling(args, { env = process.env, cwd = process.cwd() } = {}) {
  if (!date.test(args.edition)) throw new Error(`ledger.worlddesk edition ${JSON.stringify(args.edition)} must be YYYY-MM-DD`);
  const privateRoot = corpusMount(env);
  const publicRoot = path.resolve(env.CLANK_PUBLIC_SOURCE_ROOT ?? path.join(cwd, 'repos/newsroom'));
  // The order is the diagnostic: the mount, then the corpus on it, then the
  // document in the corpus. Three causes, three refusals, none of them wearing
  // another's message.
  await assertCorpus(privateRoot, args.edition);
  const dir = within(privateRoot, args.edition, 'worlddesk');
  const preparedPath = path.join(dir, 'ledger.worlddesk.json'), traceFile = path.join(dir, 'trace.json');
  const prepared = await maybeJson(preparedPath);
  if (prepared === undefined) return authenticateFallback({ args, privateRoot, publicRoot, env });
  const trace = await readJson(traceFile).catch(error => { if (error.code === 'ENOENT') throw new Error(`ledger.worlddesk requires the private trace beside the prepared document at ${traceFile}`); throw error; });
  const { markets: _, ...preparedDesk } = prepared, { markets: __, ...filedDesk } = args.document;
  if (canonicalJson(preparedDesk) !== canonicalJson(filedDesk)) throw new Error('ledger.worlddesk document does not match the mounted private prepared document; copy the producer payload verbatim');
  await assertMarkets(dir, args.document);
  if (trace.edition !== args.edition) throw new Error(`ledger.worlddesk trace edition ${JSON.stringify(trace.edition)} does not match filing edition ${args.edition}`);
  validTrace(args.document, trace);
}
