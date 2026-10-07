// Summary fidelity: a front-page or tape summary may only restate what its
// source article states.
//
// 2026-10-05: the Flashpoint Index row for Banja Luka read "Dodik declared an
// SNSD sweep at the Friday rally in Banja Luka". The article dated the
// declaration Sunday; the Friday rally was where he said Bosnia "is dead". The
// summary fused two events and moved one onto the other's day. Every word in
// it was somewhere in the article, which is why a presence check alone would
// not have caught it.
//
// Two checks, both mechanical and both pure (no filesystem, no clock):
//
// 1. PRESENCE. Every weekday, relative day word (today, yesterday, tonight,
//    tomorrow), explicit date (4 October, Oct 4) and number in the summary
//    must appear in the source text. A summary cannot introduce a day, a
//    date or a figure its article never printed.
// 2. BINDING. For each clause of the summary that carries a weekday or date,
//    the clause's content words must not be words the article only ever uses
//    in sentences dated to a DIFFERENT day. "declared" sits beside "Sunday" in
//    the article and never beside "Friday", so "declared ... Friday" is a
//    fused event.
//
// What binding does not catch: a misattributed event whose verb never appears
// in any dated sentence of the article, a paraphrase that swaps the verb for a
// synonym, and fusions that keep each day but swap places or actors. It is a
// tripwire on the common failure, not a reader.

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const RELATIVE = ['today', 'yesterday', 'tomorrow', 'tonight'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALIASES = new Map(MONTHS.flatMap((name, i) => [[name, i], [name.slice(0, 3), i]]).concat([['sept', 8]]));
const MONTH_RE = [...MONTH_ALIASES.keys()].sort((a, b) => b.length - a.length).join('|');
const DATE_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\b|\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'giu');
const NUMBER_RE = /\d+(?:[.,]\d+)*(?::\d\d)?/gu;

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// Words that carry no event: they sit in every dated sentence and binding on
// them would refuse ordinary prose.
const STOP = new Set(('a an and are as at be been before after but by for from had has have he her his in into is it its '
  + 'of on or our over said says say saying she that the their them then there these they this those to told under up was '
  + 'were what when where which while who will with would could should than also more most some still only about against '
  + 'between during since until through across first last next night morning evening week weeks day days later earlier '
  + 'already been being because each other such one two three four five six seven eight nine ten per cent percent '
  + 'last least near nearly about around while within without whose'
).split(' '));

const lower = (text) => String(text ?? '').toLowerCase();
const stripMarkers = (text) => String(text ?? '').replace(/\[E\d+\]/gu, ' ');

function numberWords(text) {
  const out = [];
  const re = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](one|two|three|four|five|six|seven|eight|nine))?\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gu;
  for (const match of lower(text).matchAll(re)) {
    if (match[1]) out.push(String(TENS.indexOf(match[1]) * 10 + (match[2] ? UNITS.indexOf(match[2]) : 0)));
    else out.push(String(UNITS.indexOf(match[3])));
  }
  return out;
}

const normalNumber = (raw) => raw.replace(/,(?=\d{3}\b)/gu, '').replace(/^0+(?=\d)/u, '');

function dates(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(DATE_RE)) {
    const day = Number(match[1] ?? match[4]);
    const monthWord = lower(match[2] ?? match[3]);
    // "may" is a modal verb far more often than a month; only a day number
    // beside it makes it a date, which DATE_RE already requires.
    out.push(`${day} ${MONTHS[MONTH_ALIASES.get(monthWord)]}`);
  }
  return out;
}

/** The checkable tokens in one piece of text. */
export function temporalTokens(text) {
  const words = lower(stripMarkers(text)).match(/[a-z]+/gu) ?? [];
  const dated = dates(text);
  const numbers = (stripMarkers(text).replace(DATE_RE, ' ').match(NUMBER_RE) ?? []).map(normalNumber);
  return {
    weekdays: [...new Set(words.filter((w) => WEEKDAYS.includes(w)))],
    relative: [...new Set(words.filter((w) => RELATIVE.includes(w)))],
    dates: [...new Set(dated)],
    numbers: [...new Set(numbers)],
  };
}

