import test from 'node:test';
import assert from 'node:assert/strict';
import { composedLeadMap, loadArticleMapArt } from './composed-map.ts';
import type { Article } from './edition.ts';
import type { Page } from './page.ts';

const props = {map:'region',caption:'Map: Caslon · Terrain: NOAA ETOPO1',spots:[{name:'PLACE',lat:32,lon:35}],locator_context:'regional'};
const page = {head:[{block:'Hero',props:{lead:'story',withArt:true,art:{block:'MapGlyph',props}}}]} as Page;

test('the article reuses Caslon lead map annotations without adding art to reporter JSON', () => {
  const before = JSON.stringify(page);
  assert.deepEqual(composedLeadMap(page, 'story'), {kind:'map',...props});
  assert.equal(composedLeadMap(page, 'another-story'), null);
  assert.equal(composedLeadMap({head:[]} as unknown as Page, 'story'), null);
  assert.equal(JSON.stringify(page), before);
  const extracted = composedLeadMap(page, 'story')!;
  extracted.spots![0].name = 'changed';
  assert.equal(props.spots[0].name, 'PLACE');
});

test('reporter art keeps precedence and absent historical fronts remain supported', () => {
  const article = {id:'story',art:{kind:'map',map:'reporter-map',caption:'Reporter'}} as Article;
  assert.equal(loadArticleMapArt('1900-01-01', article), article.art);
  assert.equal(loadArticleMapArt('1900-01-01', {id:'story'} as Article), null);
  assert.equal(loadArticleMapArt('1900-01-01', {id:'story',art:{kind:'ascii',caption:'Glyph'}} as Article), null);
});
