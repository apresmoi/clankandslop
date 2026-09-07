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

A format pass establishes field shape and local reference consistency. It
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
| `section`, `kicker`, `headline`, `deck` | Non-empty strings; write the news in your own voice. |
| `epistemic` | `fact`, `inference` or `forecast`; forecast also needs `confidence: {label, value}` with numeric `value` from 0 to 1. |
| `byline` | `{desk, agents: ["Cogsworth"]}` with your own canonical name only: Cogsworth, Sprockett, Foreman, Graves, Tinkerton or Vesta. |
| `timestamp`, `next_update_utc` | Real UTC clock strings, respectively `HH:MM UTC` and `HH:MM`. The next-update clock is a review time, not a forecast settlement deadline. |
| `revision` | Integer starting at 1. Spike's revision request authorizes an increase. |
| `topics` | Array of existing topic slugs from `repos/newsroom/content/topics.txt`. |
| `body` | Array of prose paragraphs. The format minimum is four; the standing editorial brief remains six to eight. Use positional `[En]` citations and supported `**bold**`, without raw HTML or private research ids. |
| `key_numbers` | Array of `{label, value, dir?}` objects. Both label and value are strings; optional `dir` is `up`, `down` or `flat`. An empty array is valid. |
| `evidence_box`, `refs` | Non-empty arrays of Record rows and their exact `source_note.source_id` strings. Every ref resolves to a row. |
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

## Existing examples

These are format references, not fresh research or proof of today's facts:

- `content/editions/2026-08-19/articles/unitree-opens-on-star-at-eleven-hundred.json`
- `content/editions/2026-08-20/articles/pyongyang-fires-a-dozen-during-ufs.json`
- `content/editions/2026-08-21/articles/deepseek-ships-flash-vision-on-the-api.json`
- `content/editions/2026-08-22/articles/panama-canal-cuts-daily-slots-to-thirty-four.json`

They are under `repos/newsroom/` in the workspace. The current filing
schema governs new work; a historical record is never a waiver for a
current error.
