// forecast-settlement.mjs — a forecast's headline and its settlement must be one event.
//
// On 2026-10-06 the Quebec forecast ran "Parti Québécois … is a 28% shot at a
// majority" while its confidence.label also settled NO "if no complete official
// seat table is posted by" 12 October. The headline's event (a majority) and
// the settled event (a majority AND a table published by a date) differed, and
// the deck never named the deadline. These checks catch that shape at filing:
//
//   forecast_probability  a probability printed in the headline or deck
//                         ("a 28% shot", "Probability 28%", "a 0.82
//                         probability") differs from round(confidence.value*100)
//   forecast_event        the event after the headline's probability ("shot at
//                         a majority") names words the label never settles on,
//                         and no deck sentence ties that word to the label's
//                         own numbers ("short of 64 for a majority")
//   forecast_deadline     the label adds a no-publication / no-winner clause
//                         with a deadline ("or if no … is posted by then") and
//                         neither headline nor deck names that date
//
// Heuristic by design and calibrated on every archived forecast: of the 33 in
// content/editions, only the 10-06 Quebec piece trips it. Pure, no I/O.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE_PATTERNS = [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'giu'), new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'giu')];
const PCT = '(\\d{1,3}(?:\\.\\d+)?)\\s?(?:%|percent\\b|per cent\\b)';
const DEC = '(0?\\.\\d{1,3})(?!\\d|\\s*%|\\s*percent)';
const NOUN = '(shot|chance|probability|likelihood|odds|favou?rite|bet|call)';
const CUE = '\\b(?:probability|chance|odds|likelihood|call)\\s+(?:is\\s+|of\\s+|at\\s+|sits\\s+at\\s+|stands\\s+at\\s+)?';
// [regex, scale]: a captured percentage compares as-is, a captured decimal times 100.
const PROBABILITY = [[new RegExp(`${PCT}\\s+${NOUN}\\b`, 'giu'), 1], [new RegExp(`${CUE}${PCT}`, 'giu'), 1], [new RegExp(`\\b${DEC}\\s+(probability|chance|likelihood)\\b`, 'giu'), 100], [new RegExp(`${CUE}${DEC}`, 'giu'), 100]];
// A NO branch that adds a condition beyond the headline event: nothing is
// posted/published/named by a deadline. "by then" points at the label's date.
const NO_CLAUSE = /\b(?:if\s+no\b|(?:is|are)\s+not\b)[^.;]*?\b(?:posted|published|named|declared|announced|certified|issued|released|confirmed|reported|signed|held)\b[^.;]*?\bby\b([^.;]*)/iu;
const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'for', 'to', 'in', 'on', 'by', 'that', 'this', 'its', 'it', 'is', 'be', 'will', 'with', 'and', 'or', 'as', 'than', 'from', 'into', 'over', 'under', 'before', 'after', 'outright', 'clear']);

const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const tokens = (text) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const stem = (word) => word.replace(/(?:ing|ies|es|ed|s)$/u, '') || word;
const mentions = (haystack, word) => { const root = stem(word); return tokens(haystack).some((token) => token === word || (root.length >= 3 && token.startsWith(root))); };
const numbers = (text) => new Set(fold(text).match(/\d+(?:\.\d+)?/gu) ?? []);
const sentences = (text) => String(text ?? '').split(/(?<=[.!?;])\s+/u);

/** Every "day month" in `text`, keyed as "12-oct" whatever the order or spelling. */
export function datesIn(text) {
  const out = [];
  for (const [index, pattern] of DATE_PATTERNS.entries()) for (const match of String(text ?? '').matchAll(pattern)) {
    const [day, month] = index === 0 ? [match[1], match[2]] : [match[2], match[1]];
    out.push({ key: `${Number(day)}-${MONTHS.find((name) => fold(month).startsWith(name))}`, text: match[0] });
  }
  return out;
}

/** `[{ value, at, after }]`: each probability printed in `text`, in percent, with the words after it. */
export function printedProbabilities(text) {
  const found = [];
  for (const [pattern, scale] of PROBABILITY) for (const match of String(text ?? '').matchAll(pattern)) {
    const end = match.index + match[0].length;
    found.push({ value: Number(match[1]) * scale, at: match[0], after: String(text).slice(end).split(/[,.;:!?—–]/u)[0] });
  }
  return found;
}

/** Findings `{ path, code, message }` for one forecast filing; [] for anything else. */
export function forecastSettlementFindings(article) {
  const findings = [];
  const value = article?.confidence?.value, label = article?.confidence?.label;
  if (article?.epistemic !== 'forecast' || typeof value !== 'number' || !Number.isFinite(value) || typeof label !== 'string') return findings;
  const headline = typeof article.headline === 'string' ? article.headline : '', deck = typeof article.deck === 'string' ? article.deck : '';
  const percent = Math.round(value * 100);
  for (const [field, text] of [['headline', headline], ['deck', deck]]) for (const printed of printedProbabilities(text)) {
    if (Math.round(printed.value) !== percent) findings.push({ path: field, code: 'forecast_probability', message: `prints "${printed.at}" but confidence.value is ${value} (${percent}%) — the headline and deck state the same probability the call settles on` });
  }
  for (const printed of printedProbabilities(headline)) {
    const words = tokens(printed.after).filter((word) => !STOP.has(word) && (word.length >= 3 || /^\d+$/u.test(word)));
    const labelNumbers = numbers(label);
    const bridged = (word) => sentences(deck).some((sentence) => mentions(sentence, word) && [...numbers(sentence)].some((n) => labelNumbers.has(n)));
    const missing = words.filter((word) => !mentions(label, word) && !bridged(word));
    if (missing.length > 0) findings.push({ path: 'headline', code: 'forecast_event', message: `"${printed.at}${printed.after}" names ${missing.map((word) => `"${word}"`).join(', ')}, which confidence.label never settles on — state in the headline the event the label settles, or tie it in the deck to the label's own terms ("short of 64 for a majority")` });
  }
  const clause = label.match(NO_CLAUSE);
  if (clause) {
    const deadline = datesIn(clause[1])[0] ?? datesIn(label)[0];
    const named = new Set(datesIn(`${headline} ${deck}`).map((date) => date.key));
    if (deadline && !named.has(deadline.key)) findings.push({ path: 'deck', code: 'forecast_deadline', message: `confidence.label also settles NO when "${clause[0].trim()}", a condition with a deadline (${deadline.text}) that neither headline nor deck names, so the printed call and the settled call differ — drop that condition from the label, or name the deadline in the deck ("…if the official seat table is posted by 12 October")` });
  }
  return findings;
}
