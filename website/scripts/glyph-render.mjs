// Shared glyph render core — used by BOTH the live workbench (glyph-lab.mjs) and
// the committing baker (bake-from-config.mjs), so what you dial in the lab is
// byte-identical to what gets baked. Uses the LOCAL glyphcss source build (the
// one with DEGREES cameras + self-shadows), same as every other bake script.
import { parseObj, parseGltf, parseVox, buildRasterizeContext, rasterize, createGlyphOrthographicCamera, computeSceneBbox } from '/Users/apresmoi/glyphcss/packages/glyphcss/dist/index.js';
import { readFileSync } from 'node:fs';

const DEG = Math.PI / 180;

export function loadPolys(p) {
  const buf = readFileSync(p);
  const ext = p.toLowerCase().split('.').pop();
  if (ext === 'obj') return parseObj(buf.toString('utf8')).polygons;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (ext === 'glb' || ext === 'gltf') return parseGltf(ab).polygons;
  if (ext === 'vox') return parseVox(ab).polygons;
  throw new Error('unsupported model extension: ' + ext);
}

// orient: 0 = native · 1 = Z-up→Y-up · 2 = stand X-axis up (+90° about Z) ·
//         3 = stand Z-axis up the other way · 4 = lay down (+90° about X)
export function applyOrient(raw, orient) {
  const o = String(orient ?? 0);
  const map = {
    '1': ([x, y, z]) => [x, z, -y],
    '2': ([x, y, z]) => [-y, x, z],
    '3': ([x, y, z]) => [x, -z, y],
    '4': ([x, y, z]) => [z, y, -x],
  };
  return map[o] ? raw.map((p) => ({ ...p, vertices: p.vertices.map(map[o]) })) : raw;
}

export function normalize(raw) {
  const b = computeSceneBbox(raw);
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
  const k = 2 / (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1);
  return raw.map((p) => ({ ...p, vertices: p.vertices.map((v) => [(v[0] - c[0]) * k, (v[1] - c[1]) * k, (v[2] - c[2]) * k]) }));
}

// directional light from azimuth/elevation (deg) → travel direction
export function lightDir(az, el) {
  const a = az * DEG, e = el * DEG, ce = Math.cos(e);
  return [-ce * Math.sin(a), -ce * Math.cos(a), -Math.sin(e)];
}

// glyphcss solid mode is hardwired to this 10-level ramp. We re-quantize the
// output to `levels` chars (2–10) so fewer, bolder glyphs read as a silhouette
// instead of a noisy gradient. Space (index 0) always stays background.
const MASTER_RAMP = ' .:-=+*#%@';
function reramp(s, levels) {
  if (!levels || levels >= 10) return s;
  const L = Math.max(2, levels);
  const tgt = Array.from({ length: L }, (_, j) => MASTER_RAMP[Math.round((j / (L - 1)) * 9)]);
  return s.replace(/[^\n]/g, (c) => {
    const i = MASTER_RAMP.indexOf(c);
    return i < 0 ? c : tgt[Math.round((i / 9) * (L - 1))];
  });
}

function coverage(out, cols, rows) {
  const lines = out.replace(/[ \t]+$/gm, '').split('\n');
  const h = lines.filter((l) => l.trim()).length;
  const w = Math.max(0, ...lines.map((l) => l.replace(/\s+$/, '').length));
  return Math.max(w / cols, h / rows);
}

// polys must already be oriented + normalized. cfg holds every knob.
export function render(polys, cfg) {
  const cols = +cfg.cols || 158, rows = +cfg.rows || 94, cellAspect = +cfg.cellAspect || 1.48;
  // optional re-centering nudge (normalized units) — the gallery's autoCenter
  // isn't always the visual centre, so allow a manual translate.
  const ox = +cfg.offsetX || 0, oy = +cfg.offsetY || 0;
  if (ox || oy) polys = polys.map((p) => ({ ...p, vertices: p.vertices.map(([x, y, z]) => [x + ox, y + oy, z]) }));
  const once = (zoom) => {
    const ctx = buildRasterizeContext({
      camera: createGlyphOrthographicCamera({ rotX: +cfg.rotX || 0, rotY: +cfg.rotY || 0, zoom }),
      grid: { cols, rows, cellAspect },
      polygons: polys,
      mode: cfg.mode || cfg.renderMode || 'solid',
      ...(cfg.glyphPalette ? { glyphPalette: cfg.glyphPalette } : {}),
      directionalLight: { direction: lightDir(+cfg.az || 0, +cfg.el || 0), intensity: +cfg.intensity || 1, color: '#ffffff' },
      ambientLight: { intensity: Number.isFinite(+cfg.ambient) ? +cfg.ambient : 0.4, color: '#ffffff' },
      useColors: false,
      doubleSided: cfg.doubleSided !== false,
      smoothShading: !!cfg.smoothShading,
    });
    return rasterize(ctx);
  };
  let zoom = +cfg.zoom || 14, out = once(zoom);
  if (cfg.autoFrame !== false) {
    zoom = 6; out = once(zoom);
    for (let i = 0; i < 7; i++) {
      const cov = coverage(out, cols, rows);
      if (cov > 0.72 && cov < 0.9) break;
      zoom *= (cfg.frameTarget || 0.8) / Math.max(cov, 0.05);
      out = once(zoom);
    }
  }
  out = reramp(out, +cfg.levels);
  // full = the whole cols×rows grid (spaces kept) so the lab can draw the scene box.
  const full = out.split('\n').slice(0, rows).map((l) => l.replace(/\s+$/, '').padEnd(cols)).join('\n');
  let L = out.replace(/[ \t]+$/gm, '').split('\n');
  while (L.length && !L[0].trim()) L.shift();
  while (L.length && !L[L.length - 1].trim()) L.pop();
  const ind = Math.min(...L.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  L = L.map((l) => l.slice(isFinite(ind) ? ind : 0));
  return { ascii: L.join('\n'), full, cols, rows, zoom, w: Math.max(0, ...L.map((l) => l.length)), h: L.length };
}
