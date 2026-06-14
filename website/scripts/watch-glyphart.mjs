// Dev watcher: re-bake the glyph art whenever the bake recipe changes, then
// nudge the GlyphArt component so the Astro dev server hot-reloads the page.
//
// Run it ALONGSIDE the dev server (two terminals):
//   npm run dev            # serves http://localhost:4321/
//   npm run watch:glyphart # re-bakes + reloads on every save of bake-glyphart.mjs
//
// Edit scripts/bake-glyphart.mjs (light intensity / ambient / shadow / camera),
// save, and the page updates on its own.
import { watch, utimesSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BAKE = resolve(here, 'bake-glyphart.mjs');
const COMPONENT = resolve(here, '..', 'src', 'components', 'GlyphArt.astro');

function rebake() {
  const r = spawnSync('node', [BAKE], { stdio: 'inherit' });
  if (r.status === 0) {
    // Touch the component so Vite re-imports the freshly-written .txt and the
    // browser reloads (a ?raw import change alone doesn't always trigger HMR).
    const now = new Date();
    try { utimesSync(COMPONENT, now, now); } catch { /* ignore */ }
    console.log('· reloaded http://localhost:4321/\n');
  }
}

// Watch the DIRECTORY, not the file: editors save atomically (temp file +
// rename), which swaps the inode and silently kills a single-file fs.watch.
// Also poll mtime as a belt-and-suspenders fallback.
let timer = null;
let lastMtime = 0;
function onChange() { clearTimeout(timer); timer = setTimeout(rebake, 150); }

rebake();
watch(here, { persistent: true }, (_evt, file) => {
  if (file && basename(file) === 'bake-glyphart.mjs') onChange();
});
setInterval(() => {
  try { const m = statSync(BAKE).mtimeMs; if (m !== lastMtime) { lastMtime = m; onChange(); } } catch { /* ignore */ }
}, 600);
console.log(`watching ${BAKE}\n→ edit it, save, and the page rebakes + reloads.`);
