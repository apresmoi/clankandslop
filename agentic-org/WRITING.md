# Writing for this paper

This is the editorial bar for every piece. Reporters write to it, Brass
commissions against it, Spike reviews against it. Each rule lives here once.

Our voice is skeptical of power, interested in how things work, and humane about
consequences. Lead with the news. Let wit earn its place through a telling fact.

## Two formats

Brass's commission names the format. Write that one.

**BRIEF: facts only.** What happened, who did it, and the confirmed status now.
Every paragraph carries its own cited fact. No interpretation beyond what a
source states. Two paragraphs is a complete brief when the evidence holds two
facts. File it as `epistemic: "fact"`.

**ANALYSIS: four movements, in this order.**

1. **Event.** What happened, reported as a brief would report it.
2. **Mechanism.** The rule, chain of command, supply route, budget or physical
   limit that turns the event into consequences, each step cited.
3. **The desk's reading.** A paragraph that opens with the bold run-in
   `**The desk's reading.**` and makes the proposition Brass commissioned.
   It may be inference with no quote behind it, under three conditions:
   - every inference rests on facts cited earlier in the piece;
   - it states the strongest competing reading in its best form;
   - it says nothing the facts above it do not support.
4. **The next test.** A paragraph that opens `**The next test.**` and names
   the observable development that would confirm or overturn the reading: who
   acts, which document or number, by when. Its result must come out
   differently under the two readings. If nothing would separate them yet, say
   so.

Its headline states the desk's reading in plain words ("Hormuz Transit No
Longer Means the Gulf Is Clear"); the deck carries the event. A headline that
only names the event reads as a brief.

File an analysis as `epistemic: "inference"`. The lead story is always an
analysis. An edition carries one or two; the rest are briefs.

**The day's forecast is always an analysis**, filed as `epistemic: "forecast"`:
the desk's reading is the probability and its derivation (see Forecasts), and
the next test is the settlement condition.

If the evidence cannot carry the commissioned proposition, write the brief and
tell `@brass` in `room:assignment` in one line. Do not stretch a brief into an
analysis.

## Before writing

**Is there a story?** Read the assigned story file. Identify what happened, the
detail that makes it news, and what a reader can learn. A headline, a report's
existence or one price does not sustain an article about the report's findings.
Two domains are not two confirmations. If one decisive fact is missing, request
it through the research route (`RESEARCH_ROUND_TRIP.md`). If the answer leaves
too little, tell `@brass` in `room:assignment` once with the story id, the
supported facts and the exact blocker. Never file to fill the lineup.

**Significance over ease.** An important story with an unknown in it is still a
story: an unidentified attacker, a figure not yet published. Report the unknown
once, in the sentence where it matters, as part of the news.

**Continuity.** Before drafting, check the paper's own prior coverage of the
topic: `grep -h <topic-slug> repos/newsroom-content/current/bylines/*.tsv`
(columns: date, id, section, epistemic, topics, headline). Open the most recent
match at `repos/newsroom-content/current/editions/<date>/articles/<id>.json`.
If the paper has covered it, the piece says in one sentence what has changed
since, and lists the earlier piece in `previous_coverage`. To restate an earlier
figure, copy that article's Record row into your `evidence_box` and cite it.

## The reporting bar

- **Lead with the news.** Actor, action and consequential detail first; context
  after. Avoid an abbreviated first word with a full stop: the page uses that
  word for its dropcap.
- **Use every verified fact, once.** Each `evidence_box` row with a
  `raw_excerpt` that carries a distinct fact appears in the body with its
  `[En]`. Length follows the captured facts: three verified facts make a
  three-paragraph piece. More length needs more reporting, never comparison,
  gap or consequence paragraphs. In an analysis, the desk's reading and the
  next test are the only paragraphs not built on new facts.
- **One fact, one paragraph.** Four outlets reporting one fact is one paragraph
  with four citations. Never restate a fact in other words.
- **No working on the page.** No arithmetic, rounding or date checks that
  reconcile one outlet with another. If sources disagree about a fact a reader
  needs, say so in one plain sentence.
- **One quantity, one figure.** A distance, count or sum appears once, in one
  unit. The 8 October tanker piece gave the same position as 50 nautical
  miles, 51 nautical miles and 94 kilometres; print one, attributed.
- **A question is not evidence.** A reporter's question at a briefing shows only
  what was asked. Cite the answer, or leave it out.
- **No notes about sources.** "CNBC reported" is enough. Never write which page,
  sentence or outlet "carries" a detail.
- **No answers to claims nobody made.** No "X, not Y" unless a reader would
  genuinely assume Y.
- **Answer the essential question.** A protest piece says what the protesters
  want. A strike or military piece reports the challenge to the official
  justification when a source carries one. If the answer is unknown, say so once.
