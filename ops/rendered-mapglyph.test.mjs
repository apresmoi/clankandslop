import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderedMapGlyphFindings, verifyRenderedMapGlyph } from './rendered-mapglyph.mjs';

const map = `<figure data-astro-cid="a" class="mapglyph is-print tone-soft locator-regional"><div data-astro-cid="a" class="mapglyph-print"><pre data-astro-cid="a"><span class="mg-l">▓</span></pre><span class="mg-label side-left">TAIPEI</span><div data-astro-cid="a" class="mapglyph-locator loc-br"><pre data-astro-cid="a"><span class="lc-m">█</span></pre><span data-astro-cid="a" class="locator-footprint" style="left: 42%; top: 30%; width: 4.5%; height: 6%;"></span></div></div><figcaption class="mapglyph-caption">Taiwan terrain.</figcaption></figure>`;
const html = `<html><body><div data-astro-cid="h" class="hero-art hero-art-map">${map}</div><div class="hero-lead"></div></body></html>`;

test('rendered MapGlyph proof requires lead terrain, locator minimap, and positive footprint', () => {
  assert.deepEqual(renderedMapGlyphFindings(html), []);
  for (const className of ['hero-art-map', 'mapglyph-print', 'mapglyph-locator', 'is-print']) {
    assert.notDeepEqual(renderedMapGlyphFindings(html.replace(className, `${className}-removed`)), []);
  }
  assert.match(renderedMapGlyphFindings(html.replace('mapglyph-print', 'mapglyph-flat')).join('\n'), /missing nonempty print MapGlyph terrain/u);
  assert.match(renderedMapGlyphFindings(`<html><body><main>${map}</main></body></html>`).join('\n'), /missing lead Hero MapGlyph art/u);
  const noLocator = html.replace(/<div data-astro-cid="a" class="mapglyph-locator loc-br"><pre data-astro-cid="a"><span class="lc-m">█<\/span><\/pre><span data-astro-cid="a" class="locator-footprint"[^>]*><\/span><\/div>/u, '');
  assert.match(renderedMapGlyphFindings(noLocator).join('\n'), /missing nonempty MapGlyph locator minimap/u);
  assert.match(renderedMapGlyphFindings(html.replace('<span class="mg-l">▓</span>', '')).join('\n'), /missing nonempty print MapGlyph terrain/u);
  assert.match(renderedMapGlyphFindings(html.replace('<span class="lc-m">█</span>', '')).join('\n'), /missing nonempty MapGlyph locator minimap/u);
  assert.match(renderedMapGlyphFindings(html.replace('width: 4.5%; height: 6%;', 'width: 0%; height: 6%;')).join('\n'), /positive width and height/u);
});

test('rendered MapGlyph file verifier checks one explicit built front file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rendered-mapglyph-'));
  try {
    const file = join(dir, 'index.html');
    writeFileSync(file, html);
    assert.deepEqual(verifyRenderedMapGlyph(file).findings, []);
    assert.match(verifyRenderedMapGlyph(dir).findings.join('\n'), /expected one built front HTML file/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('rendered annotations must match the selected composition and remain inside the map', () => {
  const props = {spots:[{name:'TAIPEI'}],caption:'Taiwan terrain.'};
  assert.deepEqual(renderedMapGlyphFindings(html, 'test', {props}), []);
  assert.match(renderedMapGlyphFindings(html.replace('TAIPEI', 'ANOTHER PLACE'), 'test', {props}).join(), /differ from composition spots/);
  assert.match(renderedMapGlyphFindings(html.replace('Taiwan terrain.', 'Wrong caption'), 'test', {props}).join(), /caption differs/);
  const missing = html.replace('<span class="mg-label side-left">TAIPEI</span>', '');
  assert.match(renderedMapGlyphFindings(missing).join(), /missing named/);
  assert.match(renderedMapGlyphFindings(missing + '<span class="mg-label">TAIPEI</span>').join(), /missing named/);
  assert.match(renderedMapGlyphFindings(html.replace('mapglyph-caption', 'removed-caption')).join(), /missing MapGlyph caption/);
  const marked = html.replace('<div data-astro-cid="a" class="mapglyph-print">', '<div class="mapglyph-head"><span class="mapglyph-title">Context</span><span class="mapglyph-legend"><span class="legend-item"><span class="legend-glyph mg-r-accent">•••</span>Named route</span></span></div><div data-astro-cid="a" class="mapglyph-print">').replace('<span class="mg-l">▓</span>', '<span class="mg-l">▓</span><span class="mg-r-accent">•</span>');
  const routeProps = {...props,title:'Context',routes:[{name:'Named route',points:[[1,1],[2,2]]}]};
  assert.deepEqual(renderedMapGlyphFindings(marked, 'test', {props:routeProps}), []);
  assert.match(renderedMapGlyphFindings(marked.replace('<span class="mg-r-accent">•</span>', ''), 'test', {props:routeProps}).join(), /missing rendered routes ink/);
  assert.match(renderedMapGlyphFindings(marked.replace('Named route', 'Unkeyed'), 'test', {props:routeProps}).join(), /missing rendered map key/);
});
