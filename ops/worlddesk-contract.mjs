const num = value => typeof value === 'number' && Number.isFinite(value);
const canon = value => Array.isArray(value) ? value.map(canon) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canon(value[key])])) : value;

export const canonicalJson = value => JSON.stringify(canon(value));

export function expectedDeltaWord(trace) {
  const current = trace?.delta?.current, previous = trace?.delta?.previous;
  if (current === null || current === undefined) return null;
  if (previous === null || previous === undefined) return 'first reading';
  const change = current - previous;
  if (Math.abs(change) <= 0.005) return 'steady';
  return change > 0 ? 'rising' : 'easing';
}

export function worldDeskCanonicalFindings(document, trace) {
  const out = [], desk = document?.world_desk;
  if (trace?.version !== 'clank.worlddesk-trace.v1') out.push('ledger.worlddesk trace version is not clank.worlddesk-trace.v1');
  if (trace?.edition !== undefined && desk?.from !== `content/log/${trace.edition}/worlddesk.json`) out.push('world_desk.from does not match the trace edition');
  const terms = trace?.escalation?.terms;
  if (!Array.isArray(terms) || terms.length === 0) out.push('trace.escalation.terms must be a non-empty array');
  else {
    const denominator = terms.reduce((sum, term) => sum + (num(term.severity) ? term.severity : 0), 0);
    const numerator = terms.filter(term => term.state === 'triggering').reduce((sum, term) => sum + (num(term.severity) ? term.severity : 0), 0);
    if (terms.some(term => !num(term.severity))) out.push('trace.escalation.terms[].severity must be numeric');
    if (denominator !== trace.escalation?.denominator) out.push('trace.escalation.denominator does not equal the sum of term severities');
    if (trace.escalation?.index === null) {
      if (trace.escalation?.numerator !== null) out.push('trace.escalation.numerator must be null when index is null');
    } else {
      if (numerator !== trace.escalation?.numerator) out.push('trace.escalation.numerator does not equal triggering severity');
      if (desk?.escalation_index !== Number((numerator / denominator).toFixed(4))) out.push('world_desk.escalation_index does not equal the canonical trace index');
      if (trace.escalation?.index !== desk?.escalation_index) out.push('trace.escalation.index does not match world_desk.escalation_index');
    }
  }
  const entries = trace?.flashpoints?.entries;
  if (!Array.isArray(entries)) out.push('trace.flashpoints.entries must be an array');
  else {
    const open = entries.filter(entry => entry.status === 'open').length, watch = entries.filter(entry => entry.status === 'watch').length;
    if (open !== desk?.open_conflicts || open !== trace.flashpoints?.open_conflicts) out.push('open_conflicts does not equal trace entries with status open');
    if (watch !== desk?.watch || watch !== trace.flashpoints?.watch) out.push('watch does not equal trace entries with status watch');
  }
  if (trace?.delta?.word !== expectedDeltaWord(trace)) out.push('trace.delta.word does not match current/previous');
  if (trace?.delta?.word !== desk?.delta) out.push('world_desk.delta does not match trace.delta.word');
  for (const key of ['escalation', 'flashpoints']) if (!/^[0-9a-f]{64}$/u.test(trace?.[key]?.registry?.sha256 ?? '')) out.push(`ledger.worlddesk trace ${key} registry digest is missing or invalid`);
  return out;
}
