import { glyphFormatFindings } from './glyph-format.mjs';

const slug = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const identity = ref => `${ref.kind}:${ref.name}:${ref.sha256}`;
const validRef = ref => ref && Object.keys(ref).sort().join() === 'kind,name,sha256' && ['map', 'glyph'].includes(ref.kind) && slug.test(ref.name) && /^[a-f0-9]{64}$/u.test(ref.sha256);

// Callers authenticate immutable bytes and provenance before providing documents.
export function layoutArtifacts(decisions, artifacts, fail) {
  const maps = {}, selected = new Map(), names = new Map();
  for (const [story, choice] of Object.entries(decisions.art ?? {})) {
    if (!decisions.order.slice(0, 3).includes(story)) fail('art placement', `art for ${story} must occupy the lead or an illustrated feature slot`);
    if (choice?.artifact === undefined) continue;
    const ref = choice.artifact;
    if (!validRef(ref)) fail('art reference', `invalid artifact for ${story}`);
    if (choice.shape !== undefined || choice.roll !== undefined) fail('art selection', `generated art for ${story} cannot also select a shape or roll`);
    const found = artifacts.filter(item => validRef(item.reference) && identity(item.reference) === identity(ref));
    if (found.length !== 1 || found[0].document?.name !== ref.name) fail('art reference', `supply one authenticated ${ref.kind} document for ${story}`);
    const key = `${ref.kind}:${ref.name}`, previous = names.get(key);
    if (previous && previous !== ref.sha256) fail('art reference', `conflicting versions of ${key}`);
    names.set(key, ref.sha256);
    const document = found[0].document;
    if (ref.kind === 'glyph') {
      const errors = glyphFormatFindings(document, ref.name);
      if (errors.length) fail('glyph grid', errors.join('; '));
    } else maps[ref.name] = document;
    selected.set(identity(ref), ref);
  }
  return { maps, references: [...selected.values()] };
}
