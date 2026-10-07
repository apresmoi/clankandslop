import test from 'node:test';
import assert from 'node:assert/strict';
import { articleHref, clock, deadlinesBlock, keyFiguresBlock, statedTime, FIGURE_VALUE_MAX } from './tape-blocks.mjs';
import { KEY_NUMBERS } from './article-format.mjs';
import { followUps, ledgerHistory } from './open-clocks.mjs';

const EDITION = '2026-10-06';
const agents = new Set(['Foreman', 'Vesta', 'Graves', 'Sprockett']);
const story = (id, over = {}) => ({ id, section: 'world', kicker: `Kicker ${id}`, headline: `Headline ${id}`, byline: { desk: 'Desk', agents: ['Graves'] }, key_numbers: [], ...over });
const figs = (...values) => values.map((value, i) => ({ label: `Label ${value}`, value, dir: ['up', 'down', 'flat'][i % 3] }));

test('Today\'s Numbers follows the edition\'s order, three stories with figures, three figures each', () => {
  const articles = {
    lead: story('lead', { key_numbers: figs('1', '2', '3', '4') }),
    bare: story('bare'),
    second: story('second', { key_numbers: figs('5', '6') }),
    third: story('third', { kicker: '', section: 'markets', key_numbers: figs('7', '8', '9') }),
    fourth: story('fourth', { key_numbers: figs('10', '11') }),
  };
  const block = keyFiguresBlock({ edition: EDITION, order: ['lead', 'bare', 'second', 'third', 'fourth'], articles });
  assert.equal(block.block, 'KeyFigures');
  assert.equal(block.props.title, "Today's Numbers");
  assert.deepEqual(block.props.groups.map((g) => [g.kicker, g.headline, g.href, g.figures.map((f) => f.value)]), [
    ['Kicker lead', 'Headline lead', '/editions/2026-10-06/articles/lead/', ['1', '2', '3']],
    ['Kicker second', 'Headline second', '/editions/2026-10-06/articles/second/', ['5', '6']],
    ['markets', 'Headline third', '/editions/2026-10-06/articles/third/', ['7', '8', '9']],
  ]);
  // Order is the record's, not the slugs' alphabet.
  const reversed = keyFiguresBlock({ edition: EDITION, order: ['fourth', 'third', 'second', 'lead'], articles });
  assert.deepEqual(reversed.props.groups.map((g) => g.headline), ['Headline fourth', 'Headline third', 'Headline second']);
});

test('figures are copied verbatim, with dir only when the writer filed one', () => {
  const key_numbers = [{ label: 'Slots from 4 Sep', value: '34/day', dir: 'down' }, { label: 'Issue price', value: '¥150.80' }];
  const block = keyFiguresBlock({ edition: EDITION, order: ['a'], articles: { a: story('a', { key_numbers }) } });
  assert.deepEqual(block.props.groups[0].figures, key_numbers);
  assert.notEqual(block.props.groups[0].figures[0], key_numbers[0], 'a copy, not the article\'s own object');
});

test('no story with key_numbers means no Today\'s Numbers block', () => {
  assert.equal(keyFiguresBlock({ edition: EDITION, order: ['a', 'b'], articles: { a: story('a'), b: story('b', { key_numbers: [{ label: 'x' }] }) } }), null);
});

const PRIOR = { date: '2026-10-05', articles: [
  story('s-late', { headline: 'Geffray suspends lessons', next_update_utc: '18:00', byline: { agents: ['Sprockett'] } }),
  story('s-early', { headline: 'He Called the Sweep', next_update_utc: '9:00', byline: { agents: ['Vesta'] } }),
  story('s-kept', { headline: 'Kept promise', next_update_utc: '12:00' }),
  story('s-none', { headline: 'No promise' }),
] };
const TODAY = {
  a: story('a', { headline: 'Mokha claimed', next_update_utc: '17:00', previous_coverage: [{ date: '2026-10-05', slug: 's-kept' }] }),
  b: story('b', { headline: 'ATR-42 down', next_update_utc: '15:30', byline: { agents: ['Brass'] } }),
};

