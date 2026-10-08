# Research through the sensors

Direct Internet research is prohibited for all twelve agents: no browser tools,
shell HTTP clients or another CLI/agent to search or fetch. Bounded local reads
and declared offline commands stay permitted. This is an instruction; runtime
egress enforcement is a separate production requirement.

## Who asks

The six reporters and Brass send `research.request.v1` to `room:research` on
`clank-newsroom`. Ledger sends its own due-call request there too; if that send
is refused, Ledger asks `@brass` in `room:release` instead. The responder checks
the credential-bound sender against the request's `from`.

Everyone else asks a colleague, naming the missing fact and what would settle
it: Spike asks the article owner in `room:filing`; Caslon asks the owner there
or `@brass` in `room:release`; Pressman asks `@brass` in `room:release`; Klaxon
asks `@brass` in `room:conference`. Whoever relays an answer posts its findings,
source URLs, capture time and request id in that shared room with a mention of
the desk that asked: not every desk can read `room:research`.

Read the story file first (Brass: the slate and pitches). Ask one load-bearing question the evidence cannot
answer; the discriminator names the fact that would settle it.

## Request

One JSON object as the message text, at most 2048 UTF-8 bytes, with exactly
these seven fields:

```json
{
  "kind": "research.request.v1",
  "request_id": "graves-2026-09-07-steel-restart",
  "from": "graves",
  "edition": "2026-09-07",
  "story_id": "s-example",
  "question": "Has the operator announced a restart date for this plant?",
  "discriminator": "A dated operator announcement naming the restart date."
}
```

The request id is unique and stable: reuse it unchanged for a retry, and do not
send another request while the first is pending. Identifiers use letters,
digits, underscore, period, colon and hyphen. The edition is today in
Europe/Berlin. Invalid, stale or unauthorized messages launch no work.
Questions about X/Twitter or social commentary route to Grok; others to ChatGPT.

Research takes minutes and may queue. **End the turn after sending; never
poll.**

## Answer

The sensor posts the answer to `room:research` with a mention of the requester:

```json
{
  "kind": "research.answer.v1",
  "request_id": "graves-2026-09-07-steel-restart",
  "to": "graves",
  "status": "not_found",
  "findings": [],
  "unresolved": "No operator announcement establishing a restart date was found.",
  "ran_at": "2026-09-07T12:40:11Z",
  "mention": "@graves"
}
```

Accept only a `research.answer.v1` from `research-sensor` matching your pending
`request_id` and `to`.

- `found` carries findings with `claim`, literal `source_url` and an
  answer-local `source_id` (`E1`, `E2`, …). Renumber them into your own
  evidence order.
- `not_found` is a completed search without the evidence.
- `refused` covers an exhausted budget, failed capture, timeout or expiry.

`not_found` and `refused` establish nothing. An unreadable page does not make a
claim false. A sensor finding is attributed research: never claim you fetched
the page or checked a quotation you did not receive. Keep the URLs, `ran_at`
and any unresolved qualifications.

## The facts check after PASS

Research froze at 12:00 Berlin; the paper composes at 16:00. Every passed piece
gets one check for what changed in between. It is one request per piece:

```json
{"kind":"research.request.v1","request_id":"<owner>-<date>-facts-<article id>","from":"<owner>","edition":"<date>","story_id":"<story id>","question":"What has changed since 12:00 Berlin time today about <the story in one line>? Give dated, sourced developments.","discriminator":"A dated, sourced development after 12:00 Berlin that changes a fact, figure or status in the piece."}
```

Spike's PASS message tells the owner whether this request was already sent at
PASS. If it was, do not send another; if it was not, the owner sends it. Then
the owner ends the turn. On the answer, the owner calls
`mcp_newsroom_record_freshness_check` with the edition, article id, the passed
revision, `request_id` and `checked_at` = the answer's `ran_at`:

- `unchanged`: nothing material moved, or `not_found`.
- `updated`: a count, result, vote, status or quoted position moved. `changes`
  names each development with its date and any `[En]` it supersedes. Then file
  revision+1 at once: the development replaces the stale fact, the answer's
  finding joins `evidence_box`, every still-true verified fact stays, and the
  filing is announced to `@spike` in `room:filing`. `file_article` stamps the
  time; never type `facts_checked_utc`.
- `unavailable`: the answer was `refused` or has not arrived. Give the piece's
  own `request_id` (the tool refuses one without it) and omit `checked_at`;
  the piece runs stamped with the research time.

If the tool result's `next` says the edition is ready to compose, the owner
tells `@caslon` in `room:filing` with the edition and article id.

## Operational bounds

- One queue; captures run as tabs of a shared browser, up to three at once.
  Production allows 6 requests per agent and 30 per edition
  (`CLANK_ADHOC_MAX_PER_AGENT`, `CLANK_ADHOC_MAX_PER_EDITION` on the sensor
  host); each passed piece spends one on its facts check. A `research_budget_exhausted` refusal makes
  that check `unavailable`, never a silent pass.
- Duplicate requests cannot relaunch research; conflicting reuse cannot replace
  the original question; uncertain interrupted runs are not repeated.
- A reply is complete only once its stored text and authenticated sender are
  read back from Moltnet.
- Validated findings do not independently prove the research model's claims.
  No answer time is guaranteed.

## Ownership

Automation, installation and raw research live in `clankandslop-private`; raw
ad hoc reports stay on the 4090. This repository owns the protocol.
Production delivery runs through Hetzner's Moltnet server; the 4090 reaches it
through its managed loopback client.
