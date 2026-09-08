import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hasClass = (tag, className) => (tag.match(/\bclass="([^"]*)"/u)?.[1] ?? '').split(/\s+/u).includes(className);
const tagWithClass = (html, name, className) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gu'))].find(match => hasClass(match[0], className))?.[0] ?? '';
const stripTags = (value) => value.replace(/<[^>]+>/gu, '').replace(/&nbsp;/gu, ' ').trim();
const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };

export function renderedMapGlyphFindings(html, label = 'built front HTML') {
  const findings = [];
  const leadTag = tagWithClass(html, 'div', 'hero-art-map');
  const leadStart = leadTag ? html.indexOf(leadTag) : -1;
  if (leadStart < 0) return [`${label}: missing lead Hero MapGlyph art`];
  const following = html.slice(leadStart), nextLeadTag = tagWithClass(following, 'div', 'hero-lead');
  const nextLead = nextLeadTag ? following.indexOf(nextLeadTag) : -1;
  const lead = nextLead < 0 ? html.slice(leadStart) : html.slice(leadStart, leadStart + nextLead);
  const figureTag = tagWithClass(lead, 'figure', 'mapglyph');
  if (!figureTag || !hasClass(figureTag, 'is-print')) findings.push(`${label}: missing print MapGlyph terrain in lead art`);
  const printTag = tagWithClass(lead, 'div', 'mapglyph-print');
  const printPre = lead.match(/class="[^"]*\bmapglyph-print\b[\s\S]*?<pre\b[^>]*>([\s\S]*?)<\/pre>/u)?.[1] ?? '';
  if (!printTag || !stripTags(printPre)) findings.push(`${label}: missing nonempty print MapGlyph terrain in lead art`);
  const locatorTag = tagWithClass(lead, 'div', 'mapglyph-locator');
  const locatorPre = lead.match(/class="[^"]*\bmapglyph-locator\b[\s\S]*?<pre\b[^>]*>([\s\S]*?)<\/pre>/u)?.[1] ?? '';
  if (!locatorTag || !stripTags(locatorPre)) findings.push(`${label}: missing nonempty MapGlyph locator minimap in lead art`);
  const footprint = lead.match(/class="[^"]*\blocator-footprint\b[^"]*"[^>]*style="([^"]*)"/u)?.[1] ?? '';
  if (!footprint) findings.push(`${label}: missing lead locator footprint`);
  else {
    const width = number(footprint.match(/width:\s*([0-9.]+)%/u)?.[1]);
    const height = number(footprint.match(/height:\s*([0-9.]+)%/u)?.[1]);
    if (width <= 0 || height <= 0) findings.push(`${label}: lead locator footprint must have positive width and height`);
  }
  return findings;
}

export function verifyRenderedMapGlyph(file) {
  const target = resolve(file);
  const stat = statSync(target);
  if (!stat.isFile()) return { file: target, findings: [`${target}: expected one built front HTML file`] };
  return { file: target, findings: renderedMapGlyphFindings(readFileSync(target, 'utf8'), target) };
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node ops/rendered-mapglyph.mjs <built-front.html>');
    process.exit(2);
  }
  const result = verifyRenderedMapGlyph(target);
  if (result.findings.length > 0) {
    console.error(`rendered mapglyph validation failed — ${result.findings.length} error(s):`);
    for (const finding of result.findings) console.error(`  ✗ ${finding}`);
    process.exit(1);
  }
  console.log(`rendered mapglyph OK — ${result.file}`);
}
