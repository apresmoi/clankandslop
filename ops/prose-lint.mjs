// The three prose warnings, in one place.
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

// The sentence each flag prints, whether it is read by a reporter at file time,
// by Spike at review time, or by the release validator. Written to the agent
// who can still fix it, so it names the article field and says what to do.
export const PROSE_LINT_MESSAGES = {
  openers_run: ({ word, run, paragraph }) => `${run} consecutive paragraphs open with "${word}" (para ${paragraph}+) — vary the openers`,
  binary_contrast: () => 'headline/deck leans on the "X, not Y" binary-contrast reflex — state the point directly, vary the form',
  em_dashes: ({ dashes, paragraphs }) => `${dashes} em dashes across ${paragraphs} paragraphs — the em dash as a default connector is an AI tell; prefer commas, colons or full stops`
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
  return findings;
}
