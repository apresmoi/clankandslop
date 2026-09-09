// Browser-side proof that the WorldGlyph globe actually renders — the thing a
// build cannot tell you. glyphcss silently draws a one-character globe when the
// camera is fed pre-0.1 units, so "it compiled" and "it rendered" are different
// claims and only this script makes the second one.
//
// Real headless Chromium, real font metrics (glyphcss's zoom is now absolute
// CSS pixels, so the character cell it measures is part of the geometry).
// Asserts, on the live front page:
//   - the <pre> is a filled disc, not a dot
//   - land ink and ocean tint are both present (the glyph ramp is lighting-only,
//     so colour is the ONLY thing separating land from sea)
//   - the numbered hotspot markers are placed
//   - markers on the far side of the sphere are hidden, and which ones are
//     hidden tracks the camera angle
//   - the idle spin re-rasterizes
//
// Needs a server for the built site:
//   npm run build && npx astro preview &
//   node scripts/verify-glyph-scenes.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4321';
const PATH = process.env.GLYPH_PATH || '/';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// Same projection depth WorldGlyph culls on, recomputed here from the config so
// the assertion is independent of the component's own arithmetic.
function camDepth(lat, lon, rotXRad, rotYRad) {
  const D = Math.PI / 180;
  const cl = Math.cos(lat * D);
  const x = cl * Math.cos(lon * D), y = cl * Math.sin(lon * D), z = Math.sin(lat * D);
  const i = Math.sin(rotYRad) * y + Math.cos(rotYRad) * x;
  return Math.sin(rotXRad) * i + Math.cos(rotXRad) * z;
}

