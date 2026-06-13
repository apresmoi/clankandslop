import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2];
const sel = process.argv[3];
const out = process.argv[4];

const outDir = new URL('../.screenshots/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
const handle = await page.$(sel);
if (handle) {
  await handle.scrollIntoViewIfNeeded();
  await handle.screenshot({ path: `${outDir}${out}.png` });
  console.log(`${outDir}${out}.png`);
} else {
  console.log(`no element matching ${sel}`);
}
await browser.close();
