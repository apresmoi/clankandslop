import { createHash } from 'node:crypto';

export const SIGNAL_DISPOSITIONS = ['qualified', 'ignore', 'defer', 'duplicate'];
export const SIGNAL_DESKS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
export const signalKey = source => createHash('sha256').update(source).digest('hex').slice(0, 32);
const sourceIdentity = value => {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 3 || value.length > 1024 || /[\r\n\0]/u.test(value)) throw new Error('source_id must be a stable story id or primary URL, 3-1024 characters on one line');
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) { url.hash = ''; return url.href; } } catch { /* Corpus story ids are also valid identities. */ }
  return value;
};

export function normalizeSignal(args) {
  const allowed = ['edition', 'event_key', 'summary', 'selected_desks', 'evidence_refs', 'source_id', 'disposition', 'duplicate_of', 'expected_revision'];
  const required = ['edition', 'event_key', 'summary', 'evidence_refs'];
  if (required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('invalid signal fields');
  const disposition = args.disposition ?? 'qualified';
  if (!SIGNAL_DISPOSITIONS.includes(disposition)) throw new Error(`disposition must be one of: ${SIGNAL_DISPOSITIONS.join(', ')}`);
  if (typeof args.summary !== 'string' || args.summary.length < 20 || args.summary.length > 8000) throw new Error('summary must be a string between 20 and 8000 characters');
  if (disposition !== 'qualified' && args.source_id === undefined) throw new Error('source_id is required for ignore, defer and duplicate dispositions');
  const selected = args.selected_desks ?? [];
  if (!Array.isArray(selected) || selected.some(value => !SIGNAL_DESKS.includes(value)) || new Set(selected).size !== selected.length) throw new Error('selected_desks must be unique reporter desk names');
  if (disposition === 'qualified' && selected.length === 0) throw new Error('selected_desks must be a non-empty array for qualified leads');
  if (!Array.isArray(args.evidence_refs) || args.evidence_refs.some(value => typeof value !== 'string' || value.length > 1024)) throw new Error('evidence_refs must be an array of strings, each at most 1024 characters');
  if (args.expected_revision !== undefined && (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1)) throw new Error('expected_revision must be a positive integer');
  const source_id = sourceIdentity(args.source_id ?? args.event_key);
  const duplicate_of = args.duplicate_of === undefined ? undefined : sourceIdentity(args.duplicate_of);
  if ((disposition === 'duplicate') !== (duplicate_of !== undefined)) throw new Error('duplicate_of is required only for the duplicate disposition');
  if (duplicate_of === source_id) throw new Error('a signal cannot duplicate itself');
  return { source_id, disposition, summary: args.summary, selected_desks: [...selected].sort(), evidence_refs: [...new Set(args.evidence_refs)].sort(), ...(duplicate_of === undefined ? {} : { duplicate_of }) };
}

const recordInput = value => Object.fromEntries(
  ['edition', 'event_key', 'summary', 'selected_desks', 'evidence_refs', 'source_id', 'disposition', 'duplicate_of']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]])
);

export async function saveSignalDisposition(args, { read, write, receipt }) {
  const normalized = normalizeSignal(args), id = signalKey(normalized.source_id);
  const prior = await read(id);
  if (normalized.duplicate_of) {
    const target = await read(signalKey(normalized.duplicate_of));
    if (!target || target.disposition === 'duplicate') throw new Error('duplicate_of must name an existing non-duplicate source_id in this edition');
  }
  const unchanged = prior !== undefined && JSON.stringify(normalizeSignal(recordInput(prior))) === JSON.stringify(normalized);
  if (prior && !unchanged && args.expected_revision !== (prior.revision ?? 1)) throw new Error(`signal changed: read candidates/${id}.json and use expected_revision ${prior.revision ?? 1} for an intentional update`);
  if (!prior && args.expected_revision !== undefined) throw new Error('expected_revision names a signal that does not exist');
  const value = unchanged && prior.version === 'clank.qualified-signal.v2' ? prior : {
    version: 'clank.qualified-signal.v2', id, edition: args.edition, event_key: args.event_key,
    revision: unchanged ? (prior.revision ?? 1) : (prior?.revision ?? 0) + 1, ...normalized
  };
  if (value !== prior) await write(id, value, { replace: prior !== undefined });
  return {
    qualified: value.disposition === 'qualified', disposition: value.disposition, selected_desks: value.selected_desks,
    source_id: value.source_id, candidate_id: id, revision: value.revision, unchanged,
    next: 'Saved to the edition INDEX as a lead decision, not a commission. A concise room:sensor digest may use plain desk names, claims, URLs and verification gaps; do not mention reporters merely because a lead interests them. Ignore, defer and duplicate need no announcement. Only a concrete decision that cannot wait warrants one addressed request.',
    receipt: await receipt({ ...value, event_key: args.event_key })
  };
}