const readGlobe = () => {
  const host = document.querySelector('[data-worldglyph]');
  const pre = host?.querySelector('pre.glyph-output');
  const text = pre?.textContent ?? '';
  const colors = [...new Set([...(pre?.innerHTML ?? '').matchAll(/color:\s*([^"';]+)/g)].map((m) => m[1].trim().toLowerCase()))];
  const spots = [...(host?.querySelectorAll('.worldglyph-spot') ?? [])].map((el) => {
    const cs = getComputedStyle(el);
    return {
      label: el.textContent ?? '',
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5,
    };
  });
  return {
    config: JSON.parse(host?.dataset.config ?? '{}'),
    text,
    ink: text.replace(/\s/g, '').length,
    filledRows: text.split('\n').filter((l) => l.trim()).length,
    colors,
    spots,
  };
};

/** Re-init the globe with a patched config. The component re-inits every host
    on a `data-theme` mutation, which is the only public handle into it. */
const reinit = ([patch, theme]) => {
  const host = document.querySelector('[data-worldglyph]');
  host.dataset.config = JSON.stringify({ ...JSON.parse(host.dataset.config), ...patch });
  document.documentElement.setAttribute('data-theme', theme);
};

const browser = await chromium.launch();
try {
  // Reduced motion switches the idle spin off, so the camera holds still while
  // the marker-culling assertions read it.
  const page = await browser.newContext({ reducedMotion: 'reduce' }).then((c) => c.newPage());
  await page.goto(`${BASE}${PATH}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-worldglyph] pre.glyph-output')?.textContent ?? '';
    return t.replace(/\s/g, '').length > 0;
  }, null, { timeout: 15000 }).catch(() => {});

  const g = await page.evaluate(readGlobe);
  const { cols, rows } = g.config;

  check(g.ink > cols * rows * 0.2, `globe drew ${g.ink} non-blank cells in a ${cols}x${rows} grid — expected a filled disc`);
  check(g.filledRows >= rows - 2, `globe filled ${g.filledRows} of ${rows} rows`);

  const land = g.colors.filter((c) => c.startsWith('#') && parseInt(c.slice(1, 3), 16) < 0x60);
  const ocean = g.colors.filter((c) => c.startsWith('#') && parseInt(c.slice(1, 3), 16) > 0x90);
  check(land.length > 0, 'no land-ink colours in the globe output');
  check(ocean.length > 0, 'no ocean colours in the globe output');

  const hotspots = g.config.hotspots ?? [];
  check(g.spots.length === hotspots.length, `${g.spots.length} markers rendered, ${hotspots.length} configured`);
  check(g.spots.every((s, i) => s.label.startsWith('①②③④⑤⑥⑦⑧⑨'[i] ?? '◉')),
    `markers lost their numbering: ${g.spots.map((s) => s.label.slice(0, 3)).join(' ')}`);

  // Far-side culling, at two camera angles half a turn apart. A marker may be
  // hidden for being off-screen too, so the assertion is one-directional:
  // nothing on the back of the sphere may be visible.
  const angles = [g.config.rotY, g.config.rotY + Math.PI];
  const visibleSets = [];
  for (const [i, rotY] of angles.entries()) {
    await page.evaluate(reinit, [{ rotY }, i % 2 ? 'dark' : 'light']);
    await page.waitForTimeout(300);
    const s = await page.evaluate(readGlobe);
    const shown = s.spots.map((sp, k) => ({ ...sp, ...hotspots[k] })).filter((sp) => sp.visible);
    visibleSets.push(shown.map((sp) => sp.name).sort().join(','));

    check(s.ink > cols * rows * 0.2, `globe collapsed after re-init at rotY=${rotY.toFixed(2)} (${s.ink} cells)`);
    for (const sp of shown) {
      const d = camDepth(sp.lat, sp.lon, g.config.rotX, rotY);
      check(d > 0, `${sp.name} is visible but sits on the far side (depth ${d.toFixed(3)}) at rotY=${rotY.toFixed(2)}`);
    }
    check(shown.length > 0, `every marker hidden at rotY=${rotY.toFixed(2)}`);
    check(shown.length < hotspots.length, `no marker culled at rotY=${rotY.toFixed(2)} — far-side culling is not running`);
  }
  check(visibleSets[0] !== visibleSets[1],
    `the same markers are visible half a turn apart (${visibleSets[0]}) — culling is not tracking the camera`);

  // Idle spin: with motion allowed the raster must keep changing on its own —
  // but only while the globe is on screen, since the component pauses the
  // controls when it scrolls out of view. Both halves are asserted.
  const frameOf = () => document.querySelector('[data-worldglyph] pre.glyph-output')?.textContent ?? '';
  const spinPage = await browser.newContext().then((c) => c.newPage());
  await spinPage.goto(`${BASE}${PATH}`, { waitUntil: 'load' });
  await spinPage.waitForTimeout(400);
  const offscreen1 = await spinPage.evaluate(frameOf);
  await spinPage.waitForTimeout(900);
  const offscreen2 = await spinPage.evaluate(frameOf);
  check(offscreen1.length > 0, 'the globe rendered nothing on a scrolled-to-top load');
  check(offscreen1 === offscreen2, 'the globe kept re-rasterizing while scrolled out of view');

  await spinPage.evaluate(() => document.querySelector('[data-worldglyph]')?.scrollIntoView());
  await spinPage.waitForTimeout(400);
  const onscreen1 = await spinPage.evaluate(frameOf);
  await spinPage.waitForTimeout(900);
  const onscreen2 = await spinPage.evaluate(frameOf);
  check(onscreen1 !== onscreen2, 'the globe is not spinning on screen — two frames 900ms apart are identical');

  console.log(`globe        : ${g.ink} cells over ${g.filledRows}/${rows} rows`);
  console.log(`colours      : ${land.length} land, ${ocean.length} ocean`);
  console.log(`markers      : ${g.spots.length} placed — ${g.spots.map((s) => s.label.split(' ')[0]).join('')}`);
  console.log(`far-side cull: ${visibleSets[0] || '(none)'}  vs  ${visibleSets[1] || '(none)'}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('\nFAIL\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nOK — the globe renders, is two-tone, and culls its far-side markers.');
