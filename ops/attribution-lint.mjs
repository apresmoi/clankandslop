// attribution-lint.mjs — the three things Spike sends first drafts back for.
//
// On 2026-10-06 and 2026-10-07 Spike returned all twelve first drafts. Of the
// sixteen send-backs, eleven named a speaker the copy left unnamed or
// misattributed, eight a fact or figure stated twice, and five a statement an
// official gave to a news outlet printed without the outlet ("X told Reuters").
// Every one of those drafts was lint-clean. These checks put the three shapes in
// front of the reporter at validate_article and file_article, while the
// reporter can still fix them, instead of costing a review round each.
//
// All three are advisory, like the rest of ops/prose-lint.mjs, and the archive
// is why. Across the 492 published articles (all of them passed by Spike):
//
//   unnamed role    fires on 4: each an official or spokesperson the source
//                   itself did not name ("a US official told Al Jazeera") —
//                   legitimate when said so, which is why it stays a warning
//   pronoun         fires on 0 ("He claimed" after "Majid al-Nuzaili said"
//                   is a named speaker)
//   number_repeated fires on 62 (3 of the 47 since 2026-09-25); read, the hits
//                   are restatements ("at least 27 people dead … killed at
//                   least 27 people", "46 people" in paragraphs 1 and 7), plus
//                   a few honest repeats of a unit ("by 25 basis points" for
//                   two different hikes) — hence a warning, not a refusal
//   outlet_unnamed  fires on 0; every archived relay names its outlet
//
// Pure: no clock, no disk, no I/O.
import { quoteSpans } from './prose-leaks.mjs';

const VERB = '(?:said|says|told|tells|wrote|writes|added|adds|argued|warned|stated|claimed|insisted|explained|posted|announced)';
const ROLE = '(?:minister|spokesperson|spokesman|spokeswoman|official|source|diplomat|aide|adviser|advisor|lawmaker|senator|commander|officer|negotiator|envoy|regulator|executive|lawyer|witness|resident)';
const QUALIFIER = '(?:senior|top|former|local|regional|western|military|government|ministry|US|U\\.S\\.|Iranian|Israeli|Russian|Ukrainian|European|Chinese|security|defence|defense|foreign|state|company|industry|police|army|party)';
// "A US official said", "an Iranian diplomat told Reuters", "one senior source
// for the ministry said". The definite "the spokesman for the ministry said"
// is left alone: it is how a named speaker is referred to the second time.
const INDEFINITE_ROLE = new RegExp(`\\b(?:[Aa]n?|[Oo]ne|[Aa]nother)\\s+(?:${QUALIFIER}\\s+){0,2}${ROLE}\\s+(?:(?:for|of|at|with|from|in)\\s+(?:the\\s+)?[\\p{L}'’.-]+(?:\\s+[\\p{Lu}][\\p{L}'’.-]+)*\\s+)?${VERB}\\b`, 'u');
const PRONOUN = new RegExp(`(?:^|[\\s,“”"])([Hh]e|[Ss]he)\\s+${VERB}\\b`, 'u');
// A person's name: two capitalized words ("Bryan Bedford"), or one followed by
// a lowercase particle name ("Majid al-Nuzaili", "Ursula von der Leyen").
const PERSON = /\b\p{Lu}[\p{Ll}'’-]+(?:\s+(?:(?:al|el|bin|ibn|de|del|da|van|von|der|le|la)[\s-])*\p{Lu}[\p{L}'’-]+)+/u;

/** A paragraph's sentences, each keeping the [En] markers printed after its full stop. */
export function sentencesOf(paragraph) {
  const text = String(paragraph ?? ''), out = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]["”’)]?((?:\s*\[E\d+\])*)\s+(?=[\p{Lu}“"‘(])/gu)) {
    const end = match.index + match[0].length;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length && text.slice(start).trim()) out.push(text.slice(start).trim());
  return out;
}

/**
 * The first statement the body attributes to an unnamed speaker: an indefinite
 * role ("a US official said") or a pronoun ("he said") before any person is
 * named. Returns `{ phrase }` or undefined.
 */
