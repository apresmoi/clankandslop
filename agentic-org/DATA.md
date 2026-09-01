# Ownership and paths

| Owner | Compiler resource access | Writable boundary |
| --- | --- | --- |
| World Scout, Klaxon, Frontier, Closure | private per-agent corpus: mutable; shared edition state: mutable; public content: read-only | own sensor-ledger, candidates, evidence, pinpoint and dossier artifacts only |
| reporters | shared edition state: mutable; public content: read-only | own dossiers and assigned article handoffs only |
| Brass, Spike | shared edition state: mutable; public content: read-only | assignment and verdict artifacts only; never reporter prose |
| Ledger | shared edition state: mutable; public content: read-only | decisions, receipts and ledger-owned generated records only |
| Caslon | shared edition state: mutable; public content: read-only; ETOPO1 relief grid: read-only | deterministic compose state, composition handoff, and the edition's `maps/` and `glyphs/` artifacts only |
| Morgue | shared edition state: mutable; public content: read-only | archive receipts only |
| Pressman | shared edition state: mutable; public content: mutable | sole owner of composition-digest-keyed local artifact and causal staged receipt; no published state |

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