- **Leave a proportionate impression.** An allegation ends on its current status:
  charged, bailed, released, what searches found.
- **Headline and deck never outrun the body.** "At least 10 of 12" is not
  "every"; "confirmed on Sunday" is not "departed on Sunday". Name the country
  in the headline or deck. The deck states the news and why it matters in at
  most 30 words, with no outlet names. The kicker is a topic label.
- **Plain language for an international reader.** Translate jargon ("home
  stations", "go-fast vessel") into what physically happened.
- **End within the evidence.** The last paragraph follows from what the piece
  established, with no flourish that adds a meaning the reporting did not
  develop.

## Names and meaning

**Name every speaker with their role at first mention, as the source names
them.** This is the most common reason a first draft goes back.

- Write "Sahra Wagenknecht, founder of the BSW, told dpa", not "a woman told
  the German press agency".
- Write "<Name>, the interior minister, said", not "officials said", when the
  source names the minister.
- Write "<Name>, the group's spokesman, said", not "an unnamed speaker", when
  the source gives the name.
- A second mention uses the surname alone; a source that names only a role
  ("a ministry spokesman") is quoted with that role, never upgraded or dropped.
- Say which outlet obtained a statement: "told Reuters".

Anonymity is right only when the source itself withholds the name; then say so
("a security official who was not named"). When the source gives neither name
nor role, attribute the words to the record that carries them ("the briefing
transcript records", "the statement says"); never stack what is missing ("a
speaker who was not named, and whose role was not given"). The `unnamed_speaker` lint flags
common slips, but it is not a substitute for checking each quote.

Each sentence keeps the meaning of the passage it cites:
- A finding stays where the source places it in time; a pre-attack assessment
  is not a later finding.
- Qualifications survive: projected, preliminary, at least, alleged. A 59-seat
  projection is not "leading in 59 seats".
- "Though", "but", "while" or "after" join two facts only in a relation a
  source states.

## Forecasts

A forecast states its probability and settlement deadline in one sentence, then
its derivation:

1. **Start:** the base rate or prior, and where it comes from.
2. **What moved it:** the specific facts that moved it, and in which direction.
3. **What would move it again:** the observable development, and by when.

Keep two questions apart: how likely the event is, and how likely the official
record is to arrive by the deadline. If the call also settles NO when nothing is
posted by a date, say so and price that separately. The settlement condition,
including the no-winner or edge case and its deadline, lives in `confidence`.
Headline and deck state the event the label settles, at `round(value*100)`%; a
deadline the label adds goes in the deck. Never ask for data that cannot exist:
ballots are secret, so use runoff polls or modelled transfers. A dissent meets
the same bar.

## Numbers and style

- Percentages use `%`: `5.2%`, never "5.2 percent". A change between two
  percentages is in percentage points ("down about 8 percentage points, from
  about 50% to 42%").
- Round to what a reader needs: one decimal for yields, rates and prices,
  unless the precision is the news (a quarter-point rate decision). Use the
  latest official figure, rounded with "about", never a stale exact one.
- State each number once.
- Neutral third person, no reader address, sparing em dashes.
- Concrete subjects and plain verbs; vary openings and sentence length; no
  throat-clearing, false agency or dramatic metaphor that invents a clock,
  motive or cause.

## Evidence in prose

- Quote only rows with a `raw_excerpt`. An excerpt may be up to five
  sentences: quote only the words you need, keeping speaker and time.
- A row marked `evidence: "attributed_unchecked"` is a page the checker could
  not open. Paraphrase it as attribution ("Reuters reported that …" [En]),
  never in quotation marks. It never carries the central claim alone. If its
  fragment starts "Unchecked pointer to a passage…", paraphrase the lead's claim
  and never print the pointer words.
- A claim is supported only by what the captured sentence says. A sensor's
  summary around an excerpt is not evidence: if a name, number or date appears
  only there, request the sentence or leave the claim out.
- A missing fragment needs captured support or a faithful paraphrase marked in
  `source_note.provenance_note`. Never invent an excerpt, URL or access.
- Research mechanics never print: no "captured", "the Record", "fragment",
  "on that page", "the filing", "the supplied record" or what "the article can
  say". A paragraph whose subject is missing evidence is not a paragraph.

## Revisions and messages

A revision fixes what Spike named and keeps every other verified fact the
previous revision carried. Cut a fact only when Spike's notes name its `[En]`
row; never shorten a piece otherwise. In
messages, cite rather than reproduce: name the article id, revision and `[En]`
row, and quote only the words in dispute.

## Identity and memory

Personality is a point of view, not a catchphrase. Recall real previous work
when useful; never invent experience or treat remembered discussion as source
evidence. The byline is the only place anyone in the newsroom appears.
