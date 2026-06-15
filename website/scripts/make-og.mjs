// Render each article's social card (/og/<date>/<slug> route) to a committed PNG
// at public/og/<date>/<slug>.png, 1200×630. Uses headless Chromium so the cards
// get the real paper fonts and glyph art — but it runs LOCALLY when an edition
// is composed, and the PNGs are committed, so CI never needs a browser.
//
// Renders cards for EVERY edition (articles are edition-scoped), so archived
// editions keep working cards. Needs a server serving the /og/<date>/<slug>
// routes — point it at the dev server (or `astro preview`) via BASE, default
// http://localhost:4321.
//   node scripts/make-og.mjs
import { chromium } from 'playwright';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:4321';
const OUT = resolve(here, '..', 'public', 'og');
mkdirSync(OUT, { recursive: true });

// Every (date, slug) pair across all editions (matches the article + og routes).
const editionsDir = resolve(here, '..', '..', 'content', 'editions');
const dates = readdirSync(editionsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const refs = dates.flatMap((date) =>
  readdirSync(resolve(editionsDir, date, 'articles'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ date, slug: f.replace(/\.json$/, '') })),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

let ok = 0;
for (const { date, slug } of refs) {
  const resp = await page.goto(`${BASE}/og/${date}/${slug}`, { waitUntil: 'networkidle' });
  if (!resp || resp.status() !== 200) { console.warn(`  skip ${date}/${slug} (status ${resp?.status()})`); continue; }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const card = await page.locator('.og-card');
  mkdirSync(resolve(OUT, date), { recursive: true });
  writeFileSync(resolve(OUT, date, `${slug}.png`), await card.screenshot());
  ok++;
  console.log(`  og/${date}/${slug}.png`);
}
// Default site card (front page + non-article pages).
const dResp = await page.goto(`${BASE}/og/site`, { waitUntil: 'networkidle' });
if (dResp && dResp.status() === 200) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  writeFileSync(resolve(OUT, 'default.png'), await page.locator('.og-card').screenshot());
  console.log('  og/default.png');
}

await browser.close();
console.log(`\n${ok}/${refs.length} article cards + default → public/og/`);
