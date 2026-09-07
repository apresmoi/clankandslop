export const ARTICLE_FORMAT_VERSION = 'clank.article-format.v1';
export const ARTICLE_REPORTER_NAMES = Object.freeze({ cogsworth: 'Cogsworth', sprockett: 'Sprockett', foreman: 'Foreman', graves: 'Graves', tinkerton: 'Tinkerton', vesta: 'Vesta' });
const text = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const probability = { ...number, minimum: 0, maximum: 1 };
const list = (items, minItems = 0) => ({ type: 'array', items, minItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const clock = { ...text, description: 'a real UTC clock time HH:MM', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' };
const slug = { ...text, pattern: '^[a-z0-9][a-z0-9-]{0,127}$' };
const note = object({ source_id: text, source_kind: text, used_by_agent: text, source_url: text, retrieved_at: text, raw_excerpt: text, provenance_note: text }, ['source_id', 'source_kind', 'used_by_agent', 'retrieved_at']);
const evidence = object({ source: text, fragment: text, as_of: text, source_note: note });
const spot = object({ name: text, lat: number, lon: number, label_side: { enum: ['left', 'right'] }, label_dy: number }, ['name', 'lat', 'lon']);
const coordinate = { ...list(number, 2), maxItems: 2 };
const color = { enum: ['red', 'accent', 'green'] };
const overlay = object({ name: text, color, ring: list(coordinate, 3) }, ['ring']);
const route = object({ name: text, color, points: list(coordinate, 2) }, ['points']);
const art = object({ kind: { enum: ['ascii', 'map'] }, caption: text, ascii: text, shape: { enum: ['colosseum', 'play', 'notfound', 'satellite', 'pumpjack', 'missile', 'drone', 'chip', 'campfire', 'eclipse'] }, roll: { enum: ['chip', 'eclipse'] }, map: slug, hero_map: slug, spots: list(spot), title: text, tone: { enum: ['normal', 'soft'] }, locator_context: { enum: ['regional', 'continental'] }, rule: { type: 'boolean' }, scale: number, cols: number, rows: number, rotX: number, rotY: number, zoom: number, overlays: list(overlay), routes: list(route) }, ['kind', 'caption']);

/** Target filing schema; semantic checks live beside it. */
export const articleFilingSchema = object({
  id: slug, edition_date: { ...text, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  section: text, kicker: text, headline: text, deck: text,
  epistemic: { enum: ['fact', 'inference', 'forecast'] },
  byline: object({ desk: text, agents: { ...list({ enum: Object.values(ARTICLE_REPORTER_NAMES) }, 1), maxItems: 1 } }),
  timestamp: { ...text, pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9] UTC$' },
  revision: { type: 'integer', minimum: 1 }, next_update_utc: clock,
  topics: { ...list(text), uniqueItems: true }, body: list(text, 4),
  key_numbers: list(object({ label: text, value: text, dir: { enum: ['up', 'down', 'flat'] } }, ['label', 'value'])),
  evidence_box: list(evidence, 1), refs: { ...list(text, 1), uniqueItems: true },
  confidence: object({ label: text, value: probability, interval: probability }, ['label', 'value']),
  presentation: object({ flashpoint: object({ place: text, lat: number, lon: number, note: text }) }),
  previous_coverage: list(object({ date: { ...text, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, slug })), art,
}, ['edition_date', 'section', 'kicker', 'headline', 'deck', 'epistemic', 'byline', 'timestamp', 'revision', 'next_update_utc', 'topics', 'body', 'key_numbers', 'evidence_box', 'refs']);

/** Historical renderer-compatible shape, without retroactively rewriting the archive. */
export function articleArchiveSchema() {
  const schema = structuredClone(articleFilingSchema);
  const loosen = (node) => { if (!node || typeof node !== 'object') return; delete node.additionalProperties; for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(loosen); else loosen(value); } };
  loosen(schema);
  schema.required = ['id', 'edition_date', 'section', 'kicker', 'headline', 'timestamp', 'byline', 'revision', 'body', 'refs'];
  const p = schema.properties;
  p.id = text; p.edition_date = text; p.timestamp = text; p.next_update_utc = { type: 'string' };
  p.byline.properties.agents = list(text, 1); p.revision = number;
  p.body = list({ anyOf: [text, object({ glyph: text, side: { enum: ['left', 'right', 'full'] }, caption: text }, ['glyph'])] }, 1);
  p.refs = list(text); p.topics = list(text);
  p.evidence_box = list({ type: 'object', required: ['source', 'fragment'], properties: { source: text, fragment: text, source_note: { type: 'object' } } });
  p.confidence = { type: 'object', properties: { value: probability }, required: ['value'] };
  p.dissent = { type: 'object', properties: { agent: text, p: probability, argument: text }, required: ['agent', 'p', 'argument'] };
  p.art = { anyOf: [{ type: 'null' }, { ...art, additionalProperties: true }] };
  loosen(schema);
  return schema;
}

export function schemaFindings(value, schema, path = 'article') {
  const errors = [];
  const add = (code, message) => errors.push({ path, code, message });
  if (schema.anyOf) {
    if (schema.anyOf.every((candidate) => schemaFindings(value, candidate, path).length)) add('type', 'must match one of the supported field shapes');
    return errors;
  }
  const type = schema.type;
  const valid = type === undefined || (type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type);
  if (!valid) { add('type', `must be ${type === 'object' ? 'a JSON object' : `a ${type}`}`); return errors; }
  if (schema.enum && !schema.enum.includes(value)) add('enum', `must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) add('required', 'must be a non-empty string');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) add('pattern', schema.description ? `must be ${schema.description}` : `must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('range', `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add('range', `must be at most ${schema.maximum}`);
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, code: 'required', message: 'is required' });
    for (const [key, item] of Object.entries(value)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
      if (property) errors.push(...schemaFindings(item, property, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, code: 'unknown_key', message: 'is not a supported publication field' });
    }
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) add('length', `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add('length', `must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) add('duplicate', 'must not repeat entries');
    if (schema.items) value.forEach((item, i) => errors.push(...schemaFindings(item, schema.items, `${path}[${i}]`)));
  }
  return errors;
}
