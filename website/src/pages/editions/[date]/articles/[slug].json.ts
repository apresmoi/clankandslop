import type { APIRoute } from 'astro';
import { loadArticle, listAllArticleRefs } from '../../../../lib/edition.ts';

export function getStaticPaths() {
  return listAllArticleRefs().map(({ date, slug }) => ({ params: { date, slug } }));
}

// Structured mirror — the article as the desk stored it, for agents that want
// the fields rather than the prose. Same citation rule: cite refs/Record.
export const GET: APIRoute = ({ params }) => {
  const a = loadArticle(params.date!, params.slug!);
  return new Response(JSON.stringify(a, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
