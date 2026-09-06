// Run from `website/`: `npm run test:lib` (node --test, type stripping, no
// bundler). ci.yml runs the same command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { articleOgPath, listAllArticleRefs, ogRoot } from './edition.ts';

// One date that genuinely has committed cards, and one file inside it. Read
// from disk rather than hardcoded, so rendering more cards never turns this red.
function aRenderedCard(): { date: string; slug: string } {
  for (const date of readdirSync(ogRoot).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    const card = readdirSync(resolve(ogRoot, date)).find((name) => name.endsWith('.png'));
    if (card) return { date, slug: card.slice(0, -'.png'.length) };
  }
  throw new Error('no committed social cards at all — this test needs at least one');
}

test('an og:image is advertised only when the card was actually rendered', () => {
  const { date, slug } = aRenderedCard();
  assert.equal(articleOgPath(date, slug), `/og/${date}/${slug}.png`);
  // The three shapes of absence: no such card, no such edition, no such slug.
  assert.equal(articleOgPath(date, 'a-story-nobody-ever-rendered-a-card-for'), undefined);
  assert.equal(articleOgPath('1999-01-01', slug), undefined);
});

test('no article on the site can advertise a card that is not on disk', () => {
  const refs = listAllArticleRefs();
  assert.ok(refs.length > 0, 'the site has no articles to check');
  let missing = 0;
  for (const { date, slug } of refs) {
    const advertised = articleOgPath(date, slug);
    if (advertised === undefined) { missing += 1; continue; }
    assert.ok(existsSync(resolve(ogRoot, date, `${slug}.png`)), `${advertised} is advertised but not on disk`);
  }
  // Without this the test above passes vacuously the day every card exists —
  // and passes vacuously TODAY if the existence check is deleted, which is the
  // regression it is here to catch. 15 of the 71 editions have no cards.
  assert.ok(missing > 0, 'every article has a card: this fixture can no longer prove a missing one falls back');
});
