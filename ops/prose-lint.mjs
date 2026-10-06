// The prose warnings, in one place.
//
// They used to live only inside ops/validate-content.mjs, which runs at
// stage_release — 16:00, two hours after Spike has already passed the piece at
// 14:00 and long after the reporter's wake ended. Nobody has ever read one:
// the `openers` warning fired on five of six filings in the 2026-09-05 edition
// and reached no agent at all, because by the time it prints, the only reader
// left is the press.
//
// Nothing here is a gate. These are advisory, and they stay advisory: the
// point of moving them is that the reporter and the editor see them while
// either of them can still act, not that a filing starts getting refused for
// an em dash. ops/validate-content.mjs keeps calling exactly these functions,
// so the warning a reporter reads at 12:00 is the warning the validator would
// have printed at 16:00 — one implementation, no drift.
//
// Pure: no clock, no disk, no network, no I/O of any kind. That is what lets
// the same code run inside file_article, inside the edition INDEX build, and
// inside the release validator.

/**
 * Three or more consecutive paragraphs opening on the same word. The composer's
 * default reflex is to start everything with "The"; monotonous openers read as
 * a wall, not a newspaper.
 *
 * Returns `{ word, run, paragraph }` for the first such run (`paragraph` is
 * 1-based), or undefined.
 */
