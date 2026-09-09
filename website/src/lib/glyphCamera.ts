/** glyphcss 0.1.x camera units, and the translation from the ones our blocks
    are authored in.

    glyphcss 0.1.0 re-derived its camera on voxcss/three.js conventions and
    changed the meaning of every number WorldGlyph and MapGlyph feed it:

      rotX / rotY   radians                        → DEGREES
      zoom          fraction of min(cols, rows)    → CSS px per world unit
      distance      world-unit pinhole (default 3) → CSS-px pull-back
                    (default 0); the old pinhole divide moved to a separate
                    `perspective` option, default 32000 ≈ orthographic

    None of that is a type error and none of it throws: the old numbers still
    compile and still render — into a single character cell, because 0.33 px
    per world unit is a 0.66 px globe. That is the whole "renders nothing" bug.

    Block props (and the edition JSON that sets them) stay in the old units, so
    the conversion lives here, once, for both components. */

/** 0.0.3: `radius = min(cols, rows) * zoom * ZOOM_TO_RADIUS`. */
const ZOOM_TO_RADIUS = 1.5;
/** The pinhole distance both components' angles were tuned against. */
const OLD_DISTANCE = 100;
/** 0.0.3 scaled depth by this before its perspective divide. */
const OLD_MESH_UNIT = 30;
/** glyphcss's fallback character-cell height when it cannot measure one. */
export const BASE_TILE = 50;

/** 0.1.x divides by `(P - z * BASE_TILE)`; 0.0.3 divided by `(1 - z * 30/100)`.
    They are the same curve at this P, so the geometry keeps exactly the
    foreshortening production has today. */
export const GLYPH_PERSPECTIVE = (BASE_TILE / OLD_MESH_UNIT) * OLD_DISTANCE;

/** Radians → glyphcss degrees. */
export const glyphRot = (radians: number): number => (radians * 180) / Math.PI;

/** Old viewport-fraction zoom → 0.1.x CSS px per world unit. `cellHeight` is
    the rendered character cell in px — the same quantity glyphcss measures
    internally, so the projection lands on the same cells it used to. */
export const glyphZoom = (fraction: number, cols: number, rows: number, cellHeight: number): number =>
  fraction * ZOOM_TO_RADIUS * Math.min(cols, rows) * cellHeight;

/** Measure one character cell of the `<pre>` glyphcss will create inside
    `host`. Mirrors glyphcss's own probe — `.glyph-scene .glyph-output` is
    `font-family: monospace; font-size: inherit; line-height: 1`, measured over
    many lines so a sub-1 line-height still yields the true per-line advance —
    rather than trusting the stylesheet's font-size. Falls back to the same
    BASE_TILE glyphcss does when layout is unavailable, so both sides agree. */
export function measureGlyphCellHeight(host: HTMLElement): number {
  const LINES = 20;
  const probe = host.ownerDocument.createElement('pre');
  probe.textContent = Array(LINES).fill('M').join('\n');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;margin:0;padding:0;' +
    'white-space:pre;font-family:monospace;font-size:inherit;line-height:1';
  host.appendChild(probe);
  const h = probe.getBoundingClientRect().height / LINES;
  probe.remove();
  return h > 0 ? h : BASE_TILE;
}
