import test from 'node:test';
import assert from 'node:assert/strict';
import { renderedEvidenceFields, renderedEvidenceFindings } from './rendered-evidence.mjs';

const rendered = text => `<div class="evidence-box"><div class="evidence-row"><span class="frag">${text}</span><div class="source-note"><dl><dd class="excerpt">${text}</dd></dl></div></div></div>`;

test('final records are checked after HTML escaping and nested markup, separately from article prose', () => {
  assert.equal(renderedEvidenceFindings(rendered('Skip&#32;to <b>content</b>')).length, 2);
  assert.equal(renderedEvidenceFindings('<p>Order A Flag</p>' + rendered('The council issued its statement.')).length, 0);
  assert.ok(renderedEvidenceFindings(rendered('The council issued its statement.'), { fragments: 2, excerpts: 1 }).some(f => f.includes('count')));
});

test('final records normalize visible whitespace and line breaks before matching navigation', () => {
  for (const [html, expected] of [
    ['Skip  to content', 'Skip to content'],
    ['Order A\nFlag', 'Order A Flag'],
    ['Skip&#9;to content', 'Skip to content'],
    ['Skip&#x9;to content', 'Skip to content'],
    ['Skip&nbsp;to content', 'Skip to content'],
    ['Skip<br>to content', 'Skip to content'],
    ['Order A<br/>Flag', 'Order A Flag'],
    ['Skip <b>to</b>\ncontent', 'Skip to content'],
  ]) {
    const final = rendered(html);
    assert.deepEqual(renderedEvidenceFields(final).map(field => field.text), [expected, expected]);
    const findings = renderedEvidenceFindings(final, { fragments: 1, excerpts: 1 });
    assert.equal(findings.length, 2, html);
    assert.ok(findings.every(finding => finding.includes(`navigation: ${expected}`)), html);
  }
  assert.deepEqual(renderedEvidenceFindings(rendered('The council<br>issued its statement.'), { fragments: 1, excerpts: 1 }), []);
  assert.deepEqual(renderedEvidenceFields(rendered('Ski<b>p</b> to content')).map(field => field.text), ['Skip to content', 'Skip to content']);
});
