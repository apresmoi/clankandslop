// attributed-evidence.mjs — the mechanical half of the attributed-reporting rule.
//
// The sensor's quote checker re-reads every cited page. A page it could not
// open (Reuters answers with 401, paywalls, PDFs, timeouts) is unknown, not
// false, so its row reaches the Record marked
// `source_note.evidence: "attributed_unchecked"`. Such a row may support
// "Reuters reported that …" with the link, paraphrased. It may never be quoted,
// never carry a raw_excerpt, and never be the only support a filing cites.
import { quoteSpans } from './prose-leaks.mjs';

export const ATTRIBUTED_UNCHECKED = 'attributed_unchecked';
// The marker, or the sensor's own provenance sentence if a copy dropped the marker.
export const isAttributedRow = (row) =>
  row?.source_note?.evidence === ATTRIBUTED_UNCHECKED || /use only as attributed reporting/iu.test(String(row?.source_note?.provenance_note ?? ''));

// A quotation of three or more words; a quoted single term or name is not a
// claim that the outlet printed that sentence.
const QUOTE_MIN_WORDS = 3;
const SENTENCE_END = /[.!?](?=["”’)]?\s+[\p{Lu}“"])/gu;

/** [start, end) of the sentence around `index`, ignoring breaks inside quoted spans. */
function sentenceAround(text, index, spans) {
  let start = 0, end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    const at = match.index;
    if (spans.some((span) => span.start < at && at < span.end - 1)) continue;
    if (at < index) start = at + 1;
    else { end = at + 1; break; }
  }
  return [start, end];
}

/** Findings `{ path, code, message }` for one filing's body and Record. */
export function attributedEvidenceFindings(article) {
  const findings = [];
  const box = Array.isArray(article?.evidence_box) ? article.evidence_box : [];
  const attributed = new Set();
  box.forEach((row, i) => {
    if (!isAttributedRow(row)) return;
    attributed.add(i + 1);
    if (typeof row?.source_note?.raw_excerpt === 'string' && row.source_note.raw_excerpt.trim()) findings.push({ path: `evidence_box[${i}].source_note.raw_excerpt`, code: 'attributed_quote', message: `E${i + 1} is attributed reporting from a page the checker could not open; it carries no raw_excerpt — remove it and keep the row as attribution` });
  });
  if (attributed.size === 0) return findings;
  const cited = new Set();
  const body = Array.isArray(article?.body) ? article.body : [];
  body.forEach((para, i) => {
    if (typeof para !== 'string') return;
    const spans = quoteSpans(para);
    for (const match of para.matchAll(/\[E(\d+)\]/gu)) cited.add(Number(match[1]));
    for (const span of spans) {
      if (span.quote.trim().split(/\s+/u).length < QUOTE_MIN_WORDS) continue;
      const [start, end] = sentenceAround(para, span.start, spans);
      const rows = [...para.slice(start, end).matchAll(/\[E(\d+)\]/gu)].map((m) => Number(m[1])).filter((n) => attributed.has(n));
      if (rows.length > 0) findings.push({ path: `body[${i}]`, code: 'attributed_quote', message: `puts ${JSON.stringify(span.quote.slice(0, 60))} in quotation marks while citing [E${rows[0]}], attributed reporting the checker could not open; paraphrase it as "<outlet> reported that …" without quotation marks` });
    }
  });
  const citedAttributed = [...cited].filter((n) => attributed.has(n));
  const citedVerified = [...cited].some((n) => !attributed.has(n) && typeof box[n - 1]?.source_note?.raw_excerpt === 'string' && box[n - 1].source_note.raw_excerpt.trim());
  if (citedAttributed.length > 0 && !citedVerified) findings.push({ path: 'body', code: 'attributed_only', message: `cites attributed reporting (${citedAttributed.map((n) => `[E${n}]`).join(', ')}) but no verified row with a raw_excerpt; attribution adds context, it cannot be a story's only support — cite the verified excerpt that carries the central claim, or request one` });
  return findings;
}
