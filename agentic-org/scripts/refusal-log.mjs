// Every refused newsroom tool call, kept where tomorrow can read it.
//
// The audit of 2026-10-06/07 could not recover a single tool refusal: the
// agents' session transcripts went with the container, the tool cache keeps
// only accepted calls, and the edition history records only accepted
// operations. So "did lead_reason refuse anyone?" had no answer. Now each
// refusal, and each lint warning on an accepted filing, is appended as one
// JSON line to editions/<date>/refusals.jsonl in the edition state, and the
// INDEX carries a one-line count.
//
// The append happens OUTSIDE the edition transaction on purpose: a refused
// call commits nothing, and taking the edition lock to record that would make
// a refusal wait on, and contend with, the next accepted call. One write(2)
// with O_APPEND per line keeps concurrent lines whole. The INDEX is NOT
// rewritten here, because rebuilding it outside the lock can race an
// operation's commit and publish a half-true index; the count catches up on
// the next accepted call. Logging never changes the tool's answer: a failed
// append is swallowed and the agent sees exactly the refusal it would have.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const REFUSAL_LOG = 'refusals.jsonl';
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MESSAGE_LIMIT = 4000;

const logFile = (root, edition) => {
  const base = path.resolve(root, 'editions', edition), file = path.join(base, REFUSAL_LOG);
  if (!file.startsWith(`${base}${path.sep}`)) throw new Error('refusal log escaped the edition');
  return file;
};

/** Append one entry; never throws. `kind` is "refused" or "warning". */
export async function appendRefusal({ root = process.env.CLANK_EDITION_STATE_ROOT, edition, agent = process.env.CLANK_NEWSROOM_AGENT ?? null, tool, kind = 'refused', message, event_key, artifact, now = new Date() }) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof edition !== 'string' || !DATE.test(edition)) return false;
    const file = logFile(root, edition);
    await mkdir(path.dirname(file), { recursive: true });
    const entry = { at: now.toISOString(), agent, tool, kind, ...(typeof event_key === 'string' ? { event_key: event_key.slice(0, 200) } : {}), ...(artifact ? { artifact: String(artifact).slice(0, 200) } : {}), message: String(message ?? '').slice(0, MESSAGE_LIMIT) };
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

const artifactOf = (args) => args?.article_id ? `${args.article_id}/${args.revision}` : args?.article?.id ? `${args.article.id}/${args.article.revision}` : args?.name;

/**
 * Wrap a tool's `execute`: a throw is logged as "refused" and rethrown
 * unchanged; an accepted call that carries `warnings` logs each as "warning".
 */
export const withRefusalLog = (tool, execute) => async (args) => {
  const edition = args?.edition, context = { edition, tool, event_key: args?.event_key, artifact: artifactOf(args) };
  let result;
  try { result = await execute(args); } catch (error) {
    await appendRefusal({ ...context, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  for (const warning of Array.isArray(result?.warnings) && tool === 'file_article' ? result.warnings : []) await appendRefusal({ ...context, kind: 'warning', message: warning });
  return result;
};

/** The parsed log for an edition directory; unreadable lines are counted, never fatal. */
export async function readRefusals(editionDir) {
  let text;
  try { text = await readFile(path.join(editionDir, REFUSAL_LOG), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { entries: [], unreadable: 0 }; throw error; }
  const entries = []; let unreadable = 0;
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { unreadable++; } }
  return { entries, unreadable };
}

/** The INDEX line: counts by kind, tool and agent. Empty when nothing was refused. */
export function refusalIndexLine({ entries, unreadable }) {
  if (entries.length === 0 && unreadable === 0) return [];
  const count = (pick, list) => [...list.reduce((map, item) => map.set(pick(item), (map.get(pick(item)) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([key, n]) => `${key}=${n}`).join(',');
  const refused = entries.filter((item) => item?.kind !== 'warning'), warned = entries.filter((item) => item?.kind === 'warning');
  return [`# refusals: refused=${refused.length}${refused.length ? ` tools=${count((item) => item.tool ?? '?', refused)} agents=${count((item) => item.agent ?? '?', refused)}` : ''} warnings=${warned.length}${unreadable ? ` unreadable=${unreadable}` : ''} · cat ${REFUSAL_LOG}`];
}
