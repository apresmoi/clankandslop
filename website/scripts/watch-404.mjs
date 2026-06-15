// Dev watcher: re-bake the 404 glyph whenever its recipe changes, then nudge
// the GlyphArt component so the Astro dev server hot-reloads the page.
//
// Run it ALONGSIDE the dev server (two terminals):
//   npm run dev        # serves http://localhost:4321/
//   npm run watch:404  # re-bakes + reloads on every save of bake-404.mjs
//
// Edit the TUNABLES block at the top of scripts/bake-404.mjs (text, font,
// depth, camera, light, grid), save, and the 404 (http://localhost:4321/asdasd
// or /404) updates on its own.
import { watch, utimesSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BAKE = resolve(here, 'bake-404.mjs');
const COMPONENT = resolve(here, '..', 'src', 'components', 'GlyphArt.astro');

function rebake() {
  console.log('· baking 404…');
  const r = spawnSync('node', [BAKE], { stdio: 'inherit' });
  if (r.status === 0) {
    const now = new Date();
    try { utimesSync(COMPONENT, now, now); } catch { /* ignore */ }
    console.log('· reloaded http://localhost:4321/404\n');
  }
}

let timer = null;
let lastMtime = 0;
function onChange() { clearTimeout(timer); timer = setTimeout(rebake, 150); }

rebake();
watch(here, { persistent: true }, (_evt, file) => {
  if (file && basename(file) === 'bake-404.mjs') onChange();
});
setInterval(() => {
  try { const m = statSync(BAKE).mtimeMs; if (m !== lastMtime) { lastMtime = m; onChange(); } } catch { /* ignore */ }
}, 600);
console.log(`watching ${BAKE}\n→ edit the TUNABLES block, save, and the 404 rebakes + reloads.`);
