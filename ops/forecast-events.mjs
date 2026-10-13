import { createHash } from 'node:crypto';
import { callDeadline } from './ledger-states.mjs';

export const wordingKey = (call) => String(call ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();
const thirdPerson = verb => /(?:s|sh|ch|x|z|o)$/iu.test(verb) ? `${verb}es` : /[^aeiou]y$/iu.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;

export function forecastEvent(call, opened, metadata = {}) {
  const published = String(call).trim();
  const clause = published.replace(/^yes if\s+/iu, '').split(/;\s*(?:no if|otherwise no|no otherwise)\b/iu)[0].replace(/[.]$/u, '');
  let negative = false;
  const affirmative = clause
    .replace(/^no\s+/iu, () => { negative = true; return ''; })
    .replace(/\b(does|do)(?: not|n't)\s+([a-z]+)\b/iu, (match, auxiliary, verb, offset) => {
      if (/[,;]|\b(?:that|which|who|and|or|if)\b/iu.test(clause.slice(0, offset))) return match;
      negative = true;
      return auxiliary.toLowerCase() === 'does' ? thirdPerson(verb) : verb;
    })
    .replace(/\b(is|are|will)(?: not|n't)\b/iu, (match, auxiliary, offset) => {
      if (/[,;]|\b(?:that|which|who|and|or|if)\b/iu.test(clause.slice(0, offset))) return match;
      negative = true; return auxiliary;
    })
    .replace(/^(?:a|an)\s+/iu, '');
  const negated = metadata.negated ?? negative;
  if (negative && !negated) throw new Error('Negative forecast wording conflicts with explicit affirmative polarity');
  // Explicit links can orient paraphrases whose grammar is not recognized.
  const canonical = negated && !negative ? `the following condition is false: “${clause}”` : affirmative;
  const deadline = callDeadline(call, opened);
  const identity = `${wordingKey(canonical)}|${deadline ?? ''}`;
  return {
    event_id: metadata.event_id ?? `event-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    negated,
    deadline,
    call: negated ? `Yes if ${canonical}; no if that event does not occur by that deadline.` : published,
  };
}

export const orientedProbability = (p, negated) => negated ? Math.round((1 - p) * 1e12) / 1e12 : p;
export const directionalOutcome = (p, eventOutcome) => (p >= 0.5) === eventOutcome ? 'hit' : 'miss';
export const eventHappened = (entry) => typeof entry.event_outcome === 'boolean' ? entry.event_outcome : (entry.prior_p >= 0.5) === (entry.outcome === 'hit');