export function unnamedSpeakerStatement(paragraphs) {
  let before = '';
  for (const paragraph of paragraphs) for (const sentence of sentencesOf(paragraph)) {
    const role = sentence.match(INDEFINITE_ROLE);
    if (role) return { phrase: role[0] };
    const pronoun = sentence.match(PRONOUN);
    if (pronoun && !PERSON.test(`${before} ${sentence.slice(0, pronoun.index)}`)) return { phrase: pronoun[0].trim() };
    before += ` ${sentence}`;
  }
  return undefined;
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_NUMBERS = [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'giu'), new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}\\b`, 'giu'), /\b\d{1,2}:\d{2}\b/gu, /\[E\d+\]/gu];
const FIGURE = /(?<![\w.,])([$€£]?\d[\d,]*(?:\.\d+)?)(\s?(?:%|per cent|percent|bn|m|million|billion|trillion)?)\s+([A-Za-z-]+)(?:\s+([A-Za-z-]+))?/gu;
const FILLER = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'for', 'by', 'from', 'with', 'than', 'as', 'is', 'was', 'were', 'are']);

/**
 * The first figure the body states twice with the same unit word: "27 people"
 * in one sentence and "27 people" again later. Years, dates, clock times,
 * citations, numbers below 10 and figures inside quotation marks are ignored.
 * Returns `{ figure, first, second }` (1-based paragraphs) or undefined.
 */
export function repeatedFigure(paragraphs) {
  const seen = new Map();
  for (const [index, paragraph] of paragraphs.entries()) {
    let text = String(paragraph);
    for (const span of quoteSpans(text)) text = text.slice(0, span.start) + ' '.repeat(span.end - span.start) + text.slice(span.end);
    for (const pattern of DATE_NUMBERS) text = text.replace(pattern, (found) => ' '.repeat(found.length));
    for (const match of text.matchAll(FIGURE)) {
      const raw = match[1].replace(/,/gu, ''), unit = match[2].trim().toLowerCase();
      if (/^(?:19|20)\d\d$/u.test(raw) || (Number(raw.replace(/^[$€£]/u, '')) < 10 && !unit)) continue;
      let word = match[3].toLowerCase();
      if (FILLER.has(word)) word = (match[4] ?? '').toLowerCase();
      if (!word || FILLER.has(word)) continue;
      const key = `${match[1]}${match[2]} ${word}`.replace(/\s+/gu, ' ');
      const at = `${raw}${unit} ${word}`;
      if (seen.has(at)) return { figure: seen.get(at).key, first: seen.get(at).paragraph, second: index + 1 };
      seen.set(at, { key, paragraph: index + 1 });
    }
  }
  return undefined;
}

// "told Reuters", "told the Associated Press", "said in an interview with the
// BBC", "speaking to Al Jazeera": an evidence row in which an outlet is the
// one that obtained the statement.
const RELAY = /\b(?:told|telling|speaking to|said to|(?:in|during) an interview with)\s+(?:the\s+)?(?:\p{Lu}\p{Ll}+['’]s\s+)?(\p{Lu}[\p{L}\p{N}&'’-]*(?:[ \t]+(?:of[ \t]+)?\p{Lu}[\p{L}\p{N}&'’-]*){0,3})/gu;
// Capitalized audiences that are venues, not outlets.
const VENUES = new Set(['parliament', 'congress', 'senate', 'house', 'knesset', 'bundestag', 'duma', 'court', 'reporters', 'journalists', 'state']);
const REPORTED = new RegExp(`\\b${VERB}\\b|\\baccording to\\b`, 'iu');
const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The outlets a row says obtained its statement, from its excerpt and fragment. */
export function relayOutlets(row) {
  const text = `${row?.source_note?.raw_excerpt ?? ''} ${row?.fragment ?? ''}`;
  const out = new Set();
  for (const match of text.matchAll(RELAY)) {
    const name = match[1].replace(/[.’']s?$/u, '').trim();
    if (name.length >= 2 && !VENUES.has(fold(name))) out.add(name);
  }
  return [...out];
}

/**
 * The first reported statement that cites a row in which a news outlet obtained
 * the statement ("…, a US official told Al Jazeera") while the body has not yet
 * named that outlet. Returns `{ outlet, row, paragraph }` or undefined.
 */
export function unnamedOutlet(article) {
  const box = Array.isArray(article?.evidence_box) ? article.evidence_box : [];
  const relays = new Map(box.map((row, index) => [index + 1, relayOutlets(row)]).filter(([, names]) => names.length > 0));
  if (relays.size === 0) return undefined;
  const paragraphs = (Array.isArray(article?.body) ? article.body : []).filter((value) => typeof value === 'string');
  let before = '';
  for (const [index, paragraph] of paragraphs.entries()) for (const sentence of sentencesOf(paragraph)) {
    before += ` ${sentence}`;
    if (!REPORTED.test(sentence)) continue;
    for (const match of sentence.matchAll(/\[E(\d+)\]/gu)) {
      const names = relays.get(Number(match[1]));
      if (!names) continue;
      const named = names.some((name) => fold(before).includes(fold(name)));
      if (!named) return { outlet: names[0], row: Number(match[1]), paragraph: index + 1 };
    }
  }
  return undefined;
}
