import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { layEdition, personaNames, readEditionInputs } from './lay-page.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const agents = personaNames();
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// The editions with a real front and tape on the branch. 2026-09-05 is the
// hand-rescued edition the composition study measured; the four August ones are
// the orchestrator's own and are the quality target.
export const EDITIONS = ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-09-05'];

// Glyphs for the two illustrated slots on a day whose articles carry no `art`
// at all. That page shipped a MapGlyph naming a map no article declares as
// `art.hero_map`, which the maps gate refuses — so the assembler cannot
// reproduce it and the record supplies a fitting glyph instead. 2026-09-05 was
// the same shape until its two illustrated stories were given the archived
// regions their own geography sits inside, which is why it is no longer here.
const SUBSTITUTE_GLYPHS = {
  '2026-08-22': {
    'panama-canal-cuts-daily-slots-to-thirty-four': { shape: 'pumpjack', caption: 'Gatún Lake feeds the locks. A-29-2026 cuts bookable slots from 4 September.' },
    'lima-transportistas-hold-the-twenty-fifth': { shape: 'colosseum', caption: 'Lima and Callao. The convocantes were not in the Saturday Mininter room.' },
  },
};

/**
 * The decision record a shipped edition implies, read back off its own pages:
 * the placement order, the flashpoint list, the two Brieflys and the tape's
 * numbers. Everything the assembler derives is deliberately not read.
 */
export function decisionsFromShipped(date) {
  const dir = resolve(repo, 'content/editions', date);
  const front = readJson(resolve(dir, 'pages/front.json'));
  const tape = readJson(resolve(dir, 'pages/tape.json'));
  const articles = readEditionInputs(resolve(repo, 'content'), date).articles;
  const order = [];
  const artFor = {};
  const walk = (blocks) => {
    for (const block of blocks) {
      if (block.block === 'Hero') order.push(block.props.lead);
      else if (block.block === 'Teaser') order.push(block.props.article);
      else if (block.block === 'Grid') {
        const flat = block.props.columns.flat();
        const art = flat.find((b) => b.block === 'MapGlyph' || b.block === 'GlyphArt');
        const story = flat.find((b) => b.block === 'Teaser');
        if (art && story) artFor[story.props.article] = art;
        for (const column of block.props.columns) walk(column);
      }
    }
  };
  walk(front.head);
  const art = {};
  for (const [slug, block] of Object.entries(artFor)) {
    if (SUBSTITUTE_GLYPHS[date]?.[slug]) art[slug] = SUBSTITUTE_GLYPHS[date][slug];
    else if (block.block === 'GlyphArt') art[slug] = { ...block.props };
    else if (articles[slug]?.art) art[slug] = { caption: block.props.caption };
  }
  const worldRow = front.head.find((b) => b.block === 'Grid' && b.props.columns?.[0]?.[0]?.block === 'WorldGlyph');
  const items = worldRow?.props.columns[1][0].props.items ?? [];
  const spots = Object.fromEntries((worldRow?.props.columns[0][0].props.hotspots ?? []).map((h) => [h.name, h]));
  const findBlock = (name) => {
    let hit = null;
    const walkTape = (blocks) => { for (const b of blocks) { if (b.block === name) hit = b; if (b.block === 'Grid') for (const c of b.props.columns) walkTape(c); } };
    walkTape(tape.head);
    return hit;
  };
  const rail = findBlock('MarketsRail');
  const watch = findBlock('WhatToWatch');
  return {
    edition: date,
    order,
    ...(Object.keys(art).length > 0 ? { art } : {}),
    flashpoints: items.map((it) => ({ place: it.place, lat: spots[it.place]?.lat ?? 0, lon: spots[it.place]?.lon ?? 0, note: it.note, ...(it.article ? { article: it.article } : { agent: it.agent }) })),
    briefly: front.flow.find((b) => b.block === 'Briefly').props.desks,
    tape: {
      briefly: tape.head.find((b) => b.block === 'Briefly').props.desks,
      ...(rail ? { markets: { kicker: rail.props.kicker, rows: rail.props.rows } } : {}),
      ...(watch ? { watch: watch.props.items } : {}),
    },
  };
}

export const layShipped = (date) => layEdition({ edition: date, ...readEditionInputs(resolve(repo, 'content'), date), decisions: decisionsFromShipped(date), agents });
