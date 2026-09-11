const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const rows = (value) => Array.isArray(value) ? value : [];

const LEAK_PATTERNS = [
  {
    code: 'sensor_answer',
    pattern: /\b(?:a|an|the|same|fuller)\s+sensor\s+(?:answer|return)\b/iu,
    message: 'reader-facing prose exposes an internal research-sensor answer; attribute the underlying source instead'
  },
  {
    code: 'sensor_supplied',
    pattern: /\bsensor[-\s]supplied\b/iu,
    message: 'reader-facing prose exposes internal sensor supply mechanics; attribute the underlying source instead'
  },
  {
    code: 'assigned_source_row',
    pattern: /\b(?:the\s+)?(?:only\s+)?assigned\s+source\s+row\b/iu,
    message: 'reader-facing prose exposes assignment/source-row scaffolding; state the source or evidence directly'
  },
  {
    code: 'this_filing',
    pattern: /\bthis\s+filing\s+(?:does\s+not|doesn['’]t)\s+treat\b[^.]{0,80}\bas\s+proof\b/iu,
    message: 'reader-facing prose refers to the article as a filing; write the reported fact directly'
  },
  {
    code: 'null_case_formula',
    pattern: /\bthe\s+null\s+(?:case|reading)\s+(?:is|has\s+to\s+be|must\s+be|needs\s+to\s+be)\b/iu,
    message: 'reader-facing prose exposes review/scaffolding language around the null case; state the caveat directly'
  }
];

function readerFields(article) {
  const fields = [];
  for (const key of ['headline', 'deck', 'kicker']) if (isText(article?.[key])) fields.push({ path: `article.${key}`, text: article[key] });
  for (const [index, paragraph] of rows(article?.body).entries()) if (isText(paragraph)) fields.push({ path: `article.body[${index}]`, text: paragraph, citedFragments: citedFragments(article, paragraph) });
  if (isText(article?.art?.caption)) fields.push({ path: 'article.art.caption', text: article.art.caption });
  if (isText(article?.art?.title)) fields.push({ path: 'article.art.title', text: article.art.title });
  if (isText(article?.presentation?.flashpoint?.note)) fields.push({ path: 'article.presentation.flashpoint.note', text: article.presentation.flashpoint.note });
  return fields;
}

function citedFragments(article, text) {
  const fragments = [];
  for (const match of text.matchAll(/\[E(\d+)\]/gu)) {
    const fragment = rows(article?.evidence_box)[Number(match[1]) - 1]?.fragment;
    if (isText(fragment)) fragments.push(fragment);
  }
  return fragments;
}

function quoteSpans(text) {
  const spans = [];
  const pairs = { '"': '"', '“': '”' };
  for (let index = 0; index < text.length; index++) {
    const close = pairs[text[index]];
    if (!close) continue;
    const end = text.indexOf(close, index + 1);
    if (end === -1) continue;
    spans.push({ start: index, end: end + 1, quote: text.slice(index + 1, end) });
    index = end;
  }
  return spans;
}

const comparable = (value) => String(value).replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ').trim();

function evidencedQuotedMatch(field, match) {
  const start = match.index;
  const end = start + match[0].length;
  const span = quoteSpans(field.text).find((item) => item.start < start && end < item.end);
  if (!span || !rows(field.citedFragments).length) return false;
  const quote = comparable(span.quote);
  return quote.length > 0 && field.citedFragments.some((fragment) => comparable(fragment).includes(quote));
}

function leakMatch(field, check) {
  const flags = check.pattern.flags.includes('g') ? check.pattern.flags : `${check.pattern.flags}g`;
  const pattern = new RegExp(check.pattern.source, flags);
  for (const match of field.text.matchAll(pattern)) {
    if (!evidencedQuotedMatch(field, match)) return match;
  }
  return undefined;
}

export function proseLeakFindings(article) {
  const findings = [];
  for (const field of readerFields(article)) {
    for (const check of LEAK_PATTERNS) {
      if (!leakMatch(field, check)) continue;
      findings.push({ path: field.path, code: 'prose_leak', message: check.message });
      break;
    }
  }
  return findings;
}
