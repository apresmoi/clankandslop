# What the newsroom actually has

A verified inventory of the illustration assets already committed to this
repository, and an honest account of which of them an agent can use during an
edition. Every count below was measured against the git tree, not inferred
from a spec or from the presence of a tool.

Read from an agent workspace, every path here resolves under the read-only
mount at `./repos/newsroom/`. Read in the repository, it resolves from the
root.

**Counts are as of 2026-09-06 on `feat/agentic-org`.** `origin/main` carries
more — 208 map files over 132 regions, 320 OG cards through 2026-09-03 —
because published editions land there first. The commands beside each section
regenerate the numbers; prefer running one over trusting a number in this
file.

---

## Glyph art — complete, nothing missing

Nine shapes are committed as pre-baked ASCII and imported directly by
`website/src/components/GlyphArt.astro`. No generator runs, at edition time or
ever; the art is the artifact.

```
website/src/data/glyphart-coliseum.txt    7061 B    shape: colosseum (also the fallback)
                 glyphart-drone.txt       4956 B
                 glyphart-pumpjack.txt    4720 B
                 glyphart-play.txt        2091 B
                 glyphart-404.txt         1933 B    shape: notfound
                 glyphart-campfire.txt    1734 B
                 glyphart-satellite.txt   1395 B
                 glyphart-chip.txt         975 B
                 glyphart-missile.txt      957 B
```

Two animated **rolls** exist beside them: `chip`, compiled at build time from
`website/src/models/small-microchip.glb`, and `eclipse`, computed in
`website/src/lib/glyphEclipse.ts` with no model at all.

```
shapes  colosseum play notfound satellite pumpjack missile drone chip campfire eclipse   (10)
rolls   chip eclipse                                                                     (2)
```

`ops/lay-page.mjs` validates against exactly that set (`GLYPH_SHAPES`,
`GLYPH_ROLLS`) and names all ten in its refusal message;
`ops/validate-content.mjs` enforces the same two rolls.
`agentic-org/SYSTEMS.md` describes the same catalogue.
**The whole catalogue is usable today.**

What is missing is only the ability to bake a *new* shape. The rasterisers
that produced the nine (`bake-glb.mjs`, `bake-vox.mjs`, `bake-glyphart.mjs`,
`bake-satellite.mjs`, `bake-404.mjs`) are not in this repository, and neither
is `ops/glyph-catalog.mjs`, `ops/glyph-angles.mjs` or `ops/CATALOGS.md`.
Nothing an edition does depends on them.

---

## Maps — a large atlas already exists

```
find content/editions -path '*/maps/*.json' | wc -l                                    # 192 files
find content/editions -path '*/maps/*.json' -exec basename {} .json \; | sort -u       # 120 regions
```

**192 baked map files, 120 unique regions, across 69 of 71 committed
editions.** Each file is a compact JSON of roughly 6.4 KB — a name, the
bounding box, a `cols`/`rows` grid and one digit string per row:

```json
{"name":"danube-second-reactor","west":14,"east":33,"south":41.5,"north":49.5,
 "cols":140,"rows":44,"bands":["0000000…","1111111…"]}
```

They live at `content/editions/<date>/maps/<name>.json`. The house grid is
`140 × 48` (108 of the 192 files); the rest are narrower crops, none over 48
rows. Two suffixes recur: `-hero` and `-sq` are tighter re-crops of the same
region — `hormuz-strait` is 140 × 48 over 5.5° of longitude, `hormuz-strait-sq`
is 92 × 48 over 2.8°.

### The regions committed on this branch

```
abuja-flood-corridors argentina-andes-snow arizona arizona-hero bavi
bavi-hero black-sea-civilians black-sea-grain brazil-trade britain-north
britain-north-hero burgenstock carraizo-service-area ceuta-crossing
chamoli-tunnel-ingress chiba-rain-cascade choco-earthquake
cnmi-pacific-lease-context colombia-response congo-river-kinshasa crimea
cuba-grid damascus-judgment damietta-corridor danube-cooling
danube-second-reactor dongshan-drill dual-straits eastern-drc-ebola
ebola-surveillance-gap eclipse-shadow el-obeid el-obeid-hero europe-axis
flores-quake-access france france-age-line france-age-proof
france-spain-firebelt france-spain-fireline fuego-ravines
galati-air-corridor ghana-akosombo gironde-fire guadalajara-fire gulf
gulf-war gulf-war-hero guyana-coast guyana-coast-hero hormuz hormuz-hero
hormuz-strait hormuz-strait-sq hormuz-traffic hormuz-unpublished-route
host-cities indonesia-rate iran-nuclear iraq-strike-geometry
ituri-outbreak kariba-ferry korea-ufs kumamoto-kyushu kyiv-air-defense
kyiv-engels-strikes lala-logistics-thresholds lebanon lebanon-south
lebanon-south-sq leipzig-airport lima-callao los-pelambres-shutdown
makkah-pact-arc malvinas malvinas-hero metro-cordon metro-cordon-hero
metro-smoke moscow-kyiv nicaragua-ballot nicaragua-election
north-kordofan-road okanagan-evacuation-orders pakistan-border
panama-canal peru-transfer philippines-policy-lines poland-airspace
policarpa-narino puget-hero puget-sound sapudi-rescue
section-301-atlantic sorange-mines south-africa-court south-africa-rate
south-korea-market spb sudan-gum sudan-gum-hero sweden-fagersta
syria-russian-facilities taiwan taiwan-agent-campaign taiwan-east
taiwan-hero taiwan-north taiwan-strait three-execution-windows
uganda-eastern-drc ukraine-reach ukraine-reach-hero us-microreactor-sites
venezuela venezuela-coast vizag-compute zambia-count-after-pause
zambia-count-custody zoox-operating-gates
```

