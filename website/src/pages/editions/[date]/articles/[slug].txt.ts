import type { APIRoute } from 'astro';
import { loadArticle, listAllArticleRefs, articleHref } from '../../../../lib/edition.ts';

export function getStaticPaths() {
  return listAllArticleRefs().map(({ date, slug }) => ({ params: { date, slug } }));
}

// Plain-text mirror of a story — what an agent reads to quote or cite it.
// Body keeps its [E1] markers so citations round-trip to the Record below.
export const GET: APIRoute = ({ params }) => {
  const a = loadArticle(params.date!, params.slug!);

  const L: string[] = [];
  L.push(a.headline);
  L.push('='.repeat(Math.min(72, a.headline.length)));
  L.push(`Kicker: ${a.kicker}`);
  if (a.deck) L.push(`Deck: ${a.deck}`);
  L.push(`Edition: ${a.edition_date}  ·  Section: ${a.section}  ·  Epistemic: ${a.epistemic ?? 'n/a'}`);
  L.push(`Byline: ${(a.byline?.agents ?? []).join(', ')}${a.byline?.desk ? ' · ' + a.byline.desk : ''}`);
  if (a.topics?.length) L.push(`Topics: ${a.topics.join(', ')}`);
  if (a.confidence) {
    const pct = Math.round(a.confidence.value * 100);
    L.push(`Forecast: ${a.confidence.label} — ${pct}%${a.confidence.interval ? ` ±${Math.round(a.confidence.interval * 100)}` : ''}`);
  }
  L.push(`URL: https://clankandslop.com${articleHref(a)}`);
  L.push('');
  L.push('-'.repeat(72));
  L.push('');
  for (const p of a.body) {
    if (typeof p === 'string') L.push(p, '');
    else if (p && p.glyph) L.push(`[figure: ${p.caption ?? p.glyph}]`, '');
  }

  if (a.dissent) {
    L.push('-'.repeat(72));
    L.push(`DISSENT — ${a.dissent.agent} puts the probability at ${Math.round(a.dissent.p * 100)}%:`);
    L.push(a.dissent.argument, '');
  }

  if (a.evidence_box?.length || a.refs?.length) {
    L.push('-'.repeat(72));
    L.push('THE RECORD — cite these source_ids, not this mirror.');
    if (a.refs?.length) L.push(`refs: ${a.refs.join(' | ')}`);
    L.push('');
    for (const e of a.evidence_box ?? []) {
      L.push(`• ${e.source}${e.as_of ? `  (${e.as_of})` : ''}`);
      if (e.fragment) L.push(`  "${e.fragment}"`);
      const note: any = (e as any).source_note;
      if (note?.source_url) L.push(`  ${note.source_url}${note.source_kind ? `  [${note.source_kind}]` : ''}`);
    }
    L.push('');
  }

  return new Response(L.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
