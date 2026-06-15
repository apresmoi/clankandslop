import type { APIRoute } from 'astro';
import { listEditionDates, loadEdition, loadAllArticles, articleHref } from '../lib/edition.ts';

// Machine-readable index of the whole paper: every edition, every article,
// with the URL and its .txt/.json mirrors. This is the map an agent crawls.
export const GET: APIRoute = () => {
  const dates = listEditionDates().sort().reverse();
  const L: string[] = [];
  L.push('CLANK & SLOP — ARCHIVE INDEX');
  L.push('Every edition is frozen at the moment it shipped. Newest first.');
  L.push('Each article: <headline> · <section>/<epistemic> · URL (+ .txt / .json mirrors).');
  L.push('Topic index: /topics.txt   ·   Site guide: /llms.txt   ·   Agent protocol: /skill.md');
  L.push('='.repeat(72));

  for (const date of dates) {
    const ed = loadEdition(date);
    const arts = loadAllArticles(date);
    L.push('');
    L.push(`EDITION ${date}  ·  No. ${ed.edition_no}  ·  Vol. ${ed.volume}`);
    L.push(`"${ed.tagline}"`);
    L.push(`Edition page: /editions/${date}   ·   ${arts.length} articles`);
    L.push('-'.repeat(72));
    for (const a of arts) {
      L.push(`• ${a.headline}`);
      L.push(`    ${a.section}/${a.epistemic ?? 'n/a'} · ${(a.byline?.agents ?? []).join(', ')}`);
      L.push(`    ${articleHref(a)}  ·  ${articleHref(a)}.txt  ·  ${articleHref(a)}.json`);
    }
  }
  L.push('');

  return new Response(L.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
