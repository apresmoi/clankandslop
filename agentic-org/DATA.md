# Ownership and paths

| Owner | Compiler resource access | Writable boundary |
| --- | --- | --- |
| World Scout, Klaxon, Frontier, Closure | private per-agent corpus: mutable; shared edition state: mutable; public content: read-only | own sensor-ledger, candidates, evidence, pinpoint and dossier artifacts only |
| reporters | shared edition state: mutable; public content: read-only | own dossiers and assigned article handoffs only |
| Brass, Spike | shared edition state: mutable; public content: read-only | assignment and verdict artifacts only; never reporter prose |
| Ledger | shared edition state: mutable; public content: read-only | decisions, receipts and ledger-owned generated records only |
| Caslon | shared edition state: mutable; public content: read-only; ETOPO1 relief grid: read-only | deterministic compose state, composition handoff, and the edition's `maps/` and `glyphs/` artifacts only |
| Morgue | shared edition state: mutable; public content: read-only | archive receipts only |
| Pressman | shared edition state: mutable; public content: mutable | sole owner of composition-digest-keyed local artifact and causal staged receipt; no published state, no push credential |

The compiler enforces resource presence, durability and whole-mount read/write mode. This table narrows mutable mounts to owner subpaths; deterministic admission and content gates reject boundary violations. Spike and Caslon may reject or request revision, but never write reporter-owned prose.

## Illustration inputs

Caslon alone bakes illustrations, and both of its inputs are read-only:

| Input | Mount | Why read-only |
| --- | --- | --- |
| ETOPO1 relief grid (~395MB compressed) | `./etopo`, `CLANK_ETOPO_GZ` | a shared, immutable reference dataset; an edition must never be able to alter the source every past map was baked from |
| 3D models and the static glyph library | inside the pinned newsroom bundle | the permitted catalogue is a reviewed source decision, not an edition-time one |

The decompressed grid is a regenerable cache at `CLANK_ETOPO_GRD`, never an
artifact and never committed. Editions carry only the few-KB baked outputs.
No agent has network access to fetch a relief dataset or a 3D model, by
design: the catalogue in `SYSTEMS.md` is the whole permitted surface.

## The one presentation field a reporter may carry

`ops/lay-page.mjs` builds the front's Flashpoint Index from a list of places,
each with a coordinate and a two-sentence note. **That data exists in no
article field today**, so it reaches the assembler from Caslon's decision
record — which means the compositor writes a sentence about a story it did
not report. The alternative is one optional block on the filing itself, which
`file_article` already accepts unchanged (`object()` rather than `exact()`,
`additionalProperties: true` on the tool schema, no unknown-key check in the
validator, and `review_article` strips only `assignment_ref` and `lint` on
PASS — so it flows filing → verdict → `articles/` → `content/editions/`
untouched, and is covered by Spike's verdict rather than merely compatible
with it):

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
