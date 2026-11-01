// The lineup Brass records, and the one change Brass may make to it afterwards.
// Pure checks over plain records: production-newsroom.mjs reads and writes the
// edition state, this module decides what a lineup may hold.
import { ASSIGNMENTS_MINIMUM } from '../../ops/edition-floor.mjs';

export const LINEUP_DESKS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
export const AMEND_CHANGES = ['recast', 'withdraw'];
const component = /^[a-z0-9][a-z0-9-]{0,127}$/;
const desks = new Set(LINEUP_DESKS);
const fields = (value, required, optional) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  const keys = Object.keys(value), missing = required.filter(key => !(key in value)), unexpected = keys.filter(key => !required.includes(key) && !optional.includes(key));
  if (missing.length || unexpected.length) throw new Error(`invalid fields; missing: [${missing.join(', ')}], unexpected: [${unexpected.join(', ')}]; required: [${required.join(', ')}], optional: [${optional.join(', ')}]`);
};
const assertBrief = (brief, label) => {
  if (typeof brief !== 'string' || brief.length < 20) throw new Error(`${label} must be a string of at least 20 characters, got ${typeof brief === 'string' ? `${brief.length} characters` : typeof brief}`);
};

/** Validates a lineup and returns its forecast item, or undefined on a day with no forecast. */
export function assertLineup(assignments) {
  if (!Array.isArray(assignments)) throw new Error('assignments must be an array of {id, owner, brief, evidence_refs} objects');
  if (assignments.length < ASSIGNMENTS_MINIMUM) throw new Error(`assignments must include at least ${ASSIGNMENTS_MINIMUM} items, got ${assignments.length}: composition needs ${ASSIGNMENTS_MINIMUM - 1} passed pieces and the extra one is the spare against a spike; it may be a short piece`);
  assignments.forEach((item, index) => {
    try { fields(item, ['id', 'owner', 'brief', 'evidence_refs'], ['slot', 'dissenter']); } catch (error) { throw new Error(`assignments[${index}] ${error.message}`); }
    if (!component.test(item.id)) throw new Error(`assignments[${index}].id ${JSON.stringify(item.id)} must be 1-128 lowercase alphanumeric/hyphen characters, starting with a letter or digit`);
    if (!desks.has(item.owner)) throw new Error(`assignments[${index}].owner ${JSON.stringify(item.owner)} must be one of: ${LINEUP_DESKS.join(', ')}`);
    assertBrief(item.brief, `assignments[${index}].brief`);
    if (!Array.isArray(item.evidence_refs)) throw new Error(`assignments[${index}].evidence_refs must be an array of strings`);
    if (item.slot !== undefined && item.slot !== 'forecast') throw new Error(`assignments[${index}].slot ${JSON.stringify(item.slot)} must be "forecast": it is the only slot the lineup names`);
    if (item.dissenter !== undefined) {
      if (item.slot !== 'forecast') throw new Error(`assignments[${index}].dissenter is only meaningful beside slot "forecast"; a dissent is held against a dated call, so name the slot too or drop the dissenter`);
      if (!desks.has(item.dissenter)) throw new Error(`assignments[${index}].dissenter ${JSON.stringify(item.dissenter)} must be one of: ${LINEUP_DESKS.join(', ')}`);
      if (item.dissenter === item.owner) throw new Error(`assignments[${index}].dissenter ${JSON.stringify(item.dissenter)} is the owner of the piece; nobody dissents from their own byline, name a different desk`);
    }
  });
  const ids = assignments.map(item => item.id), duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`assignments[].id must be unique, got duplicates: ${[...new Set(duplicates)].join(', ')}`);
  const slotted = assignments.filter(item => item.slot === 'forecast');
  if (slotted.length > 1) throw new Error(`at most one assignment may carry slot "forecast", got ${slotted.length}: ${slotted.map(item => item.id).join(', ')}`);
  if (slotted.length === 1 && slotted[0].dissenter === undefined) throw new Error(`assignments[${assignments.indexOf(slotted[0])}].dissenter is required for the forecast slot and must name a different desk`);
  return slotted[0];
}

/** Validates an amend_assignment request (everything but edition identity). */
export function assertAmendment(args) {
  fields(args, ['edition', 'event_key', 'article_id', 'change'], ['brief']);
  if (!component.test(args.article_id)) throw new Error(`article_id ${JSON.stringify(args.article_id)} must be the id of a recorded assignment`);
  if (!AMEND_CHANGES.includes(args.change)) throw new Error(`change must be "recast" (a new brief, never the forecast) or "withdraw" (the piece is dropped), got ${JSON.stringify(args.change)}`);
  if (args.change === 'recast') assertBrief(args.brief, 'brief');
  else if (args.brief !== undefined) throw new Error('withdraw carries no brief: the piece is dropped, not rewritten');
  return args;
}

/**
 * Applies one amendment to one assignment record. Returns the changed record,
 * or undefined when the record does not carry that article id. A recast keeps
 * the owner, id and evidence and replaces the brief; a recast piece is never
 * the forecast, so its slot and dissenter go with the old brief.
 */
export function amendRecord(record, { article_id, change, brief, event_key }) {
  const index = (record?.assignments ?? []).findIndex(item => item.id === article_id);
  if (index < 0) return undefined;
  const prior = record.assignments[index];
  const assignments = change === 'withdraw'
    ? record.assignments.filter((_, position) => position !== index)
    : record.assignments.map((item, position) => {
      if (position !== index) return item;
      const { slot: _slot, dissenter: _dissenter, ...rest } = item;
      return { ...rest, brief };
    });
  return { ...record, assignments, amendments: [...(record.amendments ?? []), { article_id, change, event_key, prior }] };
}