export function consecutiveOpenerRun(paragraphs) {
  const openers = paragraphs.map((value) => (String(value).trim().match(/^[“"”']?([A-Za-z]+)/u) || [])[1] || '');
  for (let index = 0; index + 2 < openers.length; index++) {
    const word = openers[index].toLowerCase();
    if (!word || openers[index + 1].toLowerCase() !== word || openers[index + 2].toLowerCase() !== word) continue;
    let run = 3;
    while (openers[index + run]?.toLowerCase() === word) run++;
    return { word: openers[index], run, paragraph: index + 1 };
  }
  return undefined;
}

/**
 * The "X, not Y" / "not X, it's Y" binary-contrast reflex — a machine tic the
 * headline and deck over-reach for. Fine once; flagged so it does not become
 * the house formula.
 */
const BINARY_CONTRAST = /,\s*not\s|\bnot\b[^.]{0,40}\b(?:but|it['’]?s|its)\b|\bno longer\b|\bisn['’]?t\b[^.]{0,30}\bit['’]?s\b/iu;
export const hasBinaryContrastReflex = (headline, deck) => BINARY_CONTRAST.test(`${typeof headline === 'string' ? headline : ''} ${typeof deck === 'string' ? deck : ''}`.replace(/\n/gu, ' '));

/**
 * Em dashes as a default connector are a loud AI tell. Flags overuse — more
 * than one per roughly two paragraphs, minimum three — never the occasional
 * deliberate one. Returns `{ dashes, paragraphs }` or undefined.
 */
export function emDashOveruse(paragraphs) {
  const dashes = (paragraphs.join(' ').match(/—/gu) || []).length;
  return dashes >= 3 && dashes * 2 > paragraphs.length ? { dashes, paragraphs: paragraphs.length } : undefined;
}

/**
 * A change between two percentages written as "%" instead of percentage
 * points: "turnout was 42%, down by about 8% from about 50%". Flags a sentence
 * that carries two or more percentages and a "down/up/fell/rose... by N%"
 * change. Heuristic and advisory: a growth rate beside a share ("revenue rose
 * by 8%; margins held at 30%") also trips it, which is why it only warns.
 * Returns `{ phrase }` for the first such sentence, or undefined.
 */
const PERCENT = /\d(?:[\d,]*\d)?(?:\.\d+)?\s*%/gu;
const CHANGE_BY_PERCENT = /\b(?:down|up|fell|rose|dropped|declined|decreased|increased|climbed|slipped|grew|gained|lost|jumped|slid|sank|shrank)\s+by\s+(?:about\s+|around\s+|roughly\s+|nearly\s+|almost\s+|some\s+|more\s+than\s+|less\s+than\s+)?\d+(?:\.\d+)?\s*%/iu;
export function percentagePointSlip(texts) {
  for (const text of texts) {
    for (const sentence of String(text).split(/(?<=[.!?;])\s+/u)) {
      const change = sentence.match(CHANGE_BY_PERCENT);
      if (change && (sentence.match(PERCENT) || []).length >= 2) return { phrase: change[0] };
    }
  }
  return undefined;
}

/**
 * A statement attributed to someone the copy does not name: "a woman told the
 * German press agency", "a man said", "an unnamed speaker", "a speaker". On
 * 2026-10-06 a quote by Sahra Wagenknecht, founder of the BSW, ran as "A woman
 * told the German press agency", and a Yemen piece quoted "an unnamed speaker"
 * though its source named him. Advisory: an anonymous source the source itself
 * did not name is legitimate, so the reporter keeps it and says so. Returns
 * `{ phrase }` for the first match, or undefined.
 */
const UNNAMED_SPEAKER = [
  /\b(?:[Aa]n?|[Oo]ne|[Aa]nother)\s+(?:woman|man|person|speaker|participant|attendee)\s+(?:told|said|says|added|argued|warned|wrote|stated|claimed|insisted|asked|explained)\b/u,
  /\b(?:[Aa]n?\s+)?(?:unnamed|unidentified)\s+(?:speaker|woman|man|person)\b/u,
  /\b[Aa]n?\s+speaker\b/u
];
export function unnamedSpeaker(texts) {
  for (const text of texts) for (const pattern of UNNAMED_SPEAKER) { const match = String(text).match(pattern); if (match) return { phrase: match[0] }; }
  return undefined;
}

/**
 * A closing "decisive test": the final paragraph claims some piece of evidence
 * "would settle which reading is true" or "would show whether …". On
 * 2026-10-06 the Hearth piece ended "a pathogen or a second confirmed illness
 * would settle which reading is true", and neither would. Advisory: a test that
 * really separates the readings is good reporting, so Spike judges it; the
 * flag only makes sure he looks. Fires on 2 of 488 archived final paragraphs.
 * Returns `{ phrase }` or undefined.
 */
const DECISIVE_TEST = [
  /\bwould\s+(?:settle|decide|resolve|determine|prove|show|tell(?:\s+us)?)\s+(?:which|whether)\b/iu,
  /\bsettles?\s+which\s+reading\b/iu,
  /\bwhich\s+reading\s+is\s+(?:true|right|correct)\b/iu
];
export function decisiveTestClaim(paragraphs) {
  const last = paragraphs.length > 0 ? String(paragraphs[paragraphs.length - 1]) : '';
  for (const pattern of DECISIVE_TEST) { const match = last.match(pattern); if (match) return { phrase: match[0] }; }
  return undefined;
}

// The sentence each flag prints, whether it is read by a reporter at file time,
// by Spike at review time, or by the release validator. Written to the agent
// who can still fix it, so it names the article field and says what to do.
export const PROSE_LINT_MESSAGES = {
  openers_run: ({ word, run, paragraph }) => `${run} consecutive paragraphs open with "${word}" (para ${paragraph}+) — vary the openers`,
  binary_contrast: () => 'headline/deck leans on the "X, not Y" binary-contrast reflex — state the point directly, vary the form',
  em_dashes: ({ dashes, paragraphs }) => `${dashes} em dashes across ${paragraphs} paragraphs — the em dash as a default connector is an AI tell; prefer commas, colons or full stops`,
  pct_points: ({ phrase }) => `"${phrase}" sits beside other percentages — a change between two percentages is in percentage points ("down about 8 percentage points, from about 50% to 42%"), even if the source wrote "%"`,
  unnamed_speaker: ({ phrase }) => `"${phrase}" attributes a statement to someone the copy does not name — name the speaker and their role as the source does ("Sahra Wagenknecht, founder of the BSW, told dpa"); keep it anonymous only when the source itself does not name them, and say so`,
  decisive_test: ({ phrase }) => `the final paragraph says "${phrase}" — name a test only if its result would differ under each reading the piece presents, and end on what the piece established rather than a test or implication it did not develop`
};

/**
 * Every prose warning one article earns, as `{ flag, detail, message }`.
 *
 * `flag` is the stable machine name (it rides the edition INDEX F row and the
 * filing record); `message` is the sentence an agent reads.
 */
export function proseLintFindings(article) {
  const paragraphs = (Array.isArray(article?.body) ? article.body : []).filter((value) => typeof value === 'string');
  const findings = [];
  const run = consecutiveOpenerRun(paragraphs);
  if (run) findings.push({ flag: `openers_run:${run.word.toLowerCase()}×${run.run}`, detail: run, message: PROSE_LINT_MESSAGES.openers_run(run) });
  if (hasBinaryContrastReflex(article?.headline, article?.deck)) findings.push({ flag: 'binary_contrast', detail: {}, message: PROSE_LINT_MESSAGES.binary_contrast() });
  const dashes = emDashOveruse(paragraphs);
  if (dashes) findings.push({ flag: `em_dashes:${dashes.dashes}/${dashes.paragraphs}`, detail: dashes, message: PROSE_LINT_MESSAGES.em_dashes(dashes) });
  const slip = percentagePointSlip([article?.headline, article?.deck, ...paragraphs].filter((value) => typeof value === 'string'));
  if (slip) findings.push({ flag: 'pct_points', detail: slip, message: PROSE_LINT_MESSAGES.pct_points(slip) });
  const speaker = unnamedSpeaker([article?.headline, article?.deck, ...paragraphs].filter((value) => typeof value === 'string'));
  if (speaker) findings.push({ flag: 'unnamed_speaker', detail: speaker, message: PROSE_LINT_MESSAGES.unnamed_speaker(speaker) });
  const decisive = decisiveTestClaim(paragraphs);
  if (decisive) findings.push({ flag: 'decisive_test', detail: decisive, message: PROSE_LINT_MESSAGES.decisive_test(decisive) });
  return findings;
}
