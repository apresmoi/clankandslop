// Build-time compile of a rotating glyph from a committed 3D model. Runs in
// Astro frontmatter (Node, at build). The model in src/models/ is the source of
// truth — nothing is pre-baked or committed as output.
//
// It uses @glyphcss/compile (which bundles its OWN glyphcss) on purpose: that
// keeps the model→ASCII compiler isolated from the top-level `glyphcss` the
// interactive globe/maps (WorldGlyph/MapGlyph) render with, so the two can be on
// different versions without one breaking the other.
//
// A turntable of frames is rendered and stacked into one <pre>; the GlyphArt
// component cycles them with a pure-CSS steps() film-strip (zero JS).
import { loadMeshFromFile, compilePolygons } from '@glyphcss/compile';

export interface RollOptions {
  /** number of turntable frames (more = smoother) */
  frames?: number;
  /** camera elevation; lower = more 3-D depth. A flat model stays clean across a
      full spin down to ~40°; below that it can go edge-on. */
  rotX?: number;
  zoom?: number;
  cols?: number;
  rows?: number;
  /** seconds for one full rotation (independent of frame count) */
  dur?: number;
  /** ping-pong an arc instead of a full loop (for models that can't spin clean) */
  alternate?: boolean;
  arc?: [number, number];
}

export interface RollResult {
  html: string; frames: number; frameH: number; fontPx: number;
  scroll: number; dur: number; alternate: boolean;
}

const FONT = 13;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function bakeRoll(modelPath: string, opts: RollOptions = {}): Promise<RollResult> {
  const { frames = 60, rotX = 48, zoom = 9, cols = 60, rows = 26, dur = 10, alternate = false, arc } = opts;
  const { polygons } = await loadMeshFromFile(modelPath);

  // Normalize to a 2-unit box so `zoom` frames the model predictably —
  // compilePolygons positions by zoom but does NOT auto-scale, so the raw model
  // scale would otherwise be wildly over/under-zoomed.
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of polygons) for (const v of (p as any).vertices) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], v[i]); mx[i] = Math.max(mx[i], v[i]); }
  const ctr = [0, 1, 2].map((i) => (mn[i] + mx[i]) / 2);
  const k = 2 / (Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1);
  const norm = polygons.map((p: any) => ({ ...p, vertices: p.vertices.map((v: number[]) => [(v[0] - ctr[0]) * k, (v[1] - ctr[1]) * k, (v[2] - ctr[2]) * k]) }));

  const rawFrames: string[][] = [];
  for (let f = 0; f < frames; f++) {
    const rotY = arc ? arc[0] + ((arc[1] - arc[0]) * f) / (frames - 1) : (f * 360) / frames;
    const res = compilePolygons(norm, {
      projection: 'orthographic', rotX, rotY, zoom, cols, rows,
      cellAspect: 1.67, autoCenter: true, useColors: false, mode: 'solid',
    } as any);
    const L: string[] = (res as any).inner.replace(/<[^>]+>/g, '').split('\n').slice(0, rows);
    while (L.length < rows) L.push('');
    rawFrames.push(L);
  }

  // Crop every frame to the UNION content bounding box across all frames, then
  // pad each line to that exact width. Uniform W×H blocks keep the autoCentered
  // model filling and centered in the <pre> (a ragged fit-content block drifts,
  // noticeably on mobile).
  let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
  rawFrames.forEach((fr) => fr.forEach((line, r) => {
    const s = line.search(/\S/);
    if (s >= 0) { minC = Math.min(minC, s); maxC = Math.max(maxC, line.replace(/\s+$/, '').length - 1); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
  }));
  if (maxC < 0) { minC = 0; maxC = cols - 1; minR = 0; maxR = rows - 1; }
  const W = maxC - minC + 1, H = maxR - minR + 1;
  const out = rawFrames.map((fr) =>
    fr.slice(minR, maxR + 1).map((line) => (line.slice(minC, maxC + 1) + ' '.repeat(W)).slice(0, W)).join('\n'),
  );

  const html = `<div class="glyph-roll"><pre class="glyph-output">${esc(out.join('\n'))}</pre></div>`;
  return { html, frames, frameH: H * FONT, fontPx: FONT, scroll: frames * H, dur, alternate };
}
