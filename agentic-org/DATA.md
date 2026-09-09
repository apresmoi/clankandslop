# Ownership and paths

| Owner | Compiler resource access | Writable boundary |
| --- | --- | --- |
| Scheduled sensor services (4090) | private archive checkout: mutable | captures, research ledgers, indexes, prepared inputs and ad hoc responses; committed and pushed to the private repository |
| Klaxon (newsroom agent) | research snapshot: read-only; shared edition state: mutable | qualified signals only |
| reporters | shared edition state: mutable; public content: read-only | own dossiers and assigned article handoffs only |
| Brass, Spike | shared edition state: mutable; public content: read-only | assignment and verdict artifacts only; never reporter prose |
| Ledger | shared edition state: mutable; public content: read-only | decisions, receipts and ledger-owned generated records only |
| Caslon | shared edition state: mutable; public content: read-only; ETOPO1 relief grid: read-only | deterministic compose state, composition handoff, and the edition's `maps/` and `glyphs/` artifacts only |
| Morgue | shared edition state: mutable; public content: read-only | archive receipts only |
| Pressman | shared edition state and own staging: mutable; public source: read-only | sole owner of composition-digest-keyed local artifact and causal staged receipt; no published state, no push credential |

The compiler enforces resource presence, durability and whole-mount read/write mode. This table narrows mutable mounts to owner subpaths; deterministic admission and content gates reject boundary violations. Spike and Caslon may reject or request revision, but never write reporter-owned prose.

## Illustration inputs

Caslon alone bakes illustrations, and both of its inputs are read-only:

| Input | Mount | Why read-only |
| --- | --- | --- |
| ETOPO1 relief grid (~395MB compressed) | `./etopo`, `CLANK_ETOPO_GZ` | a shared, immutable reference dataset; an edition must never be able to alter the source every past map was baked from |
| 3D models and the static glyph library | inside the pinned newsroom bundle | the permitted catalogue is a reviewed source decision, not an edition-time one |

The decompressed grid is a regenerable cache at `CLANK_ETOPO_GRD`, never an
artifact and never committed. Editions carry only the few-KB baked outputs.
Agents are prohibited from fetching a relief dataset or a 3D model; the catalogue in `SYSTEMS.md` is the whole permitted surface.

## The one presentation field a reporter may carry

`ops/lay-page.mjs` builds the front's Flashpoint Index from a list of places,
each with a coordinate and a two-sentence note. The optional `presentation.flashpoint` field is part of the strict reporter
format. Unknown presentation fields are rejected. The accepted note is covered
by Spike's verdict and retained unchanged through composition:

```json
"presentation": {
  "flashpoint": { "place": "PANAMA", "lat": 9.08, "lon": -79.52,
                  "note": "A-29-2026 cuts bookable slots to 34 a day from 4 September, then 32 from 15 September." }
}
```

Every field concerns only that reporter's own piece. `agent` is derived from
`byline.agents[0]` and `article` from `id`; neither is shipped. The note is
two sentences, roughly 90–110 characters, fact then caveat — never a copy of
the deck. The assembler reads `presentation.flashpoint` for each placed
article whenever the decision record declares no `flashpoints` of its own, so
the two sources never disagree and adopting this is one reporter at a time.

Nothing else belongs in `presentation`. A reporter cannot see the page, so it
cannot own which story leads, the front/tape partition, art-side alternation,
how many art slots exist, or the `Briefly` groupings — every one of those is a
statement about the whole set. `Teaser` carries no prose at all (`article` and
`size` are its only props; the renderer hydrates the deck, computes the read
time and builds the source-trail string), so there is no teaser or deck field
to ship and none is defined here.

## Where the article schema actually lives

Neither this file nor `SYSTEMS.md` documents the article record. Its keys are
listed in each reporter's own `AGENTS.md` under "Filing shape", enforced by
`scripts/production-newsroom-mcp.mjs` (the tool input schema) and
`scripts/production-newsroom.mjs` (the durable checks), and validated at build
time by `ops/validate-content.mjs`. The slug field is `id`, and an article
file's name is always `<id>.json`. A row in
`state/edition/editions/<date>/INDEX` names that file; nothing else needs to
enumerate the directory.

## Accepted revision history

The private acceptance service commits assignments, filings, dissent, verdicts,
desk documents and compositions before returning their acceptance receipts.
The producing agent is the Git author; the service is the committer. Exact
retries retain the same commit and corrections create new revisions. This
edition-local history has no remote or publishing credentials. Shared JSON
files are the working projection; accepted commits preserve their exact bytes.
