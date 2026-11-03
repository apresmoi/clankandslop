import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Text sizes are rem (so the reader's browser setting applies) and never under
// 12px. Only ASCII rasters keep px: they are pictures sized to their grid.
const ART = /\.org-map|\.ascii-art\b|mapglyph-locator|mapglyph-host|mapglyph-print pre|worldglyph-host|gimg-art|glyphart-pre|calc\(|cq[iwh]/;
const src = new URL('..', import.meta.url).pathname;
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (!p.endsWith('pages/og')) walk(p); } else if (/\.(css|astro)$/.test(f)) files.push(p);
  }
};
walk(src);

test('text font sizes are rem and at least 12px', () => {
  const bad: string[] = [];
  for (const f of files) {
    let sel = '';
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\{\s*$/.test(line)) sel = line;
      for (const [, val] of line.matchAll(/font(?:-size)?\s*:\s*([^;"}]*)/g)) {
        if (ART.test(sel) || ART.test(line)) continue;
        const where = `${f.slice(src.length)}:${i + 1} ${val.trim()}`;
        if (/\d(\.\d+)?px/.test(val)) bad.push(`px: ${where}`);
        for (const [, n] of val.matchAll(/(\d*\.?\d+)rem/g)) if (+n < 0.75) bad.push(`under 12px: ${where}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});
