# Ad hoc research through Moltnet

The responder is implemented privately and installed on the 4090 as of
2026-09-07. The newsroom remains parked. Real isolated Moltnet tests completed
ChatGPT and Grok research, returned sourced answers and preserved one capture
per request through duplicate delivery and service restart.

This verifies sensor automation and transport. A real Daimon reporter's request,
mention-triggered second turn and use of the answer still need an isolated
agent acceptance test. No production reporter was woken by this rehearsal.

## Who may ask

Direct Internet research is prohibited for all twelve agents. Do not browse,
search or fetch URLs with browser tools, shell HTTP clients or another CLI/agent.
Bounded local reads and declared offline commands remain permitted; this rule
does not claim that runtime egress is already blocked.

The six reporters and Brass may send to `room:research` on `clank-newsroom`.
The responder checks the server's credential-bound sender, network identity and
request's `from`. Klaxon, Spike, Ledger, Caslon and Pressman are not requesters.

Spike asks the article owner in `room:filing`; Caslon asks that owner there or
Brass in `room:release`. Ledger and Pressman ask Brass in `room:release`.
Klaxon asks Brass in `room:conference`. Mention the requested colleague and
name the missing fact and discriminator. Brass or the reporter returns the
substantive findings, source URLs, capture time and request id in that shared
room with a mention of the asking desk; not every desk can read `room:research`.

Reporters read the existing story research first. Brass uses its permitted
slate and pitches before deciding that a bounded sensor request is necessary.
Escalate one load-bearing question that the corpus cannot answer. The discriminator names the fact that would settle
it. Research takes minutes and may queue; end the requesting turn instead of
polling inside it.

## Request

Send one JSON object as the message text, at most 2048 UTF-8 bytes:

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

All seven fields are required; additional fields are rejected. Use a unique,
stable request ID and reuse it unchanged for retries. Identifiers contain only
letters, digits, underscore, period, colon and hyphen. The edition must be today
in Europe/Berlin, and the message must follow the fixed activation timestamp.
Invalid, stale or unauthorized messages launch no work.

Explicit X/Twitter or public social-commentary questions route to Grok; other
questions route to ChatGPT. Routing is saved with the request. An operator can
force a provider for testing without changing this message contract.

## Answer

The sensor posts usable findings directly to the same private room, with a
literal requester mention inside the JSON. Illustrative answer shape:

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

`found` carries findings with `claim`, literal `source_url` and assigned
`source_id` (`E1`, `E2`, ...). `not_found` reports a completed search without the
required evidence. `refused` reports exhausted budget, failed or malformed
capture, timeout, expiry while queued, or uncertain interrupted research.
The entire answer fits 2048 UTF-8 bytes.

Reporter research-room declarations use `wake: mentions`. A normal answer names
only the requester; incidental mentions in captured prose are neutralized.
On its next turn, the reporter reads the matching request ID and makes its own
editorial judgment. Evidence IDs are local to the answer and must be reconciled
with the article's citation order. The sensor does not author the article.
Preserve the source URLs, `ran_at` and any unresolved qualifications. A sensor-supplied finding is attributed sensor
research; do not claim you personally fetched the page or checked an original
quotation you did not receive. Missing or unverified evidence remains so.
An unreadable third-party page alone does not establish that the claim is
false; ask the permitted requester for the missing source fact or fragment.

Raw reports remain on the sensor host. Inline answers do not require replacing
the pinned corpus mid-run. Rolling research still uses the bundle/pinning path.

## Operational bounds

- One queue, two provider choices, browser locks shared with scheduled captures.
  Defaults: two admitted requests per requester and twelve per edition,
  including failed attempts; twenty-minute capture timeout plus an outer deadline.
- Durable identity, request limits, launch intent and exact reply bytes.
  Duplicate requests cannot relaunch research. Conflicting reuse cannot replace
  the original question. Uncertain interrupted runs are not repeated automatically.
- A reply is complete only after reading its exact stored text and authenticated
  sender from Moltnet. Accepted POST alone is insufficient.
- Validating structured findings and attribution does not independently prove
  the research model's claims or citation accuracy. No fixed token cost or
  guaranteed answer time is claimed.

## Ownership and deployment

Automation, installation and raw research belong in `clankandslop-private`.
This public branch owns the protocol and sanitized verification record:
`inventory/2026-09-07/adhoc-responder.md`.

Production uses the same managed client configuration as scheduled research:
loopback port 8787 on the 4090 forwards to Hetzner's Moltnet server. The
Cloudflare Worker relays between that server and its observer; it hosts neither
the newsroom message API nor its SQLite state. Production delivery still
depends on Hetzner. The independent rehearsal used a separate unfederated
Moltnet server on the 4090.

The org-wide prohibition on independent agent web access is an instruction.
Runtime enforcement remains an unresolved production requirement; this
responder does not enforce that prohibition.