Twelve more exist on `origin/main`, from the editions of 23 August onward:
`bhote-koshi`, `colorado-mead`, `conakry-gbessia`, `edouard`,
`islamabad-pims`, `kachin-mines`, `leipzig`, `lusaka-courts`, `ne-syria`,
`nevada-peavine`, `niamey`, `taiwan-drones`.

### The constraint that makes the atlas unusable today

A baked map is region data, not edition data — the same file would render the
same relief in any edition. But a map can only reach a page through one route,
and that route currently has no author:

```
article art.hero_map  ──▶  lay-page.mjs MapGlyph  ──▶  compose_edition maps[]
        (unauthored)
```

`ops/lay-page.mjs` emits a `MapGlyph` only for a story whose article JSON
carries `art.kind: "map"` with a `hero_map` (or `map`) name, and
`compose_edition` refuses any composition whose supplied `maps` are not
*exactly* the day's `art.hero_map` values. So:

- **No article carries `art.hero_map` on an ordinary day.** The `file_article`
  MCP schema accepts an `art` object, but no reporter brief asks for one, and
  Caslon — who owns illustration — has `file_desk` and `compose_edition`, not
  `file_article`. Nothing in the autonomous path writes the field.
- **Reusing an archived region is mechanically possible.** The maps
  `lay-page.mjs` reads come from the mutable edition state
  (`$CLANK_EDITION_STATE_ROOT/editions/<date>/maps/`), not from the read-only
  repository mount, so an archived document could be copied across. It still
  needs an article to name it.
- **Baking a new region is not possible anywhere.** See below.

This is a design gap, not a missing asset. It is recorded here, not fixed here.

### Why a new region cannot be baked

```
ops/bake-map.mjs         imports gdal-async, which is a root devDependency and is
                         installed in no workspace and in no runtime bundle
                         (the bundles vendor website/node_modules only)
        line 33          defaults to /Users/apresmoi/glyphcss/etopo/ETOPO1_Ice_g_gmt4.grd.gz
                         — a laptop path that is wrong even on the laptop
        env              reads neither CLANK_ETOPO_GZ nor CLANK_ETOPO_GRD, though
                         agents/caslon/Spawnfile sets both and mounts the grid at
                         ./etopo. Only --etopo-gz / --etopo reach it.
output dir               content/editions/<date>/maps/ is inside the read-only
                         ./repos/newsroom mount
```

`agentic-org/scripts/build-etopo-bundle.mjs` says its source resolution
"mirrors `ops/bake-map.mjs`" and reads `CLANK_ETOPO_GZ`. `ops/bake-map.mjs`
does not. That drift is the reason the wired-up grid is unreachable.

**Existing regions are data an agent can point at; new ones cannot be produced
in any environment the newsroom runs in.**

---

## OG social cards

```
find website/public/og -name '*.png' | wc -l
```

**280 committed** at `website/public/og/<date>/<slug>.png` over 55 edition
dates (2026-06-13 through 2026-08-22 on this branch; through 2026-09-03 on
`main`), plus `website/public/og/default.png`. `website/scripts/make-og.mjs`
needs a live dev server, so nothing in the autonomous path produces them and
recent editions ship without.

---

## Other committed assets

```
website/src/models/small-microchip.glb    the only .glb; the chip roll
website/src/lib/glyphEclipse.ts           the eclipse roll, no model
website/src/data/landmask.json            built once, 2026-06-13
ops/ramp-coverage.json                    built once, 2026-07-12
website/public/{favicon*,icon-*,apple-touch-icon}.png
```

---

## The gaps, stated honestly

| gap | why it matters |
| --- | --- |
| `art.hero_map` has no author | the whole atlas is unreachable from a page; this, not a shortage of maps, is what keeps maps off the paper |
| No brief named the atlas | 120 regions were committed and no agent was told they existed — this file is the fix |
| Cannot bake a new region | `gdal-async` absent, default path wrong, env vars ignored, output dir read-only |
| Cannot bake a new glyph shape | the rasterisers were never committed |
| OG cards | need a dev server; nobody owns it |

---

## Why this was missed

Two audits reported these capabilities as absent, both by the same mistake:
they checked for the **generator** and concluded the **capability** was gone.

`ops/glyph-catalog.mjs` is genuinely missing, so the first audit reported that
nobody could produce glyphs — without opening `GlyphArt.astro`, which imports
nine committed `.txt` files and needs no generator at all. A later claim that
the roll catalogue was "24/25 fiction" conflated **shapes** (ten, all present)
with **rolls** (two, both present). And `gdal-async` is genuinely absent, so
the same reasoning concluded the paper could not have maps — while 192 baked
map files sat committed in the archive.

**Check for the artifact before concluding from the absence of its tool.** A
missing generator means "cannot make new ones". It never means "has none".
