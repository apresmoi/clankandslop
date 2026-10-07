import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { relayOutlets, repeatedFigure, sentencesOf, unnamedOutlet, unnamedSpeakerStatement } from './attribution-lint.mjs';
import { proseLintFindings } from './prose-lint.mjs';
import { articleFormatFindings } from './article-format.mjs';

const flags = (article) => proseLintFindings({ headline: 'H', deck: 'D', ...article }).map((finding) => finding.flag);
const relay = (text) => ({ source: 'Al Jazeera', fragment: text, source_note: { source_id: 'E1', source_url: 'https://www.aljazeera.com/news/x', raw_excerpt: text } });

test('sentences keep the citations printed after their full stop', () => {
  assert.deepEqual(sentencesOf('Five abstained. [E1][E2] The result met the majority. [E6]'), ['Five abstained. [E1][E2]', 'The result met the majority. [E6]']);
  assert.deepEqual(sentencesOf(''), []);
});

test('unnamed_speaker: an anonymous role or a pronoun before any named person is flagged', () => {
  assert.equal(unnamedSpeakerStatement(['A US official said the carrier sailed on Sunday. [E1]']).phrase, 'A US official said');
  assert.equal(unnamedSpeakerStatement(['Talks resumed. [E1] An Iranian diplomat told reporters the text was agreed. [E2]']).phrase, 'An Iranian diplomat told');
  assert.equal(unnamedSpeakerStatement(['The strikes went on overnight. [E1]', 'He claimed 1,540 fighters were killed. [E2]']).phrase, 'He claimed');
  assert.deepEqual(flags({ body: ['"We will hold the line," she said on Friday. [E1]'] }), ['unnamed_speaker']);
  assert.match(proseLintFindings({ body: ['A senior government spokesperson said talks would resume. [E1]'] })[0].message, /name the speaker and their role/u);
});

test('unnamed_speaker: a named speaker, the second reference and a mononym-free body pass', () => {
  assert.equal(unnamedSpeakerStatement(['Yemeni government spokesman Majid al-Nuzaili said 474 strikes were carried out. [E1]', 'He claimed the strikes killed 1,540 fighters. [E2]']), undefined);
  assert.equal(unnamedSpeakerStatement(['Interior Minister Laurent Nuñez told TF1 that 1,747 people were detained. [E1] He put schools affected at 735. [E2]']), undefined);
  assert.equal(unnamedSpeakerStatement(['The spokesman for the ministry said talks would resume. [E1]']), undefined);
  assert.equal(unnamedSpeakerStatement(['The ministry said in a statement that the border was closed. [E1]']), undefined);
});

test('number_repeated: the same figure with the same unit word stated twice is flagged', () => {
  assert.deepEqual(repeatedFigure(['Police said at least 27 people died. [E1]', 'Two shootings killed at least 27 people, WBAL said. [E2]']), { figure: '27 people', first: 1, second: 2 });
  assert.deepEqual(repeatedFigure(['The manifest listed 1,200 passengers and missed 46 people. [E1] The difference is 46 people. [E2]']), { figure: '46 people', first: 1, second: 1 });
  assert.deepEqual(flags({ body: ['Brent fell 3.5% overnight. [E1]', 'Its 3.5% overnight slide erased the week. [E2]'] }), ['number_repeated']);
  assert.match(proseLintFindings({ body: ['It owes a $70 million bill. [E1]', 'The $70 million bill is due. [E2]'] })[0].message, /in paragraph 1 and again in paragraph 2.*state each figure once/u);
});

test('number_repeated: years, dates, clock times, citations, quotes, small numbers and different units pass', () => {
  assert.equal(repeatedFigure(['The 2026 budget passed. [E1]', 'The 2026 budget is law. [E2]']), undefined);
  assert.equal(repeatedFigure(['In 2026 the vote fell on 12 October. [E1]', 'The 2026 count closed on October 12 at 18:00. [E2] By 18:00 it was over. [E3]']), undefined);
  assert.equal(repeatedFigure(['Three ships and 3 crews left. [E1]', 'Three ships returned. [E2]']), undefined);
  assert.equal(repeatedFigure(['"We will be delaying the 10 until we are sure," he said. [E1] The FAA will delay the 10 until it is satisfied. [E2]']), undefined);
  assert.equal(repeatedFigure(['It held 25 seats. [E1]', 'It needed 25 more votes. [E2]']), undefined);
});

