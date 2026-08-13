import { compilePolygons } from '@glyphcss/compile';
import type { RollResult } from './glyphRoll.ts';

const FONT = 13;
const COLS = 72;
const ROWS = 30;
const FRAMES = 61;
const DURATION = 6.6;
const SUN = '#ff0000';
const MOON = '#0000ff';
const CORONA = '#00ff00';

type SemanticKind = '' | 'sun' | 'moon' | 'corona';
type RenderKind = SemanticKind | 'corona-faint' | 'corona-mid' | 'corona-strong';
type Cell = { char: string; kind: RenderKind };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function disc(screenX: number, screenY: number, depth: number, radius: number, color: string) {
  return {
    vertices: Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return [screenY + Math.cos(a) * radius, screenX + Math.sin(a) * radius, depth];
    }),
    color,
  };
}

function colorKind(color: string): SemanticKind {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return '';
  const [r, g, b] = match.slice(1).map((channel) => Number.parseInt(channel, 16));
  if (b > 0) return 'moon';
  if (r > 0) return 'sun';
  if (g > 0) return 'corona';
  return '';
}

function parseLine(line: string): Cell[] {
  const cells: Cell[] = [];
  const chunks = /<span style="color:([^"]+)">([^<]*)<\/span>|([^<]+)/g;
  for (const match of line.matchAll(chunks)) {
    const kind = match[1] ? colorKind(match[1]) : '';
    for (const char of match[2] ?? match[3] ?? '') cells.push({ char, kind });
  }
  while (cells.length < COLS) cells.push({ char: ' ', kind: '' });
  return cells.slice(0, COLS);
}

function render(polygons: ReturnType<typeof disc>[]): Cell[][] {
  const result = compilePolygons(polygons as any, {
    projection: 'orthographic',
    rotX: 0,
    rotY: 0,
    zoom: 8.1,
    cols: COLS,
    rows: ROWS,
    cellAspect: 1.67,
    autoCenter: false,
    useColors: true,
    mode: 'solid',
    glyphPalette: 'dots',
    doubleSided: true,
    supersample: 4,
  } as any);
  const lines = (result as any).inner.split('\n').slice(0, ROWS);
  while (lines.length < ROWS) lines.push('');
  return lines.map(parseLine);
}

function eclipseOffset(frame: number) {
  const t = (frame / (FRAMES - 1)) * 2 - 1;
  return Math.sign(t) * 2.32 * Math.pow(Math.abs(t), 1.35);
}

function coronaLevel(offset: number) {
  const distance = Math.abs(offset);
  if (distance <= 0.08) return 'corona-strong';
  if (distance <= 0.18) return 'corona-mid';
  if (distance <= 0.3) return 'corona-faint';
  return '';
}

function keepMainComponent(frame: Cell[][], matches: (cell: Cell) => boolean, minimum: number) {
  const visited = new Set<string>();
  const components: [number, number][][] = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!matches(frame[r][c]) || visited.has(`${r}:${c}`)) continue;
    const component: [number, number][] = [];
    const queue: [number, number][] = [[r, c]];
    visited.add(`${r}:${c}`);
    while (queue.length) {
      const [row, col] = queue.pop()!;
      component.push([row, col]);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nr = row + dr, nc = col + dc;
        const key = `${nr}:${nc}`;
        if ((dr || dc) && nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && matches(frame[nr][nc]) && !visited.has(key)) {
          visited.add(key);
          queue.push([nr, nc]);
        }
      }
    }
    components.push(component);
  }
  const main = components.sort((a, b) => b.length - a.length)[0] ?? [];
  const keep = new Set(main.length >= minimum ? main.map(([r, c]) => `${r}:${c}`) : []);
  frame.forEach((row, r) => row.forEach((cell, c) => {
    if (matches(cell) && !keep.has(`${r}:${c}`)) row[c] = { char: ' ', kind: '' };
  }));
  return frame;
}

export async function bakeEclipse(): Promise<RollResult> {
  const sunPolygon = disc(0, 0, 0, 1, SUN);
  const coronaPolygon = disc(0, 0, -0.08, 1.105, CORONA);
  const sunMask = render([sunPolygon]);
  const rawFrames = Array.from({ length: FRAMES }, (_, frame) => {
    const offset = eclipseOffset(frame);
    const screenY = -0.1 * (offset / 2.32);
    const corona = coronaLevel(offset);
    const scene = render([
      coronaPolygon,
      sunPolygon,
      disc(offset, screenY, 0.12, 1.015, MOON),
    ]);

    const clipped = scene.map((row, r) => row.map((cell, c) => {
      if (cell.kind === 'moon') {
        return sunMask[r][c].kind === 'sun' ? cell : { char: ' ', kind: '' as RenderKind };
      }
      if (cell.kind === 'sun') {
        return sunMask[r][c].kind === 'sun' ? cell : { char: ' ', kind: '' as RenderKind };
      }
      if (cell.kind === 'corona') {
        return corona ? { char: '·', kind: corona as RenderKind } : { char: ' ', kind: '' as RenderKind };
      }
      return cell;
    }));
    keepMainComponent(clipped, (cell) => cell.kind === 'moon', 8);
    return clipped;
  });

  let minC = COLS, maxC = -1, minR = ROWS, maxR = -1;
  for (const frame of rawFrames) {
    frame.forEach((row, r) => row.forEach((cell, c) => {
      if (cell.char === ' ') return;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }));
  }
  if (maxC < 0) {
    minC = 0;
    maxC = COLS - 1;
    minR = 0;
    maxR = ROWS - 1;
  }

  const width = maxC - minC + 1;
  const height = maxR - minR + 3;
  const frames = rawFrames.map((frame) => frame.slice(minR, maxR + 1).map((row) => {
    let line = '';
    let run = '';
    let runKind: string = '';
    const flush = () => {
      if (!run) return;
      line += runKind ? `<span class="glyph-eclipse-${runKind}">${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (const cell of row.slice(minC, maxC + 1)) {
      if (cell.kind !== runKind) {
        flush();
        runKind = cell.kind;
      }
      run += cell.char;
    }
    flush();
    return line;
  })).map((rows) => [' '.repeat(width), ...rows, ' '.repeat(width)].join('\n'));

  return {
    html: `<div class="glyph-roll glyph-eclipse-roll"><pre class="glyph-output">${frames.join('\n')}</pre></div>`,
    frames: FRAMES,
    frameH: height * FONT,
    fontPx: FONT,
    scroll: FRAMES * height,
    dur: DURATION,
    alternate: false,
  };
}
