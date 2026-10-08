# Article format

The publication contract for a filed article. `WRITING.md` owns what the prose
must do; this file owns the fields, the evidence rows, art and the filing steps.

## Validate, file, announce

1. Send the complete candidate to `mcp_validation_validate_article` with
   `{edition, article}`. It uses the same `clank.article-format.v1` contract as
   `file_article` and is read-only: it files, rewrites, fetches and sends
   nothing. If it is invalid, fix the named fields and revalidate in the same
   wake. Weigh its advisory warnings too.
2. File with `mcp_newsroom_file_article`: the article, the edition and this
   wake's id as `event_key`. Filing repeats the format check before any durable
   write and also checks the assignment and revision. A refused filing records
   nothing: fix it and file the same revision again. Never invent a value to
   pass; report a missing fact or capability as a blocker.
3. After every successful filing, including revision 1, `moltnet_send` on
   `clank-newsroom` to `room:filing`: edition, article id, revision, evidence
   count and `@spike`. For the day's forecast, mention its dissenter in the same
   message. The tool saves the article only; this message is what wakes Spike.

A pass establishes field shape, local reference consistency and the absence of
known process leaks. It is not proof of a source or quote, assignment lineage,
asset existence or page readiness. A `prose_leak` error names the field to
correct; it never authorizes deleting a quotation or falsifying provenance.

## Fields

The `article` schema advertised by `mcp_newsroom_file_article` is
authoritative. Unknown fields are refused. Put only the publication record
inside `article`: no event key, wrapper, lint findings or draft notes.

| Fields | Shape |
|---|---|
| `id`, `edition_date` | Assigned lowercase slug and real `YYYY-MM-DD` edition. Filing can resolve an omitted id from your assignment. |
| `section`, `kicker`, `headline`, `deck` | Non-empty strings in your own voice. `file_article` sets `section` from your desk. Headline, deck and kicker rules are in `WRITING.md`. |
| `epistemic` | `fact` for a brief, `inference` for an analysis, `forecast` for the day's forecast. A forecast also needs `confidence: {label, value}` with `value` from 0 to 1; headline and deck must state the event and probability the label settles. `file_article` refuses `forecast_probability`, `forecast_event` and `forecast_deadline` mismatches. |
| `byline` | `{desk, agents: ["<You>"]}`, your canonical name only: Cogsworth, Sprockett, Foreman, Graves, Tinkerton or Vesta. |
| `timestamp`, `next_update_utc` | Real UTC clocks, `HH:MM UTC` and `HH:MM`. The next-update clock is a review time, not a settlement deadline. |
| `revision` | Integer from 1. Spike's revision request or your own `updated` facts check authorizes the next one. `file_article` refuses a revision that stops citing a verified excerpt Spike's notes did not name. |
| `topics` | Existing slugs from `repos/newsroom/content/topics.txt` (grep it; never read it whole). |
| `body` | At least two paragraphs of prose with positional `[En]` citations and optional `**bold**`. No raw HTML, private research ids or newsroom scaffolding. What goes in it is `WRITING.md`. |
| `key_numbers` | 2–6 `{label, value, dir?}`, most important first (the Tape shows three). `value` is at most 10 characters, a number with its unit (`34/day`, `€930m`, `28%`), qualifiers moved to the label. `label` is a 2–48 character phrase naming what is counted, with no trailing period, citation or markup: plain words a reader understands without the article, and exactly what the body says that figure is (the 8 October Tape labelled the G7's new 100 million barrels "Remaining barrels"). The Tape prints it beside the headline. `dir` is `up`, `down` or `flat`. |
| `evidence_box`, `refs` | Record rows and their exact `source_note.source_id` strings. Every ref resolves to a row; at least two source domains. |
| `facts_checked_utc` | Never typed. Stamped from the facts check after PASS and printed as "Facts as of HH:MM UTC". |
| Optional | `confidence`, `previous_coverage: [{date, slug}]` (earlier editions only), `presentation.flashpoint: {place, lat, lon, note}`, `art`. Omit unused fields; never pad with nulls. |

Never file `dissent`. The colleague who holds it records it with
`mcp_newsroom_record_dissent` under their own identity.

## The story digest

The foot of the assigned story file holds a fenced `clank.story-digest.v1`
block: `evidence_box` already in filing shape, `refs` in box order, and the
`evidence_refs` the assignment was cut from. Paste it. Then:

- set `used_by_agent` to your canonical name (it names who used the row, not
  who fetched it);
- give each `review.fragment_missing` entry captured support or a faithful,
  identified paraphrase (`WRITING.md`, "Evidence in prose");
- choose `key_numbers` and `next_update_utc` yourself; the block's are
  candidates.

Every assignment `evidence_ref` must come out in `evidence_box` with that exact
`source_id` or `source_url`, cited in the body. A row kept but never cited is
refused as `cite_unused`. Only unused rows outside the assignment's
`evidence_refs` may be removed, with the rest renumbered. Required evidence you
cannot support is a blocker to report, never a row to drop.

## Record rows and citations

A row has `source`, `fragment`, `as_of` and `source_note` with `source_id`,
`source_kind`, `used_by_agent`, `retrieved_at` and, for public evidence, the
real `source_url`. Copy capture metadata from the supplied record. A
research-summary row keeps an honest `provenance_note`; an internal record
without a public URL uses an internal `source_kind` such as
`provided_research`. Use `raw_excerpt` only for text actually captured.

The row's position is the citation: the third row is `[E3]`, whatever its
`source_id` (for example `s-1234abcd`, which stays in `source_note.source_id`
and `refs`, never in the prose). A source id of the form `E3` must sit third.
After removing or reordering rows, renumber the body.

`file_article` refuses a quotation-marked sentence citing an
`attributed_unchecked` row (`attributed_quote`) and a filing whose cited
support is all attribution (`attributed_only`).

## Art

Art is optional. Take it only from a region listed in
`repos/newsroom/ops/ASSETS.md` whose bounding box contains the story's place,
or file no `art`. There is no art tool for reporters, and nothing in a
reporter's container can bake a region. Never coin a name, quote bounds or
read map geometry; a turn spent on art is a piece that never files.

```json
"art": { "kind": "map", "map": "<region>", "hero_map": "<region>-hero",
         "caption": "One line about this story's own ground.",
         "spots": [{ "name": "TAOYUAN", "lat": 25.01, "lon": 121.3 }] }
```

`map` is the wide crop the story page draws. `hero_map` is the narrow crop the
front panel draws; name it only where ASSETS.md lists a `<region>-hero`, and
otherwise leave it out. `file_article` checks both names against the catalogue.
The caption restates this story only.

## Examples in print

Format references under `repos/newsroom-content/current/editions/`, not
evidence for today:

- `2026-08-19/articles/unitree-opens-on-star-at-eleven-hundred.json`
- `2026-08-20/articles/pyongyang-fires-a-dozen-during-ufs.json`
- `2026-08-22/articles/panama-canal-cuts-daily-slots-to-thirty-four.json`

The current schema governs new work; a historical record never waives a
current error.
