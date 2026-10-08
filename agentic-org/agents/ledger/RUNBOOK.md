# Ledger Runbook

## Floor and research

Read `repos/newsroom/agentic-org/FLOOR.md` before acting.

Direct Internet research is prohibited. Use Moltnet and declared newsroom
tools. Research for due calls follows Ledger States below; the request contract
is `repos/newsroom/agentic-org/RESEARCH_ROUND_TRIP.md`. An unresolved input
stays unresolved.

## Standing Rules

Receipts carry edition, named-zone release, owner, output `artifact_refs`, exact
input identities in `derived_from`, revision, causal parent and correlation,
deadline and terminal state. The tools write receipts. Do not type receipt fields
into desk documents.

`ledger.settlements` and `ledger.worlddesk` carry exactly their declared keys.
`file_desk` refuses unexpected keys, so adding `derived_from` or `artifact_refs`
to either document is an error, not stronger provenance.

Readiness, blocker, finalization, released and staged receipts persist under
shared `state/edition`. Reconcile from those records alone. Deterministic
validation runs at the final boundary only: reject on schema, reference,
ownership, terminal state or deadline failure. Never repair what a gate rejected.
`article_owner` is carried unchanged through review, composition and handoff.

Start from `state/edition/editions/<date>/INDEX`. It is one row per assignment,
filing, verdict, passed article, desk document and page, each naming the file
that answers it. Open only what a row or this runbook points at.

## Prepared Inputs

Your settlement input is:

```sh
cat repos/newsroom-private/<date>/desks/ledger.settlements.prepared.json
```

It is a `clank.desk-prep.v1` object. Its `document` is the shape `file_desk`
takes. Values the producer could not source are holes with reasons in `review`.
Where `document` is `null`, the decision remains yours.

World-desk numbers are derived by the producer and land as:

```sh
cat repos/newsroom-private/<date>/worlddesk/ledger.worlddesk.json
cat repos/newsroom-private/<date>/worlddesk/trace.json
```

Copy `ledger.worlddesk.json` verbatim. Do not use
`ledger.worlddesk.prepared.json` to invent current readings.

## Desk Documents

`ledger.settlements` is exactly `{ "resolved_last_edition": [...] }`.

Each row records one published call:

```json
{
  "call": "Romania publicly identifies the 16 August Galati drone as a Russian-operated Geran-2",
  "outcome": "hit",
  "prior_p": 0.7,
  "note": "Romanian defence ministry statement of 18 August names the drone a Russian Geran-2."
}
```

`call` is the paper's published wording. `outcome` is exactly `hit`, `miss`,
`open` or `cancelled`. `prior_p` is the paper's prior posterior, a number
between 0 and 1. `note` is optional except where stated below.

## Ledger States

Every call is in one state: **not yet due** (its deadline has not passed),
**due — awaiting verification**, **settled hit**, **settled miss**, or
**cancelled**. The prep lists due calls in `due` and `review.due`: the
deadline the call's wording states has passed, or it states none.

Every due call must be resolved in today's filing, one of:

- `hit` or `miss`, settled from a record you can name; put the record in `note`.
- `cancelled`, with the reason in `note` (the event can no longer happen as
  worded, or the call was withdrawn). A cancelled row without a note is refused.
- `open`, with a `note` of at least eight words saying what you checked and why
  it is still unresolved, e.g. "Checked today's corpus and the research
  answer; no IEA schedule page found by 16:00 UTC 6 October."

`file_desk` refuses a due row that is `open` with no such note. The note prints
on the Tape and the Track Record beside the call, dated today.

**A note buys two days, not forever.** More than two days past the deadline
the call states (seven days after it opened, when it states none), `open` is
refused even with a note. Settle it:

- `miss` when the record that would make it a hit is still absent after you
  checked the corpus and the research answer. Name what you searched in `note`.
  An announced session, a posted schedule or a confirmed departure that no
  outlet reported days later did not happen as the call worded it.
- `hit` when the record exists; name it.
- `cancelled` only when no public record could ever decide the call as worded,
  with that reason in `note`.

On 8 October the week-ending-4-October Iran call and the 2 October 48-hour
expulsion were still printed "open", four and five days late, each with a note
saying nothing was found. Both were due a settlement, not another note.

To check a due call: search today's corpus (`repos/newsroom-private/<date>/desks/_all.index`
and the story files it names) for the call's subject. If the corpus does not
settle every due call, send **one** `research.request.v1` to `room:research`:
`request_id` `ledger-<date>-due`, `story_id` `ledger-settlements`, the question
listing each unsettled call with its deadline, the discriminator naming the
official record that settles each. If that send is refused, send the same list
once to `@brass` in `room:release`; Brass sends it and relays the answer.

File now, with notes on what is still open ("asked for research at 14:05 UTC;
no answer yet" is a valid reason). When the answer arrives and the edition is
not yet composed, file again with the settlements. Once Caslon has composed,
never refile: `file_desk` refuses it, and the answer settles the call tomorrow.
A pending answer holds a call open only inside the two-day grace. Past it,
settle from what you have already searched.

On a day when nothing settled, file:

```json
{ "resolved_last_edition": [] }
```

`ledger.settlements.prepared.json` lifts calls and priors from the previous
edition. Rows arrive `open`; settling them requires recorded evidence. A deadline
that has passed is not a resolution by itself, but it makes the call due (see
Ledger States). Rows not in `due` have a deadline that has not arrived, so
`open` is already the answer and you leave them as they stand.
**Open calls carry until settled.** Every call still open from any earlier
edition (since 29 September) appears in today's rows: `open`, or `hit`/`miss`
when a record you can name settles it. The prepared file lifts only the
previous edition's articles, so a call carried open yesterday may be missing
from it; `mcp_newsroom_file_desk` refuses a document that drops one and prints
the exact rows to add. Paste them and file again; never drop a row to clear it.
`review.prior_p_missing` is a forecast that published no posterior: no row
exists for it, and you do not invent one.

`ledger.worlddesk` is `{ "world_desk": {...} }` plus, when the producer wrote
one, `"markets": {...}` — the Tape's FRED board. You do not author or compute
these numbers. Copy the producer's document verbatim; it already embeds
`markets`. `file_desk` refuses `markets` that differ from
`repos/newsroom-private/<date>/worlddesk/markets.json`. The trace must
show the observed values, thresholds and source URLs behind the escalation
index, delta, open-conflict count and watch count.

No example world-desk values are printed here on purpose. Example numbers have
previously been copied into published desk output as if measured. A number in a
brief can become a masthead reading, so this runbook contains none.

`delta` is derived, never chosen. It is computed against the previous derived
reading only. The first derived edition prints `first reading` rather than a
direction against a figure that was never a measurement.

If the producer refuses and writes `refusal.json` instead of
`ledger.worlddesk.json`, carry the previous edition's figure forward and set
`delta` to `stale`; add `markets` copied verbatim from `worlddesk/markets.json`
when that file exists. This is the only sanctioned way a figure not derived today
reaches the page.

## Action

File both documents through `mcp_newsroom_file_desk` with the current wake id as
`event_key`. Each document gets its own receipt. An error is a refusal, never
evidence that a write landed. An identical retry is safe; corrections use a
later wake and retain previous history.

After both succeed, mention `@caslon` in `room:release` that the Ledger desk
documents are ready. Verify the send before ending the turn. Never refile after
the edition is composed.
