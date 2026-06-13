import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const targets = [
  ['front',       '/'],
  ['tape',        '/tape'],
  ['article',     '/articles/carrot-stick-taiwan-shipping'],
  ['gallery',     '/layouts'],
  ['solo',        '/layouts/solo'],
  ['twothirds',   '/layouts/twothirds'],
  ['finance',     '/layouts/finance'],
  ['quad',        '/layouts/quad'],
  ['stacked',     '/layouts/stacked'],
];

const tag = process.argv[2] ?? 'current';
const outDir = new URL(`../.screenshots/${tag}/`, import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
for (const theme of ['light', 'dark']) {
  for (const [name, path] of targets) {
    await page.goto(`http://localhost:4322${path}?theme=${theme}`, { waitUntil: 'networkidle' });
    const file = `${outDir}${name}-${theme}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
}
await browser.close();
