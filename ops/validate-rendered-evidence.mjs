import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderedEvidenceFindings } from './rendered-evidence.mjs';

// The gate applies prospectively; explicit release checks remain strict for any date.
export const RENDERED_EVIDENCE_EPOCH = '2026-10-14';

export function validateRenderedEvidence(root, edition) {
  const editions = resolve(root, 'content/editions');
  const date = edition ?? readdirSync(editions).filter(d => /^\d{4}-\d{2}-\d{2}$/u.test(d)).sort().at(-1);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) throw new Error('A rendered edition is required');
  if (edition === undefined && date < RENDERED_EVIDENCE_EPOCH) return `OK — rendered evidence: frozen archive through ${date}; no new publication checked`;
  const articles = resolve(editions, date, 'articles');
  let checked = 0;
  for (const file of readdirSync(articles).filter(f => f.endsWith('.json'))) {
    const article = JSON.parse(readFileSync(resolve(articles, file), 'utf8'));
    const rows = article.evidence_box ?? [];
    const rendered = resolve(root, 'website/dist/editions', date, 'articles', file.slice(0, -5), 'index.html');
    const findings = renderedEvidenceFindings(readFileSync(rendered, 'utf8'), { fragments: rows.length, excerpts: rows.filter(r => r.source_note?.raw_excerpt).length });
    if (findings.length) throw new Error(`${rendered}: ${findings.join('; ')}`);
    checked += 1;
  }
  for (const file of ['index.html', `editions/${date}/index.html`, 'tape/index.html', `editions/${date}/tape/index.html`, 'method/index.html']) {
    const rendered = resolve(root, 'website/dist', file);
    if (!existsSync(rendered)) throw new Error(`Missing rendered publication: ${file}`);
    const findings = renderedEvidenceFindings(readFileSync(rendered, 'utf8'));
    if (findings.length) throw new Error(`${rendered}: ${findings.join('; ')}`);
  }
  return `OK — rendered evidence: ${date}, ${checked} articles`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(validateRenderedEvidence(resolve(import.meta.dirname, '..'), process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
