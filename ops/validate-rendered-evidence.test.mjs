import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRenderedEvidence, RENDERED_EVIDENCE_EPOCH } from './validate-rendered-evidence.mjs';

function fixture(root, date) {
  const directory = resolve(root, 'content/editions', date, 'articles');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'a.json'), JSON.stringify({ evidence_box: [{ fragment: 'Skip to content' }] }));
  const rendered = resolve(root, 'website/dist/editions', date, 'articles/a');
  mkdirSync(rendered, { recursive: true });
  writeFileSync(resolve(rendered, 'index.html'), '<div class="evidence-row"><span class="frag">Skip to content</span></div>');
}

test('frozen archive rebuilds are compatible; explicit releases and new builds reject final contamination', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rendered-gate-'));
  try {
    fixture(root, '2026-10-13');
    assert.match(validateRenderedEvidence(root), /frozen archive.*no new publication checked/);
    assert.throws(() => validateRenderedEvidence(root, '2026-10-13'), /navigation: Skip to content/);
    fixture(root, RENDERED_EVIDENCE_EPOCH);
    assert.throws(() => validateRenderedEvidence(root), /navigation: Skip to content/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
