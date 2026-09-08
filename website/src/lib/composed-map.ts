import type { Article } from './edition.ts';
import { loadPage, type Page } from './page.ts';

type MapArt = Extract<NonNullable<Article['art']>, { kind: 'map' }>;

export function composedLeadMap(page: Page, slug: string): MapArt | null {
  const hero = page.head.find(block => block.block === 'Hero' && block.props?.lead === slug);
  const art = hero?.props?.art as { block?: string; props?: Record<string, unknown> } | undefined;
  if (art?.block !== 'MapGlyph' || typeof art.props?.map !== 'string') return null;
  const fields = ['map', 'title', 'caption', 'spots', 'routes', 'overlays', 'tone', 'locator_context', 'rule'];
  return { kind: 'map', ...Object.fromEntries(fields.filter(key => art.props?.[key] !== undefined).map(key => [key, structuredClone(art.props![key])])) } as MapArt;
}

export function loadArticleMapArt(date: string, article: Article): MapArt | null {
  if (article.art) return article.art.kind === 'map' ? article.art : null;
  // The approved composition owns its illustration; reporter bytes remain untouched.
  try { return composedLeadMap(loadPage(date, 'front'), article.id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