// "U.S." and "Gen." end in a full stop without ending the sentence.
const ABBREVIATION = /(?:\b[A-Z]|\b(?:Mr|Mrs|Ms|Dr|St|No|Gen|Lt|Col|Sen|Rep|Gov|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec))\.$/u;
function sentences(text) {
  const out = [];
  for (const piece of stripMarkers(text).split(/(?<=[.!?])["”’)]?\s+(?=["“‘(]?[A-Z0-9])/u)) {
    if (out.length > 0 && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
const clauses = (text) => sentences(text).flatMap((s) => s.split(/;|,\s+(?:and|while|after|before|as|but|when)\s+|\s+(?:and|while|after|before|but|when)\s+/u)).map((s) => s.trim()).filter(Boolean);
const stem = (word) => word.replace(/(?:ing|ed|es|s)$/u, '');
// Event words are the lower-case ones. A name (Dodik, Eritrean, Hormuz) recurs
// across every event in a story and binds to none of them.
const eventWords = (text) => (String(text ?? '').match(/(?<![\p{L}'-])[a-z][a-z'-]+/gu) ?? []);
const contentWords = (text, events = false) => [...new Set((events ? eventWords(text) : (lower(text).match(/[a-z][a-z'-]+/gu) ?? []))
  .filter((w) => w.length >= 4 && !STOP.has(w) && !WEEKDAYS.includes(w) && !RELATIVE.includes(w) && !MONTH_ALIASES.has(w))
  .map(stem))];
// Binding runs on weekdays only. Measured over every shipped edition, a date
// anchor binds badly: an article names a deadline, a filing date and a
// ceremony date around the same nouns, and dates refused correct summaries
// where weekdays did not.
const anchorsOf = (text) => temporalTokens(text).weekdays.map((w) => ['day', w]);

/** The source text of an article that a summary may restate. */
export function articleSourceText(article) {
  if (!article || typeof article !== 'object') return '';
  const body = (Array.isArray(article.body) ? article.body : []).filter((p) => typeof p === 'string');
  const numbers = (Array.isArray(article.key_numbers) ? article.key_numbers : []).map((k) => `${k?.label ?? ''} ${k?.value ?? ''}`);
  const confidence = article.confidence ? `${article.confidence.label ?? ''} ${article.confidence.value ?? ''}` : '';
  const dissent = article.dissent ? JSON.stringify(article.dissent) : '';
  return [article.kicker, article.headline, article.deck, ...body, ...numbers, confidence, dissent, article.next_update_utc].filter((v) => typeof v === 'string' && v).join('\n');
}

const proseOf = (article) => [article?.deck, ...((Array.isArray(article?.body) ? article.body : []).filter((p) => typeof p === 'string'))].filter(Boolean).join('\n');

// A probability is printed both ways: 0.58 on the ledger, 58% in the prose.
const numberForms = (numbers) => numbers.flatMap((n) => {
  const value = Number(n);
  if (!Number.isFinite(value) || n.includes(':')) return [n];
  const forms = [n, n.replace(/\.0+$/u, '')];
  if (value > 0 && value < 1) forms.push(String(Math.round(value * 1000) / 10));
  if (value > 0 && value <= 100) forms.push(String(Math.round(value * 10) / 1000));
  return forms;
});

function calendar(edition) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(edition ?? '')) return null;
  const at = (offset) => { const d = new Date(`${edition}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return { day: WEEKDAYS[(d.getUTCDay() + 6) % 7], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }; };
  return { year: edition.slice(0, 4), today: at(0), tonight: at(0), yesterday: at(-1), tomorrow: at(1) };
}

/**
 * Every way `summary` says something its sources do not. Empty means it holds.
 *
 * `articles` are the source articles (their prose is used for binding);
 * `extra` is further text the summary may draw tokens from, such as Ledger's
 * rows. `strict` turns on the presence checks; without it only binding runs,
 * which is what a desk item that may also carry a running thread gets.
 * `edition` lets "today" and "yesterday" match the date they stand for.
 */
export function summaryFindings(summary, { articles = [], extra = [], strict = true, edition } = {}) {
  const findings = [];
  if (strict) {
    const source = [...articles.map(articleSourceText), ...extra.map(String)].join('\n');
    const have = temporalTokens(source);
    const cal = calendar(edition);
    const haveNumbers = new Set(numberForms([...have.numbers, ...numberWords(source), ...have.dates.map((d) => d.split(' ')[0]), ...(cal ? [cal.year] : [])]));
    const want = temporalTokens(summary);
    for (const day of want.weekdays) if (!have.weekdays.includes(day)) findings.push(`says "${cap(day)}" but the article never does — use the day the article gives the event, or none`);
    for (const word of want.relative) {
      const means = cal?.[word];
      if (have.relative.includes(word) || (means && (have.weekdays.includes(means.day) || have.dates.includes(means.date)))) continue;
      findings.push(`says "${word}" but the article never puts the event ${means ? `on ${cap(means.day)}, ${means.date}` : 'on that day'} — name the day the article names`);
    }
    for (const date of want.dates) if (!have.dates.includes(date)) findings.push(`gives the date "${date}" but the article never does`);
    for (const number of want.numbers) if (!numberForms([number]).some((form) => haveNumbers.has(form))) findings.push(`carries the number ${number}, which the article does not print — copy figures from the article, never compute or recall them`);
  }

  const dated = articles.flatMap((article) => sentences(proseOf(article))).map((s) => ({ anchors: anchorsOf(s), words: new Set(contentWords(s)) })).filter((s) => s.anchors.length > 0);
  const has = (sentence, [kind, value]) => sentence.anchors.some(([k, v]) => k === kind && v === value);
  for (const clause of clauses(summary)) {
    const anchors = anchorsOf(clause);
    if (anchors.length !== 1) continue;
    const [anchor] = anchors;
    const same = dated.filter((s) => has(s, anchor));
    if (same.length === 0) continue;
    const other = dated.filter((s) => !has(s, anchor) && s.anchors.some(([kind]) => kind === anchor[0]));
    for (const word of contentWords(clause, true)) {
      if (same.some((s) => s.words.has(word))) continue;
      const elsewhere = other.find((s) => s.words.has(word));
      if (!elsewhere) continue;
      const theirs = elsewhere.anchors.filter(([kind]) => kind === anchor[0]).map(([, value]) => cap(value)).join('/');
      findings.push(`ties "${word}…" to ${cap(anchor[1])}, but the article puts that on ${theirs} — two events were merged; keep each event with its own day and place`);
      break;
    }
  }
  return findings;
}

const cap = (word) => word.replace(/^[a-z]/u, (c) => c.toUpperCase());

const isStr = (v) => typeof v === 'string' && v.length > 0;
const bylined = (articles, agent) => Object.values(articles).filter((a) => Array.isArray(a?.byline?.agents) && a.byline.agents.includes(agent));

/**
 * Every summary in a decision record checked against the article it restates.
 *
 * A Flashpoint Index note or an art caption tied to a slug restates that one
 * article and gets every check. A Briefly item or a slug-less
 * flashpoint names only an agent, and may legitimately carry a running thread
 * from an earlier edition, so it is held to binding against that agent's
 * articles today: it may not move one of today's events onto another day.
 */
export function decisionSummaryFindings(decisions, articles, { edition, extra = [] } = {}) {
  const out = [];
  const check = (where, text, sources, strict) => {
    if (!isStr(text) || sources.length === 0) return;
    for (const finding of summaryFindings(text, { articles: sources, extra, strict, edition })) out.push(`${where} ${JSON.stringify(text)} ${finding}`);
  };
  for (const [i, row] of (Array.isArray(decisions?.flashpoints) ? decisions.flashpoints : []).entries()) {
    const linked = isStr(row?.article) && articles[row.article];
    check(`flashpoints[${i}].note`, row?.note, linked ? [articles[row.article]] : bylined(articles, row?.agent), Boolean(linked));
  }
  for (const [slug, choice] of Object.entries(decisions?.art ?? {}))
    if (articles[slug]) check(`art["${slug}"].caption`, choice?.caption, [articles[slug]], true);
  for (const [where, desks] of [['briefly', decisions?.briefly], ['tape.briefly', decisions?.tape?.briefly]])
    for (const [i, desk] of (Array.isArray(desks) ? desks : []).entries())
      for (const [j, item] of [desk?.lead, ...(Array.isArray(desk?.rest) ? desk.rest : [])].entries())
        check(`${where}[${i}].${j === 0 ? 'lead' : `rest[${j - 1}]`}.what`, item?.what, bylined(articles, item?.agent), false);
  return out;
}
