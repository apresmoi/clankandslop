// A revision may fix what the editor named; it may not quietly shed verified
// facts. On 2026-10-05 revisions went 323 -> 164 words and 12 -> 9 cited
// sources while the editor had asked for one clause to go. file_article refuses
// a revision that stops citing a verified excerpt the previous revision cited,
// unless the editor's REVISION_REQUEST notes named that row or quoted it.

const paragraphs = body => (Array.isArray(body) ? body : [body]).map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '');

/** excerpt text -> E-label, for every evidence row carrying a raw_excerpt that the body cites. */
export function citedExcerpts(article) {
  const box = Array.isArray(article?.evidence_box) ? article.evidence_box : [];
  const cited = new Set();
  for (const para of paragraphs(article?.body)) for (const match of para.matchAll(/\[E(\d+)\]/gu)) cited.add(Number(match[1]));
  const out = new Map();
  box.forEach((row, index) => {
    const excerpt = row?.source_note?.raw_excerpt;
    if (typeof excerpt === 'string' && excerpt.trim() && cited.has(index + 1) && !out.has(excerpt.trim())) out.set(excerpt.trim(), `E${index + 1}`);
  });
  return out;
}

const named = (notes, label, excerpt) => {
  const text = String(notes ?? '');
  if (new RegExp(`\\b${label}\\b`, 'u').test(text)) return true;
  const head = excerpt.slice(0, 40);
  return head.length >= 20 && text.includes(head);
};

/** Verified excerpts the previous revision cited, the new one does not, and the editor never named. */
export function droppedVerifiedFacts(previous, next, notes) {
  const before = citedExcerpts(previous), after = citedExcerpts(next);
  const dropped = [];
  for (const [excerpt, label] of before) if (!after.has(excerpt) && !named(notes, label, excerpt)) dropped.push({ label, excerpt });
  return dropped;
}

/** file_article's refusal: nothing is recorded when a revision sheds unnamed verified facts. */
export function assertKeepsVerifiedFacts(previous, next, notes, revision) {
  const dropped = previous ? droppedVerifiedFacts(previous, next, notes) : [];
  if (dropped.length === 0) return;
  throw new Error(`revision ${revision} drops ${dropped.length} verified fact${dropped.length === 1 ? '' : 's'} that revision ${revision - 1} cited and the editor never asked you to cut — nothing was recorded. Fix only what the editor named and keep every other verified excerpt cited: ${dropped.map(item => `${item.label} of revision ${revision - 1}: "${item.excerpt.slice(0, 120)}"`).join('; ')}`);
}
