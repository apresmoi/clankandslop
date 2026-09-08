import test from 'node:test';
import assert from 'node:assert/strict';
import { layEdition } from './lay-page.mjs';

const edition = '2026-09-09';
const map = { kind: 'map', name: 'taiwan-test', sha256: 'a'.repeat(64) };
const glyph = { kind: 'glyph', name: 'microchip-test', sha256: 'b'.repeat(64) };
const mapDoc = {name:map.name, west:118, east:124, south:20, north:26, cols:140, rows:48, bands:Array.from({length:48}, ()=>'0124'.repeat(35))};
const presentation = {caption:'Taiwan terrain', locator_context:'continental', title:'Taiwan corridor', tone:'normal',
  spots:[{name:'TAIPEI',lat:25.03,lon:121.57,label_side:'left',label_dy:8}],
  routes:[{name:'Context line',color:'accent',points:[[23,120],[24,121]]}],
  overlays:[{name:'Context area',color:'red',ring:[[22,120],[22,121],[23,121]]}]};
const glyphDoc = {name:glyph.name, cols:2, rows:2, art:'##\n #'};
function input() {
  const order = ['alpha','bravo','charlie','delta','echo'];
  const briefly = [1,2,3].map(n => ({label:`Desk ${n}`,lead:{kicker:'K',agent:'Cogsworth',what:'Fixture note'},rest:[]}));
  return {
    edition, articles:Object.fromEntries(order.map(id => [id,{id,section:'world',epistemic:'fact',headline:'Fixture',deck:'Fixture deck',byline:{agents:['Cogsworth']}}])),
    desk:{'caslon.chrome':{lead_story_id:'alpha'},'caslon.weather':{weather:null},'ledger.settlements':{resolved_last_edition:[]},'ledger.worlddesk':{world_desk:{}}},
    decisions:{edition,order,art:{alpha:{shape:'satellite',caption:'Lead'},bravo:{artifact:map,...structuredClone(presentation)},charlie:{artifact:glyph,caption:'Microchip'}},flashpoints:[],briefly,tape:{briefly}},
    artifacts:[{reference:map,document:mapDoc},{reference:glyph,document:glyphDoc}],agents:new Set(['Cogsworth']),archive:()=>undefined,
  };
}

test('fresh map and glyph reach page JSON and compose inputs without editing articles', () => {
  const source = input(), before = JSON.stringify(source.articles), result = layEdition(source);
  assert.deepEqual(result.artifacts,[map,glyph]);
  assert.deepEqual(result.maps,[{name:map.name,document:mapDoc}]);
  assert.equal(result.pages[0].document.head[1].props.columns[1][0].props.map,map.name);
  assert.equal(result.pages[0].document.head[1].props.columns[1][0].props.locator_context,'continental');
  const props = result.pages[0].document.head[1].props.columns[1][0].props;
  for (const [key, value] of Object.entries(presentation)) assert.deepEqual(props[key],value);
  assert.equal(result.pages[0].document.head[2].props.columns[0][0].props.glyph,glyph.name);
  assert.equal(JSON.stringify(source.articles),before);
});

test('generated map labels and source detail cannot be removed before composition', () => {
  for (const mutate of [
    x => delete x.decisions.art.bravo.spots,
    x => x.decisions.art.bravo.spots = [],
    x => x.decisions.art.bravo.spots[0].lat = 90,
    x => x.decisions.art.bravo.spots[0].lon = NaN,
    x => delete x.decisions.art.bravo.routes[0].name,
    x => x.artifacts[0].document = {...mapDoc,cols:52},
    x => x.artifacts[0].document = {...mapDoc,rows:30},
    x => x.decisions.art.bravo.cols = 52,
  ]) {
    const source = input(); mutate(source);
    assert.throws(() => layEdition(source), /map presentation/);
  }
});

test('missing, changed, ambiguous and unused generated selections are refused', () => {
  for (const mutate of [
    x => x.artifacts.pop(),
    x => x.artifacts[1].reference = {...glyph,sha256:'c'.repeat(64)},
    x => x.decisions.art.charlie.shape = 'chip',
    x => x.decisions.art.delta = {artifact:glyph,caption:'Unused flow'},
    x => x.artifacts.push(structuredClone(x.artifacts[1])),
    x => x.artifacts[1].document.art = '  \n  ',
    x => x.articles.bravo.art = {kind:'map',map:map.name},
  ]) {
    const {archive, ...data} = input();
    const source = structuredClone(data); source.archive=()=>mapDoc;
    mutate(source); assert.throws(()=>layEdition(source));
  }
});

test('baked layouts reject invisible or overflowing art scales before composition', () => {
  for (const scale of [0, -1, 1.01, 1e9, NaN, '0.6']) {
    const source = input(); source.decisions.art.charlie.scale = scale;
    assert.throws(() => layEdition(source), /scale/);
  }
  for (const scale of [0.6, 0.82, 0.86, 0.9, 1]) {
    const source = input(); source.decisions.art.charlie.scale = scale;
    const result = layEdition(source);
    assert.equal(result.pages[0].document.head[2].props.columns[0][0].props.scale, scale);
  }
});

test('art choices cannot be silently discarded by placement or reporter map ownership', () => {
  for (const slug of ['delta', 'missing']) {
    const source = input(); source.decisions.art[slug] = {shape:'chip',caption:'Unused'};
    assert.throws(() => layEdition(source), /art placement/);
  }
  for (const choice of [{shape:'chip'}, {roll:'chip'}, {scale:0.6}]) {
    const source = input();
    source.artifacts = [source.artifacts[1]];
    source.maps = {[map.name]:mapDoc};
    source.articles.bravo.art = {kind:'map',map:map.name};
    source.decisions.art.bravo = {...choice,caption:'Reporter map'};
    assert.throws(() => layEdition(source), /reporter map/);
  }
});

test('a decision lead cannot override the accepted chrome lead silently', () => {
  const source = input(); source.decisions.lead = 'alpha';
  source.desk['caslon.chrome'].lead_story_id = 'bravo';
  assert.throws(() => layEdition(source), /lead story.*caslon\.chrome\.lead_story_id/u);
  source.desk['caslon.chrome'].lead_story_id = 'alpha';
  source.decisions.lead = 'bravo';
  assert.throws(() => layEdition(source), /lead story.*decisions\.lead/u);
});
