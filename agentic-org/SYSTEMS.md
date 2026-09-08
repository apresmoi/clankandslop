# Systems

Every repository-relative path in this file — `ops/…`, `website/…`, `agentic-org/…` — resolves under the read-only mount at `./repos/newsroom/` when read from an agent workspace, and under the repository root when read in the repository. No score, probability, settlement, or counter is authored here; the calculation authority is `clankandslop-private/agentic-org/SYSTEMS.md`, which is deliberately excluded from the agent mount. Ledger records inputs, formula version, and deterministic receipt; it rejects absent or incompatible units, dates, and accounting bases.

The local staging target is 22:00 Europe/Berlin. An edition is identified by that named-zone calendar date, including DST transitions.

## Illustration systems

Caslon owns layout and illustration decisions. A reporter may name an archived
map in `art.map` and its optional `art.hero_map`; those approved references and
spots are retained unchanged. Caslon chooses fresh bounds and model framing.
Reporters never bake, download models or edit page compositions.

### Available inputs and tools

- `list_art_catalogue` lists the committed atlas, nine static glyphs, two rolls
  and the permitted source model. `inspect_catalogue_preview` shows the artwork.
- `bake_map` reads the mounted ETOPO1 grid through the private bounded NetCDF
  reader. Supply edition, name, bounds, columns and rows (at most 48 rows).
  It preserves the archive's absolute elevation thresholds and writes a fresh
  immutable map, provenance and preview to shared edition state. The original
  grid is read-only; decompression uses a regenerable cache.
- `bake_glyph` rasterizes the committed, hash-pinned `microchip` model using
  glyphcss and @glyphcss/core 0.1.5. Supply edition, name, framing and grid.
  Other models require a reviewed source change; no model download occurs.
- `inspect_artifact` and `inspect_catalogue_preview` provide optional image
  diagnostics. Image inspection is not an agent task or a release gate.

The older standalone developer scripts are not the runtime tool surface. Their
laptop imports and GDAL dependencies do not affect the private tools above.
Runtime tools and dependencies live in the private repo; declarations and
publication formats live on the public org branch.

### The publication handoff

For an illustrated feature with no reporter map, Caslon may select a bake with
`decisions.art[slug].artifact = {kind, name, sha256}` and a caption. Call
`lay_pages` with the decision record; it authenticates the exact same-edition
artifact files and produces an immutable layout. Pass its `layout_sha256` to
`compose_edition`; production composition verifies the exact baked structure.

Composition authenticates the bytes and provenance again. Maps include the
union of reporter `map`/`hero_map` and page `MapGlyph` references. Generated
glyphs become edition-local `glyphs/<name>.json` files; `GlyphArt.props.glyph`
loads that file as escaped plain text. An artifact cannot silently replace an
archived map with the same name. Reporter prose is never adapted by composition.

Nine static shapes remain available: colosseum, play, notfound, satellite,
pumpjack, missile, drone, chip and campfire. Two rolls remain available: chip
and eclipse. Eclipse requires both `shape: "eclipse"` and `roll: "eclipse"`;
there is no static eclipse asset. At most one roll appears in an edition.
The front has two to three illustrated blocks; adjacent illustrated story rows
start with art left and alternate sides. The Flashpoint globe is desk chrome
and does not count toward that illustration floor.

### Mechanical release checks

Pressman's `prepare_release` authenticates the composition, checks installed
packages against the pinned website lock, validates content, builds the site
and runs the offline glyph-camera check. Fonts are hosted locally and the
build requires pinned Linux dependencies. Browser screenshots and scene
inspection are optional developer diagnostics; they do not block staging.

Once that job succeeds, Pressman calls `stage_release`. It requires unchanged
composition bytes and the matching successful build. No agent opens a page or
approves an image. The assembler owns the page structure; validators check
references, supported blocks and artifact dimensions. Future rendering defects
are renderer fixes, with regression tests; a JSON pass is not a claim that
every aesthetic choice is perfect.

Caslon repairs layout and art; reporters repair their own articles and Spike
reviews the exact new filing digest. Colleagues request these repairs through
Moltnet. Tools validate and preserve outputs; they never choose the next agent
or direct editorial work. Sensors remain scheduled services outside the agent
roster. Production remains parked until the isolated production checks pass.
