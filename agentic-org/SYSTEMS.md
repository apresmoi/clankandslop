# Systems

Every repository-relative path in this file — `ops/…`, `website/…`, `agentic-org/…` — resolves under the read-only mount at `./repos/newsroom/` when read from an agent workspace, and under the repository root when read in the repository. No score, probability, settlement, or counter is authored here; the calculation authority is `clankandslop-private/agentic-org/SYSTEMS.md`, which is deliberately excluded from the agent mount. Ledger records inputs, formula version, and deterministic receipt; it rejects absent or incompatible units, dates, and accounting bases.

The deadline is 16:00 Europe/Berlin. An edition is identified by that named-zone calendar date, including DST transitions.

## Illustration systems

Caslon is the sole illustration authority. Reporters describe what a story is
about; they never name a glyph, bake an asset, or place a block. Every edition
carries the established two-to-three illustration rhythm, and every asset must
FIT its story — a recycled glyph on a marquee piece is a defect, not a saving.

Two asset kinds exist, and they fail differently. Maps are deterministic and
reliably legible; glyphs are the risk and must be looked at as images before
they ship.

### MapGlyph — regional relief

Baked from ETOPO1 (1-arcmin ice-surface grid, 21601 × 10801) by
`ops/bake-map.mjs`. Output is a few-KB band artifact at
`content/editions/<date>/maps/<name>.json`; the ~900MB grid never enters an
edition.

    node ops/bake-map.mjs --edition <date> --name <slug> \
      --west <lon> --east <lon> --south <lat> --north <lat> --cols 140 --rows 48

- The grid location is configuration, not a constant: `--etopo-gz`, then
  `CLANK_ETOPO_GZ`, then a checkout-relative default. The decompressed cache is
  `CLANK_ETOPO_GRD`, regenerated automatically when absent.
- House reference is **140 × 48**, matching the front-page art column. Never
  exceed 48 rows.
- Bounds must be tight enough that the story's geography is legible at that
  size. A map whose subject occupies four cells is a failed map.
- Band thresholds are shared with glyphcss so palettes stay portable. Do not
  change `elevToBand`; a threshold edit silently repaints all 190 archived maps.
- `--adaptive` derives its levels from percentiles of the sampled window, so
  two adaptive maps are not comparable to each other. Default (absolute) bands
  are the archive's convention; reach for adaptive only for a region whose
  relief is otherwise flat.

Baking is deterministic: the same bounds against the same grid reproduce an
archived map byte-for-byte. That is the regression test — re-bake any committed
map and compare, rather than arguing about whether output drifted.

### GlyphArt — 3D objects

A glyph is a committed 3D model rasterised to ASCII through glyphcss. Two
modes:

- **static** — a pre-baked shape from the committed library:
  `colosseum`, `play`, `notfound`, `satellite`, `pumpjack`, `missile`,
  `drone`, `chip`, `campfire`.
- **roll** — an animated turntable compiled at build time from a `.glb` by
  `bakeRoll`, cycled with a pure-CSS `steps()` film-strip and zero JavaScript.

Rolls are registered in `website/src/components/GlyphArt.astro`, their models
live in `website/src/models/`, and they compile through `@glyphcss/compile`
during the site build — so selecting a roll costs the agent nothing but the
page JSON. The registry, `glyphRoll.ts`, `glyphEclipse.ts`, the model, and the
compiler are all inside the pinned runtime and dependency bundles.

**An agent selects from the catalogue; it never introduces a model.** Adding one
is a reviewed source change — a licensed model committed, a roll registered, its
framing tuned in the Glyph Workbench (`website/scripts/glyph-lab.mjs`, whose
preview is byte-identical to the bake) — and it requires a bundle rebuild and a
new pinned digest. No agent fetches, downloads, or generates a 3D asset during
an edition, and none needs to: everything permitted is already mounted.

The standalone `bake-glb.mjs`, `bake-vox.mjs`, `bake-glyphart.mjs`,
`bake-satellite.mjs` and `bake-404.mjs` scripts are **author-time tools, not an
edition surface.** They import glyphcss through an absolute developer path and
call exports no published version provides, so they run nowhere as committed.
They are how the nine static shapes were produced; repairing them is a
prerequisite for growing the static library, not for running an edition.