test('owed rows come from the prior edition\'s unkept promises, linked to the story', () => {
  const owed = followUps(PRIOR, TODAY);
  assert.deepEqual(owed, [
    { edition: '2026-10-05', time: '18:00', headline: 'Geffray suspends lessons', article: 's-late', who: 'Sprockett' },
    { edition: '2026-10-05', time: '9:00', headline: 'He Called the Sweep', article: 's-early', who: 'Vesta' },
  ]);
  const { props } = deadlinesBlock({ edition: EDITION, owed, agents });
  assert.equal(props.title, 'The Deadlines');
  assert.equal(props.owed_from, '2026-10-05');
  assert.deepEqual(props.owed, [
    { time: '09:00', headline: 'He Called the Sweep', href: '/editions/2026-10-05/articles/s-early/', who: 'Vesta' },
    { time: '18:00', headline: 'Geffray suspends lessons', href: '/editions/2026-10-05/articles/s-late/', who: 'Sprockett' },
  ], 'by clock, not by the text of the clock');
  assert.equal(props.dated, undefined);
});

const QUEBEC = 'Yes if Élections Québec awards the Parti Québécois 64 or more seats by 16:00 UTC on 12 October 2026.';
const BRAZIL = 'Yes if the TSE names Flávio Bolsonaro the winner of the 25 October 2026 runoff.';
const IRAN = 'U.S. and Iranian negotiators hold an announced session in the week ending 4 October 2026, UTC';
const SETTLED = 'Alito remains off the bench for Suncor on 5 October 2026';
const call = (id, label, value, date, over = {}) => story(id, { headline: `Call ${id}`, byline: { agents: ['Foreman'] }, confidence: { label, value }, edition_date: date, ...over });

test('dated rows: every open call due today or later, by date then time — today\'s own next checks are not listed', () => {
  const history = ledgerHistory([
    { date: '2026-09-30', settlements: [], articles: [call('s-iran', IRAN, 0.52, '2026-09-30'), call('s-alito', SETTLED, 0.78, '2026-09-30')] },
    { date: '2026-10-05', settlements: [{ call: SETTLED, outcome: 'hit', prior_p: 0.78 }], articles: [call('s-brazil', BRAZIL, 0.58, '2026-10-05')] },
    { date: EDITION, settlements: [{ call: 'A row-only call with no article on 12 October', outcome: 'open', prior_p: 0.4 }], articles: [call('s-quebec', QUEBEC, 0.28, EDITION)] },
  ]);
  const { props } = deadlinesBlock({ edition: EDITION, articles: TODAY, calls: history, agents });
  assert.deepEqual(props.dated, [
    { date: '2026-10-12', time: '16:00', what: 'Call s-quebec', who: 'Foreman' },
    { date: '2026-10-12', what: 'A row-only call with no article on 12 October' },
    { date: '2026-10-25', what: 'Call s-brazil', who: 'Foreman' },
  ], 'today\'s next checks fall due as tomorrow\'s owed rows, not here; the due Iran call and the settled Alito call stay off; untimed rows follow timed ones');
  assert.equal(props.owed, undefined);
  assert.equal(props.owed_from, undefined);
});

test('a call due today is a deadline today; settled calls and a repeated call do not print', () => {
  const calls = [
    { call: 'IEA posts a schedule by 16:00 UTC on 6 October 2026', outcome: 'open', deadline: EDITION, owner: 'Foreman', headline: 'IEA clock' },
    { call: 'IEA  posts a schedule by 16:00 UTC on 6 October 2026', outcome: 'open', deadline: EDITION, owner: 'Foreman', headline: 'IEA clock' },
    { call: 'Yesterday by 5 October', outcome: 'open', deadline: '2026-10-05', owner: 'Foreman' },
    { call: 'No date at all', outcome: 'open', deadline: null, owner: 'Foreman' },
    { call: 'Settled early, due 9 October', outcome: 'hit', deadline: '2026-10-09', owner: 'Foreman' },
    { call: 'Withdrawn, due 9 October', outcome: 'cancelled', deadline: '2026-10-09', owner: 'Foreman' },
  ];
  assert.deepEqual(deadlinesBlock({ edition: EDITION, calls, agents }).props.dated, [{ date: EDITION, time: '16:00', what: 'IEA clock', who: 'Foreman' }]);
});

