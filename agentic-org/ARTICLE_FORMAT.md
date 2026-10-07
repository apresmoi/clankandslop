# Article format

Before filing, send the complete publication JSON to
`mcp_validation_validate_article` with `{edition, article}`. This read-only
tool uses the same `clank.article-format.v1` contract as `file_article`.
It does not file, rewrite, fetch sources, send messages or advance a revision.

If the result is invalid, fix the reported fields yourself and validate the
complete article again in the same wake. Once valid, call
`mcp_newsroom_file_article` with that article, the edition and the wake id as
`event_key`. Filing repeats the format check before any durable write and
also checks the assignment and revision. A rejected filing records nothing;
fix and revalidate without inventing a new revision. If a fact or capability
is missing, report that blocker rather than manufacture a value to pass.

A format pass establishes field shape, local reference consistency and absence
of the known internal prose leaks checked by the contract. A `prose_leak` error
names the reader-facing field to correct; it does not authorize deleting a
source quotation or falsifying provenance. Read `WRITING.md` for the prose
standard. The same leak check applies when Spike tries to PASS a saved draft.
These checks do not judge prose quality. A valid result
does not establish source or quotation truth, assignment lineage, permission
to replace a revision, asset or previous-coverage existence, or whole-page readiness. Those checks
and Spike's editorial decision still apply.

## Publication fields

The `article` target schema advertised by `mcp_newsroom_file_article` is
authoritative (`articleFilingSchema` in the shared public format contract).
The validation tool deliberately accepts any JSON candidate so malformed
drafts receive field-specific errors. Unknown publication fields are rejected. Put only the publication record inside `article`: no event key,
assignment wrapper, lint findings, draft explanation or sensor envelope.

| Fields | Shape |
|---|---|
| `id`, `edition_date` | Assigned lowercase slug and real `YYYY-MM-DD` edition. Filing can resolve an omitted id from your assignment. |
| `section`, `kicker`, `headline`, `deck` | Non-empty strings; write the news in your own voice. `file_article` sets `section` from your desk (Hardware, Escalation, Macro, Commodities, Policy, The Hearth), whatever you type. The **deck** states the news and why it matters in at most 30 words, with no outlet names; headline and deck name the country and claim nothing stronger than the body supports. The **kicker** is a topic label ("Bond markets", "Aviation"), not a detail of the story. |
| `epistemic` | `fact`, `inference` or `forecast`; forecast also needs `confidence: {label, value}` with numeric `value` from 0 to 1. The headline and deck state the event the label settles: a printed probability equals `round(value*100)`, the headline's event is one the label settles (or the deck ties it to the label's terms), and a label that also settles NO when nothing is posted or named by a deadline has that deadline in the deck. `file_article` refuses `forecast_probability`, `forecast_event` and `forecast_deadline`. |
| `byline` | `{desk, agents: ["Cogsworth"]}` with your own canonical name only: Cogsworth, Sprockett, Foreman, Graves, Tinkerton or Vesta. |
| `timestamp`, `next_update_utc` | Real UTC clock strings, respectively `HH:MM UTC` and `HH:MM`. The next-update clock is a review time, not a forecast settlement deadline. |
| `revision` | Integer starting at 1. Spike's revision request authorizes an increase. A revision fixes what Spike named and keeps every other verified excerpt cited: `file_article` refuses one that drops a verified fact Spike's notes did not name. |
| `topics` | Array of existing topic slugs from `repos/newsroom/content/topics.txt`. |
| `body` | Array of at least TWO purposeful prose paragraphs. **Length is set by reportable facts, not by a paragraph count:** use every captured fact the Record carries, one job per paragraph — every `evidence_box` entry with a `raw_excerpt` that carries a distinct fact appears in the body with its `[En]`, and a revision never drops one the previous revision carried; three or four captured sentences make a three-to-four paragraph piece, and a story that needs more needs more reporting (the sensor route), never comparison, gap or consequence paragraphs. Four outlets reporting one fact is ONE paragraph with four citations; restating a fact in different words is padding. Compare sources only when they disagree about a fact a reader needs, in one plain sentence. Never print arithmetic, rounding or date checks that reconcile one outlet's figure with another's, and never narrate evidence binding (which source, page or sentence carries which detail) — attribute in ordinary news style and let the citations carry provenance. No "X, not Y" hedges answering claims no reader would make. A forecast body states probability and deadline in one sentence, then its derivation (base rate or comparison, key assumptions, what would move it); the settlement condition, including the deadline for a no-winner or edge case, lives in `confidence`. Use positional `[En]` citations and supported `**bold**`, without raw HTML, private research ids or newsroom scaffolding (never "captured", "Record", "fragment", "on that page", "on that account"). |
| `key_numbers` | 2–6 `{label, value, dir?}` objects, printed on the Tape (it shows the first three), so the most important come first. `value` is at most 8 characters: a number with its unit (`34/day`, `€930m`, `28%`), any qualifier moved into the label. `label` is a plain phrase of 2–48 characters naming what the number counts, with no trailing period, citation or markup. Optional `dir` is `up`, `down` or `flat`. `file_article` refuses anything else. |
| `evidence_box`, `refs` | Non-empty arrays of Record rows and their exact `source_note.source_id` strings. Every ref resolves to a row. |
| `facts_checked_utc` | Never typed. `HH:MM` stamped from the owner's facts check after PASS (`record_freshness_check`), printed as "Facts as of HH:MM UTC"; `file_article` stamps a revision filed for an `updated` check and refuses a typed one. `compose_edition` refuses a passed piece without a check covering its current revision. |
| Optional fields | `confidence`, earlier `previous_coverage: [{date, slug}]`, `presentation.flashpoint: {place, lat, lon, note}`, and supported `art` fields from the filing schema. Omit unused fields; do not pad them with nulls. |