### Permitted roll catalogue

One recurring beat per entry. Models are CC0 or CC-BY (poly.pizza), with the
licence and attribution recorded beside the model.

| roll | beat | mode | motion | fits |
| --- | --- | --- | --- | --- |
| `biplane` | aviation | ink | rock | air safety, air cargo |
| `bat` | biosecurity | ink | rock | zoonotic spillover, vectors, urban health |
| `rat` | biosecurity | ink | rock | zoonotic spillover, vectors, urban health |
| `chip` | compute | ink | rock | semiconductors, compute, datacenters |
| `corn` | crops | ink | rock | harvest, grain, drought |
| `violin` | culture | ink | rock | arts and performance |
| `drill` | energy | solid | rock | extraction, fuel, grid |
| `jerrycan` | energy | ink | rock | extraction, fuel, grid |
| `lobster` | fisheries | ink | rock | quotas, stock collapse, ocean heat |
| `shark` | fisheries | ink | rock | quotas, stock collapse, ocean heat |
| `cow` | livestock | ink | rock | herds, avian flu, meat and dairy prices |
| `duck` | livestock | ink | rock | herds, avian flu, meat and dairy prices |
| `pig` | livestock | ink | rock | herds, avian flu, meat and dairy prices |
| `sheep` | livestock | ink | rock | herds, avian flu, meat and dairy prices |
| `atm` | macro | ink | rock | banks, rates, household finance |
| `telegraph` | policy | ink | rock | courts, rulings, enforcement |
| `astronaut` | space | ink | rock | launch, orbit, observation |
| `hubble` | space | ink | rock | launch, orbit, observation |
| `iss` | space | solid | held | launch, orbit, observation |
| `rover` | space | ink | held | launch, orbit, observation |
| `dumptruck` | trade | ink | rock | freight, tariffs, supply routes |
| `truck` | trade | ink | rock | freight, tariffs, supply routes |
| `policecar` | unrest | ink | rock | policing, civil disorder |
| `elephant` | wildlife | ink | rock | conservation, habitat, poaching |
| `globe` | world | ink | rock | whole-world framing |

`eclipse` is a shared glyphcss scene rather than a model and is always available.

Every entry above is a committed model under `website/src/models/`, registered
in `website/src/components/GlyphArt.astro` with the framing it was tuned at, and
carried in the pinned runtime bundle. **Motion** is either a `rock` — the house
56° arc over 60 frames in 3s, taken from the chip — or `held`, a single frame at
a chosen angle. A held glyph costs 1/60th the page weight of a rocking one,
which is the real reason the one-animated-roll-per-edition rule exists: a
128×52 roll inlines 45–210KB of ASCII into the page (5–20KB gzipped).

The recipe for auditioning, tuning and registering a glyph or a map — including
the failure modes already paid for — is `ops/CATALOGS.md`.

To retune an angle or audition new models, run `node ops/glyph-catalog.mjs`
(a local HTML contact sheet, baked through the same code path the site uses) and
`node ops/glyph-angles.mjs --model <path> --name <n>` for a rotX × facing grid.
Voxel (`.vox`) sources are not candidates: blocky geometry does not survive
contour tracing at this resolution.

### Placement and verification

- **At most one animated roll per edition.** Motion is an emphasis device; two
  competing animations read as a carnival, not a newspaper.
- Adjacent illustrated story rows begin **art-left**, then alternate. `Hero`
  art, a `GlyphArt` in a `cols:[1,2]` grid, and the `WorldGlyph` in `cols:[1,1]`
  all default LEFT and will stack down one column — flip the middle grid to
  `cols:[2,1]` so the art zig-zags (hero-L → glyph-R → globe-L).
- Verify alternation and every glyph in a **built-front screenshot**, in light
  and dark. Page JSON is not evidence. A glyph that reads as a blob at hero size
  is not shippable: re-frame it, or pick a more iconic model.
