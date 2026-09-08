import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileArticle, recordAssignment } from './production-newsroom.mjs';

const runtimeTest = (name, action) => test(name, { skip: !process.env.CLANK_NEWSROOM_STATE_ADAPTER && 'private newsroom state adapter unavailable; run the private integration gate' }, action);
const published = JSON.parse(readFileSync(new URL('../../content/editions/2026-08-21/articles/deepseek-ships-flash-vision-on-the-api.json', import.meta.url), 'utf8'));
async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(name));
    else out[name] = await readFile(name, 'utf8');
  }
  return out;
}

runtimeTest('fileArticle cannot bypass format checks and rejected mutations write nothing', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-article-format-'));
  const names = ['CLANK_EDITION_STATE_ROOT', 'CLANK_NEWSROOM_AGENT', 'CLANK_FILE_ARTICLE_HARD_LINT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.CLANK_EDITION_STATE_ROOT = temporary;
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  process.env.CLANK_FILE_ARTICLE_HARD_LINT = '0';
  try {
    await recordAssignment({ edition: published.edition_date, event_key: 'format-assignment', assignments: ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'].map((owner, i) => ({ id: i ? `other-${i}` : published.id, owner, brief: 'Report the actual sourced event and its consequences.', evidence_refs: i ? [] : ['s-0c0be037'], ...(i === 1 ? { slot: 'forecast', dissenter: 'vesta' } : {}) })) });
    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    const base = structuredClone(published);
    base.presentation = { flashpoint: { place: 'PANAMA', lat: 9.08, lon: -79.52, note: 'The schedule changes. The booking limit remains provisional.' } };
    base.evidence_box[0].source_note.source_id = 's-0c0be037'; base.refs[0] = 's-0c0be037';
    const before = await snapshot(temporary);
    const mutations = [
      a => { delete a.headline; }, a => { a.unknown = true; },
      a => { a.byline.agents = ['cogsworth']; }, a => { a.byline.agents.push('Tinkerton'); }, a => { a.byline.agents = ['Tinkerton']; },
      a => { a.key_numbers[0] = '384'; }, a => { a.body[0] = { text: 'Broken' }; },
      a => { a.evidence_box = [null]; }, a => { a.refs = {}; },
      a => { a.evidence_box[0].source_note.source_url = 'javascript:alert(1)'; },
      a => { a.evidence_box[0].source_note.used_by_agent = 'Tinkerton'; },
      a => { a.evidence_box[1].source_note.source_id = 'E9'; a.refs[1] = 'E9'; a.body[0] = 'Citation alias [E9].'; },
      a => { [a.evidence_box[1], a.evidence_box[2]] = [a.evidence_box[2], a.evidence_box[1]]; },
      a => { a.epistemic = 'forecast'; a.confidence = { label: 'CALL', value: 0.5 }; a.next_update_utc = '99:99'; },
      a => { a.epistemic = 'forecast'; }, a => { a.confidence = { label: 'CALL', value: 0.5, interval: '0.1' }; },
      a => { a.body[0] = '<b>Raw HTML</b> [E1].'; },
      a => { a.presentation.flashpoint.agent = 'Tinkerton'; }, a => { a.presentation.flashpoint.lat = '9.08'; }, a => { a.presentation.teaser = 'Not reporter-owned'; },
      a => { a.previous_coverage = [{ date: '2026-08-20', slug: 'missing-reference-article' }]; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const article = structuredClone(base); mutate(article);
      await assert.rejects(fileArticle({ edition: published.edition_date, event_key: `format-bad-${index}`, article }), /article format rejected.*nothing was recorded/u);
      assert.deepEqual(await snapshot(temporary), before, `mutation ${index} wrote state`);
    }
    const result = await fileArticle({ edition: published.edition_date, event_key: 'format-good', article: base });
    const filed = JSON.parse(await readFile(path.join(temporary, 'editions', published.edition_date, 'filings', result.article_id, '1.json'), 'utf8'));
    const { assignment_ref, lint, ...publication } = filed;
    assert.equal(assignment_ref.id, published.id);
    assert.deepEqual(publication, base, 'only authenticated filing metadata may be added');
    assert.ok(Object.keys(await snapshot(temporary)).length > Object.keys(before).length, 'accepted filing must land');
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    await rm(temporary, { recursive: true, force: true });
  }
});
