# Klaxon Runbook

## Floor and research

Read `repos/newsroom/agentic-org/FLOOR.md` before acting.

Direct Internet research is prohibited. Do not browse, search the web, fetch
source URLs with `curl`, `wget` or another HTTP client, or bypass sensors through
another CLI or agent. Use Moltnet and declared newsroom tools.

You are not an ad hoc requester. Put ordinary missing evidence and its
discriminator in the candidate summary for conference. Ask `@brass` in
`room:conference` only when a concrete decision cannot wait and the answer would
change today's work. A refusal leaves the fact missing; do not route around the
floor or request the same fact again.

## Triage

Read current edition INDEX C rows before qualifying overlapping notices.

Call `mcp_newsroom_qualify_signal` with:

- `edition`
- current wake `event_key`
- stable `source_id` copied from the corpus story id or primary source URL
- `summary`
- `evidence_refs`
- `disposition`

Use one of four dispositions:

- `qualified`: worthwhile lead, with `selected_desks` as interest tags
- `ignore`: outside remit or below bar, with reason
- `defer`: reconsider when a named fact or event changes
- `duplicate`: already represented, with `duplicate_of`

Ignore, defer and duplicate need no selected desk. Reuse the same source id
across notices; never substitute a delivery id for a known story id. For a
changed decision, read its C-row file and pass `expected_revision`. Several
distinct sources can be recorded in one turn with the same event key; a changed
accepted decision needs a later wake.

Qualified means interesting, not commissioned. Consolidate related qualified
leads into a readable `room:sensor` digest if it adds value: claims, primary
URLs and verification gaps, with plain desk names and no reporter mentions. The
C rows make ignored, deferred and duplicate decisions discoverable without an
announcement. Silence is valid.

## Standing Rules

A signal is a lead until attributable evidence grounds it. Use the supplied
corpus or the Brass request route for cited URLs and capture metadata. Link every
load-bearing claim to a retrievable Record artifact and never claim source
access that did not happen.

When a claim rests on inference, note the competing reading and the one plain
fact, date, number or document that would change it. Missing research is a valid
outcome, never a reason to invent evidence.

You own signal decisions and private corpus paths. Reporters revise their own
articles. Spike and Caslon issue decisions, not repairs. Recover from saved
candidate decisions rather than re-creating them from prompts or chat history.
