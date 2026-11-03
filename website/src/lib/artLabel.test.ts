import test from 'node:test';
import assert from 'node:assert/strict';
import { globeLabel, mapLabel } from './artLabel.ts';

test('mapLabel names the place, spots, zones and routes in prose', () => {
  assert.equal(
    mapLabel({ place: 'Strait of Hormuz', spots: [{ name: 'Bandar Abbas' }, { name: 'Fujairah' }, { name: 'Khasab' }], overlays: [{ name: 'Exclusion zone' }], routes: [{ name: 'Tanker lane' }, {}] }),
    'Map of Strait of Hormuz. Marked: Bandar Abbas, Fujairah and Khasab. Shaded: Exclusion zone. Route: Tanker lane.',
  );
});

test('mapLabel without a title lists only what is marked', () => {
  assert.equal(mapLabel({ place: 'Taiwan Strait' }), 'Map of Taiwan Strait.');
  assert.equal(mapLabel({ spots: [{ name: 'Kinmen' }] }), 'Map. Marked: Kinmen.');
});

test('globeLabel counts and lists flashpoints', () => {
  assert.equal(globeLabel([{ name: 'Gaza' }, { name: 'Kharkiv' }]), 'Rotating globe marking 2 flashpoints: Gaza and Kharkiv.');
  assert.equal(globeLabel([]), 'Rotating globe.');
});
