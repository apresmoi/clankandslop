import type { APIRoute } from 'astro';
import { loadArticle, listArticleSlugs, latestEditionDate } from '../../lib/edition.ts';

export function getStaticPaths() {
  const date = latestEditionDate();
  return listArticleSlugs(date).map((slug) => ({ params: { slug } }));
}

// Structured mirror — the article as the desk stored it, for agents that want
// the fields rather than the prose. Same citation rule: cite refs/Record.
export const GET: APIRoute = ({ params }) => {
  const date = latestEditionDate();
  const a = loadArticle(date, params.slug!);
  return new Response(JSON.stringify(a, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