test('nothing owed and nothing dated means no Deadlines block', () => {
  assert.equal(deadlinesBlock({ edition: EDITION }), null);
  assert.equal(deadlinesBlock({ edition: EDITION, owed: followUps({ date: '2026-10-05', articles: [story('x')] }), articles: { a: story('a', { next_update_utc: 'later' }) } }), null);
});

test('clocks are normalised and a call\'s stated time is read off its wording', () => {
  assert.equal(clock('9:05'), '09:05');
  assert.equal(clock(' 17:00 '), '17:00');
  assert.equal(clock('24:00'), undefined);
  assert.equal(clock('17:00 UTC'), undefined);
  assert.equal(statedTime('by 16:00 UTC on 12 October', '2026-10-12'), '16:00');
  assert.equal(statedTime('by 12 October', '2026-10-12'), undefined);
  assert.equal(statedTime('on 12 October at 9:30 UTC', '2026-10-12'), '09:30', 'a clock after its date');
  assert.equal(articleHref('2026-10-05', 's-1'), '/editions/2026-10-05/articles/s-1/');
});

test('a deadline takes the clock written beside ITS date, never the first clock in the call', () => {
  // Review 2026-10-07: this call printed "8 Oct 09:00", the start time of the talks.
  const call = 'Yes if talks beginning at 09:00 UTC on 7 October 2026 produce a signed agreement by 18:00 UTC on 8 October 2026; otherwise NO.';
  assert.equal(statedTime(call, '2026-10-08'), '18:00');
  assert.equal(statedTime(call, '2026-10-07'), '09:00');
  assert.equal(statedTime('Talks at 09:00 UTC on 7 October produce a deal by 8 October', '2026-10-08'), undefined, 'no clock beside the deadline: none printed');
});

test('two different calls under one headline and deadline are two rows', () => {
  // Review 2026-10-07: "Talks resume" for a ceasefire and for aid deliveries printed once.
  const calls = [
    { call: 'Yes if a ceasefire is signed by 18:00 UTC on 8 October 2026', outcome: 'open', deadline: '2026-10-08', owner: 'Foreman', headline: 'Talks resume' },
    { call: 'Yes if aid deliveries resume by 18:00 UTC on 8 October 2026', outcome: 'open', deadline: '2026-10-08', owner: 'Vesta', headline: 'Talks resume' },
  ];
  assert.deepEqual(deadlinesBlock({ edition: EDITION, calls, agents }).props.dated.map((r) => [r.time, r.what, r.who]), [['18:00', 'Talks resume', 'Foreman'], ['18:00', 'Talks resume', 'Vesta']]);
});

test('a figure too long for the column is skipped, never cut off; a story left with none gives way to the next', () => {
  // 2026-10-07 articles were filed before the key_numbers limits.
  const articles = {
    ship: story('ship', { kicker: 'Shipbuilding', key_numbers: [{ label: 'Private investment', value: '$3.7 billion' }, { label: 'Jobs expected', value: 'over 14,000' }] }),
    vote: story('vote', { kicker: 'State parliament', key_numbers: [{ label: 'Yes votes', value: '48' }, { label: 'Turnout', value: 'about 44%' }, { label: 'Seats', value: '1234567890' }] }),
  };
  const { groups } = keyFiguresBlock({ edition: EDITION, order: ['ship', 'vote'], articles }).props;
  assert.deepEqual(groups.map((g) => [g.kicker, g.figures.map((f) => f.value)]), [['State parliament', ['48', 'about 44%', '1234567890']]]);
});

test('the Tape skips exactly what filing refuses', () => {
  assert.equal(FIGURE_VALUE_MAX, KEY_NUMBERS.value);
});
