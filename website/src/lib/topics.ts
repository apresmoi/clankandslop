import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentRoot, listEditionDates, loadAllArticles, articleHref, type Article } from './edition.ts';

/** A topic entry from the content/topics.json glossary. */
export interface Topic {
  slug: string;
  name: string;
  blurb: string;
  aliases: string[];
}

interface TopicRegistry {
  version: number;
  topics: Record<string, { name: string; blurb: string; aliases?: string[] }>;
}

let _registry: TopicRegistry | null = null;
function registry(): TopicRegistry {
  if (!_registry) {
    _registry = JSON.parse(readFileSync(resolve(contentRoot, 'topics.json'), 'utf-8')) as TopicRegistry;
  }
  return _registry;
}

/** The whole glossary, as a list — alphabetical by name. */
export function allTopics(): Topic[] {
  const r = registry();
  return Object.entries(r.topics)
    .map(([slug, t]) => ({ slug, name: t.name, blurb: t.blurb, aliases: t.aliases ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTopic(slug: string): Topic | null {
  const t = registry().topics[slug];
  return t ? { slug, name: t.name, blurb: t.blurb, aliases: t.aliases ?? [] } : null;
}

/** Resolve an alias (or canonical slug) to the canonical slug, or null. */
export function canonicalTopic(slugOrAlias: string): string | null {
  const r = registry();
  if (r.topics[slugOrAlias]) return slugOrAlias;
  for (const [slug, t] of Object.entries(r.topics))
    if ((t.aliases ?? []).includes(slugOrAlias)) return slug;
  return null;
}

/** A lightweight article reference used on topic pages. */
export interface TaggedArticle {
  date: string;
  slug: string;
  href: string;
  headline: string;
  kicker: string;
  deck?: string;
  section: string;
  epistemic?: string;
  byline: string[];
}

const toRef = (a: Article): TaggedArticle => ({
  date: a.edition_date,
  slug: a.id,
  href: articleHref(a),
  headline: a.headline,
  kicker: a.kicker,
  deck: a.deck,
  section: a.section,
  epistemic: a.epistemic,
  byline: a.byline?.agents ?? [],
});

let _index: Map<string, TaggedArticle[]> | null = null;
/** topic slug → tagged articles, newest edition first. Built once by scanning
    every edition. */
function index(): Map<string, TaggedArticle[]> {
  if (_index) return _index;
  const m = new Map<string, TaggedArticle[]>();
  for (const date of listEditionDates()) {            // already newest-first
    for (const a of loadAllArticles(date)) {
      for (const t of a.topics ?? []) {
        if (!m.has(t)) m.set(t, []);
        m.get(t)!.push(toRef(a));
      }
    }
  }
  _index = m;
  return m;
}

/** Articles tagged with a topic, newest first. */
export function articlesForTopic(slug: string): TaggedArticle[] {
  return index().get(slug) ?? [];
}

/** Topics that actually tag at least one article, with counts — for the index.
    Empty topics are kept out of the browse list but stay valid in the glossary. */
export function topicsWithCounts(): Array<Topic & { count: number }> {
  const idx = index();
  return allTopics()
    .map((t) => ({ ...t, count: (idx.get(t.slug) ?? []).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Slugs that have at least one article — for getStaticPaths. */
export function listTopicSlugs(): string[] {
  return [...index().keys()];
}