An author never files `dissent`. The colleague who holds that view uses
`mcp_newsroom_record_dissent` under their own identity.

## Numbers and bylines already in print

The 19 August Unitree article uses
`"byline": {"desk": "Hardware Desk", "agents": ["Cogsworth"]}` and
`{"label": "Issue price", "value": "¥150.80", "dir": "flat"}`.
The 22 August Panama Canal article uses
`{"label": "Slots from 4 Sep", "value": "34/day", "dir": "down"}`.
These are labelled display values, not strings dropped directly into
`key_numbers`, bare numeric JSON values, or `{name, number}` objects. The
filing identity stays lowercase in tool configuration; the printed byline
uses the canonical capitalized name.

## Record rows and positional citations

A Record row has `source`, `fragment`, `as_of` and a `source_note` object.
The note requires `source_id`, `source_kind`, `used_by_agent` and
`retrieved_at`. Public evidence also has the actual absolute `source_url`.
Copy capture metadata from the supplied record, set `used_by_agent` to your
canonical name, and preserve its source id for the assignment lookup.
`used_by_agent` identifies who used the record, not who fetched it.

For example, the 20 August UFS article's second Record row names Yonhap,
has fragment `roughly a dozen short-range ballistic missiles`, and carries
`source_id: "E2"`, `source_kind: "public_url"`,
`used_by_agent: "Sprockett"`, the supplied Yonhap URL and
`retrieved_at: "2026-08-20T22:31:55Z"`. Its body cites that second row as
`[E2]`. The 21 August DeepSeek article likewise places its launch document
first and cites it as `[E1]`; source metadata stays inside the Record row.

The row's position determines the body citation. If a sensor-supplied row
has a corpus id such as `s-1234abcd` and is third in `evidence_box`, preserve
that id in `source_note.source_id` and `refs`, but cite it as `[E3]`. Never
print `[s-1234abcd]` or use a private id as a prose citation. If a source id
itself has the form `E3`, it must occupy the third row. After removing or
reordering evidence, update the body citations. Do not silently remove a
row required by the assignment's `evidence_refs`.

Sensor-supplied research does not mean the reporter personally fetched a
URL. Preserve the recorded access kind and capture time; retain an honest
`provenance_note` when the material came through a research summary. An
internal record with no retrieved public URL needs an internal
`source_kind`, such as `provided_research`, and a provenance note explaining
the access. Never invent a URL, retrieval timestamp or verbatim excerpt.
Use `raw_excerpt` only for text actually captured. A summary supports only
what the supplied evidence establishes; an unverified quote remains
unverified even when the JSON passes.

Record rows come in three states. A row with `raw_excerpt` was verified on
the page; the excerpt may be a passage of up to five sentences, so quote only the
words you need and keep the speaker and time the passage carries. A row with `source_note.evidence:
"attributed_unchecked"` names a page the checker could not open (401, paywall,
PDF, timeout): keep the marker and its note, and use it only as attributed
paraphrase — "Reuters reported that …" [En] — never in quotation marks and
never with a `raw_excerpt`. A sentence the checker read the page for and did
not find never reaches the Record. `file_article` refuses a quotation-marked
sentence citing an attributed row (`attributed_quote`) and a filing whose
cited support is all attribution with no verified excerpt (`attributed_only`). An attributed row whose fragment starts "Unchecked pointer to a passage…"
is paraphrased from the lead's claim and attributed to the outlet; the pointer
words never print.

## Existing examples

These are format references, not fresh research or proof of today's facts:

- `content/editions/2026-08-19/articles/unitree-opens-on-star-at-eleven-hundred.json`
- `content/editions/2026-08-20/articles/pyongyang-fires-a-dozen-during-ufs.json`
- `content/editions/2026-08-21/articles/deepseek-ships-flash-vision-on-the-api.json`
- `content/editions/2026-08-22/articles/panama-canal-cuts-daily-slots-to-thirty-four.json`

They are under `repos/newsroom/` in the workspace. The current filing
schema governs new work; a historical record is never a waiver for a
current error.