test('outlet_unnamed: a statement given to an outlet must name the outlet at or before the sentence citing it', () => {
  const box = [relay('The carrier left San Diego on Sunday, a US official told Al Jazeera.')];
  assert.deepEqual(unnamedOutlet({ evidence_box: box, body: ['The carrier left San Diego on Sunday, a US official said. [E1]'] }), { outlet: 'Al Jazeera', row: 1, paragraph: 1 });
  assert.equal(unnamedOutlet({ evidence_box: box, body: ['A US official told Al Jazeera the carrier left on Sunday. [E1]'] }), undefined);
  assert.equal(unnamedOutlet({ evidence_box: box, body: ['Al Jazeera, citing a US official, reported the sailing. [E1]', 'The same official said Marines followed. [E1]'] }), undefined);
  assert.equal(unnamedOutlet({ evidence_box: box, body: ['The carrier is the third in the region. [E1]'] }), undefined, 'a sentence reporting no statement is not an attribution');
  assert.deepEqual(flags({ evidence_box: box, body: ['The carrier left on Sunday, an official said. [E1]'] }), ['unnamed_speaker', 'outlet_unnamed']);
  assert.match(proseLintFindings({ evidence_box: box, body: ['The carrier sailed, the Pentagon said. [E1]'] })[0].message, /\[E1\], which an official gave to Al Jazeera, without naming Al Jazeera/u);
});

test('relay outlets: the outlet that obtained the statement, not a venue or a possessive country', () => {
  assert.deepEqual(relayOutlets(relay("Nuñez told France's TF1 television network. He told the Associated Press; she said in an interview with the BBC.")), ['TF1', 'Associated Press', 'BBC']);
  assert.deepEqual(relayOutlets(relay('The minister told Parliament and told the Senate; she told reporters.')), []);
});

test('every new attribution check is advisory: validate_article warns, it never refuses', () => {
  const findings = articleFormatFindings({ body: ['A US official said 27 people died. [E1] Police counted 27 people dead. [E1]'] }, { profile: 'archive' });
  const codes = findings.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('unnamed_speaker') && codes.includes('number_repeated'), codes.join());
  assert.equal(findings.errors.some((error) => ['unnamed_speaker', 'number_repeated', 'outlet_unnamed'].includes(error.code)), false);
});

// Every archived article passed Spike, so a hit here is a false-positive
// candidate. The counts are the calibration the header of attribution-lint.mjs
// reports; a change that moves them must say why there.
test('calibration against the published archive', () => {
  const editions = new URL('../content/editions/', import.meta.url), hits = { speaker: [], number: 0, outlet: [] };
  let read = 0;
  for (const date of readdirSync(editions).sort()) {
    const dir = new URL(`${date}/articles/`, editions);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const article = JSON.parse(readFileSync(new URL(file, dir), 'utf8')), body = (article.body ?? []).filter((value) => typeof value === 'string');
      read++;
      if (unnamedSpeakerStatement(body)) hits.speaker.push(`${date}/${file}`);
      if (repeatedFigure(body)) hits.number++;
      if (unnamedOutlet(article)) hits.outlet.push(`${date}/${file}`);
    }
  }
  assert.ok(read >= 492, `expected the archive, read ${read}`);
  assert.ok(hits.speaker.length <= 4, `unnamed role/pronoun fires on ${hits.speaker.length}: ${hits.speaker.join(', ')}`);
  assert.ok(hits.number <= 65, `number_repeated fires on ${hits.number}`);
  assert.deepEqual(hits.outlet, []);
});
