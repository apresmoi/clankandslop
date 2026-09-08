import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hasClass = (tag, className) => (tag.match(/\bclass="([^"]*)"/u)?.[1] ?? '').split(/\s+/u).includes(className);
const tagWithClass = (html, name, className) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gu'))].find(match => hasClass(match[0], className))?.[0] ?? '';
const stripTags = (value) => value.replace(/<[^>]+>/gu, '').replace(/&nbsp;/gu, ' ').trim();
const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const plain = value => stripTags(value).replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&(amp|lt|gt|quot|apos);/gu, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]).replace(/\s+/gu, ' ').trim();
const classTexts = (html, element, className) => [...html.matchAll(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}>`, 'gu'))].filter(match => hasClass(match[0].slice(0, match[0].indexOf('>') + 1), className)).map(match => plain(match[0]));

export function renderedMapGlyphFindings(html, label = 'built front HTML', { props, containerClass = 'hero-art-map' } = {}) {
  const findings = [];
  const leadTag = tagWithClass(html, 'div', containerClass);
  const leadStart = leadTag ? html.indexOf(leadTag) : -1;
  if (leadStart < 0) return [`${label}: missing lead Hero MapGlyph art (${containerClass})`];
  const following = html.slice(leadStart), nextLeadTag = tagWithClass(following, 'div', 'hero-lead');
  const nextLead = nextLeadTag ? following.indexOf(nextLeadTag) : -1;
  const area = nextLead < 0 ? html.slice(leadStart) : html.slice(leadStart, leadStart + nextLead);
  const figureEnd = area.indexOf('</figure>');
  const lead = figureEnd < 0 ? area : area.slice(0, figureEnd + 9);
  const figureTag = tagWithClass(lead, 'figure', 'mapglyph');
  if (!figureTag || !hasClass(figureTag, 'is-print')) findings.push(`${label}: missing print MapGlyph terrain in lead art`);
  const printTag = tagWithClass(lead, 'div', 'mapglyph-print');
  const printPre = lead.match(/class="[^"]*\bmapglyph-print\b[\s\S]*?<pre\b[^>]*>([\s\S]*?)<\/pre>/u)?.[1] ?? '';
  if (!printTag || !stripTags(printPre)) findings.push(`${label}: missing nonempty print MapGlyph terrain in lead art`);
  const labels = classTexts(lead, 'span', 'mg-label');
  if (!labels.length || labels.some(value => !value)) findings.push(`${label}: missing named MapGlyph place labels`);
  const captions = classTexts(lead, 'figcaption', 'mapglyph-caption');
  if (!captions.some(Boolean)) findings.push(`${label}: missing MapGlyph caption`);
  if (props) {
    const expectedLabels = (props.spots ?? []).map(spot => plain(spot.name)).sort();
    if (JSON.stringify([...labels].sort()) !== JSON.stringify(expectedLabels)) findings.push(`${label}: rendered place labels differ from composition spots`);
    if (!captions.includes(plain(props.caption ?? ''))) findings.push(`${label}: rendered caption differs from composition caption`);
    if (props.title && !classTexts(lead, 'span', 'mapglyph-title').includes(plain(props.title))) findings.push(`${label}: rendered map title differs from composition title`);
    for (const [field, prefix] of [['routes', 'r'], ['overlays', 'o']]) {
      for (const item of props[field] ?? []) {
        if (!plain(lead.match(/class="[^"]*\bmapglyph-legend\b[\s\S]*?<\/div>/u)?.[0] ?? '').includes(plain(item.name))) findings.push(`${label}: missing rendered map key entry ${item.name}`);
        if (!tagWithClass(printPre, 'span', `mg-${prefix}-${item.color ?? (field === 'routes' ? 'accent' : 'red')}`)) findings.push(`${label}: missing rendered ${field} ink`);
      }
    }
  }
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
