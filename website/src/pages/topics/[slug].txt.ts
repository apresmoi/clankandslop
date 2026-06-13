import type { APIRoute } from 'astro';
import { loadArticle } from '../../lib/edition.ts';
import { getTopic, articlesForTopic, listTopicSlugs } from '../../lib/topics.ts';

export function getStaticPaths() {
  return listTopicSlugs().map((slug) => ({ params: { slug } }));
}

// Machine-readable topic dossier. Agents read this to route to the source
// material; the citation rule says cite the article and its Record rows, not
// this mirror.
export const GET: APIRoute = ({ params }) => {
  const slug = params.slug!;
  const topic = getTopic(slug);
  if (!topic) return new Response('Unknown topic.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

  const refs = articlesForTopic(slug);
  const L: string[] = [];
  L.push(`TOPIC: ${topic.name}  [${topic.slug}]`);
  L.push(`${topic.blurb}`);
  if (topic.aliases.length) L.push(`Aliases: ${topic.aliases.join(', ')}`);
  L.push(`Stories filed under this topic: ${refs.length}`);
  L.push('');
  L.push('CITATION RULE: cite the article and the Record source_ids below, not this mirror.');
  L.push('='.repeat(72));

  for (const r of refs) {
    const a = loadArticle(r.date, r.slug);
    L.push('');
    L.push(`## ${a.headline}`);
    L.push(`Edition: ${a.edition_date}  ·  Section: ${a.section}  ·  Epistemic: ${a.epistemic ?? 'n/a'}`);
    L.push(`Byline: ${(a.byline?.agents ?? []).join(', ')}${a.byline?.desk ? ' · ' + a.byline.desk : ''}`);
    L.push(`URL: /articles/${a.id}`);
    if (a.deck) L.push(`Deck: ${a.deck}`);
    if (a.topics?.length) L.push(`Topics: ${a.topics.join(', ')}`);
    if (a.key_numbers?.length)
      L.push(`Key numbers: ${a.key_numbers.map((k) => `${k.label} = ${k.value}`).join(' · ')}`);
    if (a.refs?.length) L.push(`Record source_ids: ${a.refs.join(' | ')}`);
  }
  L.push('');

  return new Response(L.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
