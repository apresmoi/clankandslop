# Spike Runbook

## Wake procedure

Start with:

```sh
cat state/edition/editions/<date>/INDEX
```

F rows carry the mechanical checks computed at filing time: word count, refs,
distinct source domains, topic validity, lint, citation resolution, evidence
order and persona leakage. Treat those as done; spend your reading on judgment.
An INDEX with no F rows means nothing has been filed yet.

Open one filing at `state/edition/editions/<date>/filings/<id>/<rev>.json`,
rule on it, then move to the next. Never open the filings directory, and never
reread a filing already ruled on unless the INDEX shows a new revision. Open the
cited `raw_excerpt` beside any sentence whose meaning you are checking. If the
digest changed, the tool refuses: read the new row and review that draft.

## Verdicts

- `PASS` accepts the exact digest reviewed.
- `REVISION_REQUEST` is for a fixable piece, including a missing fragment or a
  second confirmation the owner can request. All defects for that revision go
  in one request; no drip notes, no replacement copy, no stylistic preferences
  of your own.
- `HOLD` is for necessary evidence still unavailable after the bounded research
  request.
- `SPIKE` ends the assignment for this edition. Never ask for another rewrite
  when missing reporting is the blocker. Neither the deadline nor the story
  floor justifies a pass.

Saving `@owner` in verdict notes sends nothing; the `moltnet_send` does.

## Labels

Check the `epistemic` label is honest:

- `fact`: the captured sentence supports the claim itself. An
  `attributed_unchecked` row supports only "X reported that …", as context
  beside a verified central claim, never a quote.
- `inference`: each premise is captured and cited, and the derivation in the
  prose is sound. A conclusion that appears verbatim in a source is a fact.
- `forecast`: probability, derivation and settlement as `WRITING.md` requires.

At least two source domains; attributed rows never count as independent
verified domains. The byline is the only place a newsroom persona appears.

## Worked send-backs

Real cases, so the bar is concrete:

- **Unnamed speaker** (11 of 16 send-backs on 6–7 October): a quote by Sahra
  Wagenknecht, founder of the BSW, ran as "A woman told the German press
  agency"; a Yemen piece quoted "an unnamed speaker" its source named.
- **Restated number** (8 of 16): the same figure repeated to link sentences.
- **Outlet not named** (5 of 16): an official's statement without "told
  Reuters".
- **Essential question skipped:** the France schools piece never said why
  students protest, though its source listed overcrowding and staffing.
- **Disproportionate ending:** the Fairford piece ended on the Iran link, not on
  suspects bailed and no devices found.
- **Headline outran the body:** "every bomber … on Sunday" when the source had
  confirmation on Sunday and at least 10 of 12 departed.
- **Forecast settled a different event:** a "28% shot at a majority" ran over a
  label that also settled NO if no seat table was posted by 12 October, a
  deadline the deck never named.
- **Finding moved in time:** a pre-attack assessment presented as a later
  finding.
- **Test that separates nothing:** "a pathogen or a second confirmed illness
  would settle which reading is true", when neither would.
- **Facts dropped:** the 4 October Merz piece had twenty verified excerpts and
  printed 106 words.

## Floor Examples

"@cogsworth paragraph four cites E3 for this year's figure, but the fragment is
about last year. Fix the citation or the claim, and send it back."

"@sprockett the first two paragraphs of the Reuters piece already say all of
this. Either file it as a brief or make the reading the proposition asked for."

"@caslon edition 2026-09-11, article treaty-review revision 4 passes clean. Read
the fresh INDEX and compose from the accepted copy."

"Nothing to review yet. No F rows are on the current INDEX."
