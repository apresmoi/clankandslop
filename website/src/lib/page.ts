import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { scopeDir } from './edition.ts';

/**
 * A Block is the unit of page composition. `block` is the canonical
 * component name; `props` is the data the renderer hands to the component.
 *
 * Article references are slugs (strings). The renderer hydrates them
 * before dispatching to the block component.
 */
export interface Block {
  block: string;
  props?: Record<string, unknown>;
}

export interface Page {
  edition: string;
  page: string;

  // Chrome — most fields nullable, derived from edition.json when null.
  title: string;
  active: string;
  tagline?: string | null;
  // Composition — two slots.
  head: Block[];
  flow: Block[];
}

/** Load a page JSON file for a given edition. */
export function loadPage(date: string, page: string): Page {
  const path = resolve(scopeDir(date), 'pages', `${page}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Page;
}

/** List all page names in an edition (without .json extension). */
export function listPageNames(date: string): string[] {
  const dir = resolve(scopeDir(date), 'pages');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/** List only the "layout-*" demonstration pages. */
export function listLayoutNames(date: string): string[] {
  return listPageNames(date).filter((n) => n.startsWith('layout-'));
}
