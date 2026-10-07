// excerpt-furniture.mjs — a captured excerpt carries the article, not the page around it.
//
// 2026-10-07: the RBI story's E6 excerpt printed "… Andhra Pradesh and
// Rajasthan. Story continues below this ad Also read | RBI likely to raise
// rates: Why inflation, crude and global rates matter Reservoir levels …".
// The checker had copied the page faithfully, ad slug and related-article
// prompt included. The sensor now strips page furniture before a passage is
// filed (clankandslop-private sensors/automation/excerpt-furniture.mjs, the
// same markers); this is the filing-side refusal for whatever still gets
// through. Published editions are not re-checked.

const MARKERS = [
  ['ad_slug', /\bstory continues below(?: this)?(?: ad(?:vertisement)?)?\b/iu],
  ['ad_slug', /(?:^|[.!?"”]\s+)(?:ADVERTISEMENT|Advertisement)(?=\s+\p{Lu}|\s*$)/u],
  ['ad_slug', /\bscroll (?:down )?to continue(?: with content| reading)?\b/iu],
  ['ad_slug', /\bsubscribe to see fewer ads\b/iu],
  ['related_link', /(?:^|\s)(?:also read|read more|read also|must read|recommended(?: stories)?|related(?: stories| articles| coverage| news)?)\s*[:|>»]/iu],
  ['related_link', /\bclick here\b/iu],
  ['newsletter', /\b(?:sign up|subscribe)\b[^.]{0,60}\bnewsletters?\b/iu],
  ['newsletter', /(?:^|[.!?]\s+)subscribe (?:now|today|to (?:our|the)\b)/iu],
  ['caption', /\((?:image|photo|picture|photograph|credit|file photo)s?\s*:[^)]*\)/iu],
];

/** The page-furniture markers in a captured excerpt: `[{ kind, text }]`, empty when clean. */
export function excerptFurniture(text) {
  const excerpt = String(text ?? '');
  const out = [];
  for (const [kind, pattern] of MARKERS) {
    const match = pattern.exec(excerpt);
    if (match) out.push({ kind, text: match[0].trim() });
  }
  return out;
}

/** Findings `{ path, code, message }` for every Record excerpt that carries page furniture. */
export function excerptFurnitureFindings(article) {
  const box = Array.isArray(article?.evidence_box) ? article.evidence_box : [];
  const findings = [];
  box.forEach((row, i) => {
    for (const field of ['raw_excerpt', 'fragment']) {
      const value = field === 'fragment' ? row?.fragment : row?.source_note?.raw_excerpt;
      const found = excerptFurniture(value);
      if (found.length === 0) continue;
      const path = field === 'fragment' ? `evidence_box[${i}].fragment` : `evidence_box[${i}].source_note.raw_excerpt`;
      findings.push({ path, code: 'excerpt_furniture', message: `E${i + 1} carries page furniture, not article text (${found.map((f) => JSON.stringify(f.text)).join(', ')}); re-request the passage so the sensor files it clean, or cite a passage without it — never edit the excerpt by hand` });
    }
  });
  return findings;
}
