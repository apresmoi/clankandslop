// Bake a glyph from a config blob copied out of the workbench (glyph-lab.mjs).
// Usage:  node scripts/bake-from-config.mjs '<json>' [outName]
import { loadPolys, applyOrient, normalize, render } from './glyph-render.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const cfg = JSON.parse(process.argv[2]);
const out = process.argv[3] || cfg.outName || cfg.name || 'glyph';
const polys = normalize(applyOrient(loadPolys(cfg.modelPath), cfg.orient ?? cfg.zup ?? 0));
const r = render(polys, cfg);
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', `glyphart-${out}.txt`);
writeFileSync(OUT, r.ascii + '\n');
console.log(`${out} → glyphart-${out}.txt  (${r.w}x${r.h})  zoom${r.zoom.toFixed(1)}`);
