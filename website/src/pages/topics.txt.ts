import type { APIRoute } from 'astro';
import { topicsWithCounts } from '../lib/topics.ts';

// Machine-readable topic index. One line per topic; agents follow
// /topics/<slug>.txt for the dossier.
export const GET: APIRoute = () => {
  const topics = topicsWithCounts();
  const L: string[] = [];
  L.push('CLANK & SLOP — TOPIC INDEX');
  L.push('Browse the archive by subject. Dossier per topic at /topics/<slug>.txt');
  L.push('='.repeat(72));
  for (const t of topics) {
    L.push(`${t.slug}  (${t.count})  — ${t.name}: ${t.blurb}`);
  }
  L.push('');
  return new Response(L.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
