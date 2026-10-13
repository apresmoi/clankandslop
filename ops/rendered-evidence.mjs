import { excerptFurniture } from './excerpt-furniture.mjs';

const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (_, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(Number.parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()];
});
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const renderedText = text => text.replace(/\s+/gu, ' ').trim();

export function renderedEvidenceFields(html) {
  const stack = [], fields = [];
  for (const token of String(html).matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b([^>]*)>|([^<]+)/giu)) {
    if (token[0].startsWith('<!--')) continue;
    if (token[3]) {
      for (const frame of stack) if (frame.field) frame.text += decode(token[3]);
      continue;
    }
    const tag = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      const index = stack.findLastIndex(frame => frame.tag === tag);
      if (index >= 0) for (const frame of stack.splice(index)) if (frame.field) fields.push({ field: frame.field, text: renderedText(frame.text) });
      continue;
    }
    if (tag === 'br') for (const frame of stack) if (frame.field) frame.text += '\n';
    const classes = (token[2].match(/\bclass\s*=\s*["']([^"']*)["']/iu)?.[1] ?? '').split(/\s+/u);
    const inRecord = classes.includes('evidence-row') || stack.some(frame => frame.record);
    const field = inRecord ? classes.includes('frag') ? 'fragment' : classes.includes('excerpt') ? 'raw_excerpt' : null : null;
    if (!VOID.has(tag)) stack.push({ tag, record: inRecord, field, text: '' });
  }
  for (const frame of stack) if (frame.field) fields.push({ field: frame.field, text: renderedText(frame.text) });
  return fields;
}

export function renderedEvidenceFindings(html, { fragments, excerpts } = {}) {
  const fields = renderedEvidenceFields(html);
  const findings = fields.flatMap(({ field, text }, i) => excerptFurniture(text).map(marker => `${field}[${i}] contains ${marker.kind}: ${marker.text}`));
  for (const [field, expected] of [['fragment', fragments], ['raw_excerpt', excerpts]]) {
    if (expected !== undefined && fields.filter(f => f.field === field && f.text).length !== expected) findings.push(`Rendered ${field} count differs from evidence record: expected ${expected}`);
  }
  return findings;
}
