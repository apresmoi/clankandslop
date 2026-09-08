# What the newsroom actually has

A verified inventory of the illustration assets already committed to this
repository, and an honest account of which of them an agent can use during an
edition. Every count below was measured against the git tree, not inferred
from a spec or from the presence of a tool.

Read from an agent workspace, every path here resolves under the read-only
mount at `./repos/newsroom/`. Read in the repository, it resolves from the
root.

**Counts are as of 2026-09-06 on `feat/agentic-org`, re-measured against the
git tree for this revision.** `origin/main` carries
more — 208 map files over 132 regions, 320 OG cards through 2026-09-03 —
because published editions land there first. The commands beside each section
regenerate the numbers; prefer running one over trusting a number in this
file.

---

## Glyph art — complete, nothing missing

Nine shapes are committed as pre-baked ASCII and imported directly by
`website/src/components/GlyphArt.astro`. Selecting these static assets runs no generator; fresh bakes use the separate private tools.

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

Caslon can also bake the hash-pinned microchip model through the private
`bake_glyph` tool and select its mechanically validated immutable artifact
reference in the decision record. The runtime catalogue and contact-sheet
image tools expose the actual available assets. Standalone developer scripts
exist under `website/scripts/`; their old laptop imports are not the runtime
entry point. Adding another permitted model remains a reviewed source change.

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
`140 × 48` (108 of the 192 files, 66 of the 120 newest-per-name crops); the
rest are narrower, none over 48 rows. Two suffixes recur, `-hero` and `-sq`,
and they mean something specific — see below.

**All 120 are usable today.** A story names one and the assembler resolves it
out of this archive; the section after the table is the route. What cannot be
done is baking a *new* region, and that bound is unchanged.

### The regions committed on this branch

Bounds and grid are read off the **newest** file carrying each name. Five
names (‡) were re-cropped under the same name across editions, so the newest
crop is the one a story gets — `ops/lay-page.mjs` builds its index in edition
order and the last write wins.

| region | lon W → E | lat S → N | grid | files |
| --- | --- | --- | --- | --- |
| `abuja-flood-corridors` | 6.25 → 8.55 | 8.45 → 9.55 | 140×48 | 1 |
| `argentina-andes-snow` | -71.6 → -68.1 | -33.6 → -31.9 | 140×48 | 1 |
| `arizona` | -115 → -108 | 31.7 → 34.9 | 140×46 | 1 |
| `arizona-hero` | -114 → -110.3 | 32.2 → 35 | 108×44 | 1 |
| `bavi` | 116 → 133 | 20 → 33 | 150×44 | 1 |
| `bavi-hero` | 117 → 132 | 20 → 32 | 108×44 | 1 |
| `black-sea-civilians` | 27 → 41 | 43 → 48 | 140×43 | 1 |
| `black-sea-grain` | 28 → 37.8 | 43.2 → 47.2 | 140×48 | 3 |
| `brazil-trade` | -105 → -15 | -36 → 12 | 140×48 | 1 |
| `britain-north` | -8 → 2 | 50 → 59 | 132×46 | 2 |
| `britain-north-hero` | -8 → 2 | 50 → 59 | 96×46 | 2 |
| `burgenstock` | 7.1 → 9.5 | 46.5 → 47.6 | 140×48 | 1 |
| `carraizo-service-area` | -66.5 → -65.36 | 18.05 → 18.55 | 140×44 | 1 |
| `ceuta-crossing` | -7.5 → -3.2 | 34.85 → 36.9 | 140×48 | 1 |
| `chamoli-tunnel-ingress` | 78.5 → 80.4 | 29.9 → 30.82 | 140×48 | 1 |
| `chiba-rain-cascade` | 139 → 141.3 | 35 → 36.1 | 140×48 | 1 |
| `choco-earthquake` | -86 → -69 | 1 → 9 | 140×48 | 1 |
| `cnmi-pacific-lease-context` | 120 → 170 | 5 → 28 | 140×40 | 1 |
| `colombia-response` | -84 → -68 | 0 → 8 | 140×48 | 1 |
| `congo-river-kinshasa` | 2 → 43 | -12 → 6 | 140×44 | 1 |
| `crimea` | 31.5 → 37.5 | 43.8 → 46.3 | 140×48 | 1 |
| `cuba-grid` | -85 → -73 | 19 → 24 | 140×38 | 1 |
| `damascus-judgment` | 26 → 43 | 30 → 38 | 140×48 | 1 |
| `damietta-corridor` | 24 → 38 | 27.5 → 34 | 140×44 | 1 |
| `danube-cooling` | 14 → 31 | 43 → 50 | 140×44 | 1 |
| `danube-second-reactor` | 14 → 33 | 41.5 → 49.5 | 140×44 | 1 |
| `dongshan-drill` | 108 → 132 | 18 → 30 | 140×40 | 1 |
| `dual-straits` | 15 → 71 | 8 → 35 | 140×48 | 1 |
| `eastern-drc-ebola` | 16 → 42 | -7 → 7 | 140×44 | 1 |
| `ebola-surveillance-gap` | 20 → 36 | -4 → 3 | 140×48 | 1 |
| `eclipse-shadow` | -56 → 15 | 38 → 73 | 140×48 | 1 |
| `el-obeid` | 21 → 44 | 8 → 20 | 150×44 | 10 ‡ |
| `el-obeid-hero` | 21 → 43 | 8 → 19 | 112×44 | 1 |
| `europe-axis` | 0.5 → 10.5 | 45.5 → 49.3 | 140×48 | 1 |
| `flores-quake-access` | 119 → 123 | -9.6 → -7.6 | 140×48 | 1 |
| `france` | -5.8 → 9.2 | 42.3 → 49.5 | 140×48 | 1 |
| `france-age-line` | -12 → 17 | 41 → 52 | 140×40 | 1 |
| `france-age-proof` | -7 → 12 | 42 → 51 | 140×48 | 1 |
| `france-spain-firebelt` | -10 → 7 | 36 → 46 | 140×48 | 1 |
| `france-spain-fireline` | -10 → 5 | 39 → 46 | 140×40 | 1 |
| `fuego-ravines` | -91.35 → -90.4 | 14.25 → 14.7 | 140×48 | 1 |
| `galati-air-corridor` | 25.5 → 29.5 | 44.05 → 46.15 | 140×48 | 1 |
| `ghana-akosombo` | -10 → 6 | 4.5 → 11.5 | 140×48 | 1 |
| `gironde-fire` | -1.8 → 0.9 | 43.8 → 45.3 | 140×48 | 1 |
| `guadalajara-fire` | -15 → 10 | 34 → 44 | 140×40 | 1 |
| `gulf` | 50 → 58 | 24 → 28 | 140×48 | 3 ‡ |
| `gulf-war` | 45 → 62 | 23 → 31 | 140×46 | 4 |
| `gulf-war-hero` | 47 → 60 | 24 → 30 | 116×44 | 4 |
| `guyana-coast` | -66 → -51 | 1 → 8 | 140×48 | 1 |
| `guyana-coast-hero` | -63 → -54.25 | 1 → 8 | 84×48 | 1 |
| `hormuz` | 53.5 → 60 | 24.5 → 27.6 | 144×44 | 9 ‡ |
| `hormuz-hero` | 54 → 59.5 | 24.6 → 27.4 | 104×44 | 7 ‡ |
| `hormuz-strait` | 53.5 → 59 | 24.5 → 27.3 | 140×48 | 15 |
| `hormuz-strait-sq` | 54.8 → 57.6 | 25 → 27.2 | 92×48 | 9 |
| `hormuz-traffic` | 50 → 65 | 21.5 → 29.5 | 140×48 | 1 |
| `hormuz-unpublished-route` | 52.8 → 58 | 24.8 → 27.3 | 140×48 | 1 |
| `host-cities` | -125 → -66 | 23 → 51 | 140×48 | 2 |
| `indonesia-rate` | 75 → 150 | -12 → 22 | 140×48 | 1 |
| `iran-nuclear` | 44 → 58 | 26.5 → 35.5 | 140×48 | 4 |
| `iraq-strike-geometry` | 30 → 59 | 24 → 38 | 140×48 | 1 |
| `ituri-outbreak` | 20 → 36 | -4 → 3 | 140×44 | 2 |
| `kariba-ferry` | 22 → 42 | -22 → -8 | 140×48 | 1 |
| `korea-ufs` | 120 → 135 | 32 → 43 | 140×48 | 2 |
| `kumamoto-kyushu` | 129.5 → 131.6 | 32.2 → 33.2 | 140×48 | 1 |
| `kyiv-air-defense` | 29.3 → 31.8 | 49.85 → 50.85 | 140×48 | 1 |
| `kyiv-engels-strikes` | 23 → 50 | 43 → 55 | 140×44 | 1 |
| `lala-logistics-thresholds` | -164 → -144 | 14 → 24 | 140×48 | 1 |
| `lebanon` | 34.2 → 37 | 32.9 → 34.7 | 140×48 | 2 |
| `lebanon-south` | 34.4 → 36.6 | 33 → 34.05 | 140×48 | 6 |
| `lebanon-south-sq` | 34.9 → 36.2 | 33.05 → 34.05 | 92×48 | 2 |
| `leipzig-airport` | 2 → 22 | 47 → 55 | 140×40 | 1 |
| `lima-callao` | -77.9 → -76.23 | -12.35 → -11.55 | 140×48 | 1 |
| `los-pelambres-shutdown` | -75 → -66.5 | -34.6 → -30.2 | 140×44 | 1 |
| `makkah-pact-arc` | 22 → 95 | 8 → 45 | 140×46 | 1 |
| `malvinas` | -62 → -56.5 | -53.2 → -50.6 | 144×46 | 2 ‡ |
| `malvinas-hero` | -61.5 → -56.4 | -52.9 → -50.5 | 104×44 | 1 |
| `metro-cordon` | -74.8 → -73.2 | 40.4 → 41.2 | 140×46 | 1 |
| `metro-cordon-hero` | -74.9 → -73.4 | 40.45 → 41.15 | 116×44 | 1 |
| `metro-smoke` | -81 → -68 | 38.8 → 46 | 140×46 | 1 |
| `moscow-kyiv` | 20 → 44 | 41 → 58 | 140×48 | 1 |
| `nicaragua-ballot` | -96.5 → -79.8 | 8 → 16 | 140×48 | 1 |
| `nicaragua-election` | -94 → -76 | 8 → 16 | 140×40 | 1 |
| `north-kordofan-road` | 28.5 → 34.8 | 12.7 → 15.9 | 140×48 | 1 |
| `okanagan-evacuation-orders` | -122.33 → -118.33 | 49.44 → 50.25 | 140×44 | 1 |
| `pakistan-border` | 67.5 → 72.5 | 32.5 → 35 | 140×48 | 1 |
| `panama-canal` | -81 → -79 | 8.6 → 9.55 | 140×48 | 1 |
| `peru-transfer` | -87 → -51 | -23 → 1 | 100×48 | 1 |
| `philippines-policy-lines` | 107 → 128 | 8 → 18 | 140×48 | 1 |
| `poland-airspace` | 16 → 30 | 47 → 54 | 140×44 | 1 |
| `policarpa-narino` | -84 → -68 | 0 → 8 | 140×48 | 1 |
| `puget-hero` | -123.9 → -121.4 | 46.6 → 48.6 | 84×48 | 1 |
| `puget-sound` | -124.5 → -120.3 | 46.4 → 48.4 | 140×48 | 1 |
| `sapudi-rescue` | 111.8 → 120.6 | -8.5 → -4.5 | 140×48 | 1 |
| `section-301-atlantic` | -82 → 25 | 30 → 63 | 140×32 | 1 |
| `sorange-mines` | 65.8 → 68.7 | 29.8 → 31.2 | 140×48 | 1 |
| `south-africa-court` | 15 → 44 | -36 → -22 | 140×48 | 1 |
| `south-africa-rate` | 10 → 40 | -36 → -20 | 140×42 | 1 |
| `south-korea-market` | 121 → 133.5 | 33 → 39 | 140×48 | 1 |
| `spb` | 27 → 32 | 59.2 → 61 | 140×48 | 1 |
| `sudan-gum` | 15 → 42 | 8.5 → 20.5 | 140×44 | 1 |
| `sudan-gum-hero` | 21 → 42 | 10 → 20.5 | 116×44 | 1 |
| `sweden-fagersta` | 5 → 24 | 55.5 → 63 | 140×48 | 1 |
| `syria-russian-facilities` | 32.3 → 38.1 | 33 → 35.8 | 140×48 | 1 |
| `taiwan` | 117 → 124 | 21.5 → 25.7 | 140×48 | 1 |
| `taiwan-agent-campaign` | 115.5 → 125 | 21.4 → 25.8 | 140×44 | 1 |
| `taiwan-east` | 117.5 → 125.9 | 21.8 → 25.8 | 140×48 | 1 |
| `taiwan-hero` | 119.2 → 124.4 | 21.6 → 25.8 | 84×48 | 1 |
| `taiwan-north` | 119 → 123 | 23.9 → 25.8 | 140×48 | 1 |
| `taiwan-strait` | 117 → 123 | 22 → 26.5 | 140×48 | 1 |
| `three-execution-windows` | -102 → -82 | 28 → 38 | 140×44 | 1 |
| `uganda-eastern-drc` | 22 → 36.5 | -3 → 4 | 140×48 | 1 |
| `ukraine-reach` | 28 → 84 | 42 → 60 | 172×40 | 1 |
| `ukraine-reach-hero` | 28 → 82 | 42 → 58 | 112×42 | 1 |
| `us-microreactor-sites` | -125 → -70 | 25 → 50 | 140×48 | 1 |
| `venezuela` | -73 → -63 | 8 → 13 | 140×48 | 1 |
| `venezuela-coast` | -67.5 → -65.5 | 10.2 → 11.2 | 140×48 | 1 |
| `vizag-compute` | 68 → 96 | 8 → 20 | 140×42 | 1 |
| `zambia-count-after-pause` | 19 → 42 | -20 → -9 | 140×48 | 2 |
| `zambia-count-custody` | 19 → 42 | -20 → -9 | 140×48 | 1 |
| `zoox-operating-gates` | -125 → -76 | 24 → 40 | 140×44 | 1 |

‡ `el-obeid`, `gulf`, `hormuz`, `hormuz-hero` and `malvinas` each exist in
two or three different crops under one name. Every other name is one region.

Twelve more exist on `origin/main`, from the editions of 23 August onward:
`bhote-koshi`, `colorado-mead`, `conakry-gbessia`, `edouard`,
`islamabad-pims`, `kachin-mines`, `leipzig`, `lusaka-courts`, `ne-syria`,
`nevada-peavine`, `niamey`, `taiwan-drones`. They are not claimable from this
branch; the assembler resolves only what is committed here.

### What `-hero` and `-sq` mean

Measured, not guessed — from the files, and from how every article that ever
carried one used it.

An article's `art` names a region twice. `art.map` is the **story-page** map,
rendered at 104 × 42 in the wide article frame and again in the OG card.
`art.hero_map` is the **front-page hero panel** map, rendered at 52 × 30 in
the narrow art column beside the lead. Fourteen regions were baked as a
matched pair for exactly that: the base name for the wide frame, a suffixed
re-crop for the narrow one.

```
hormuz-strait   140×48 over 5.5° lon      hormuz-strait-sq   92×48 over 2.8° lon
lebanon-south   140×48 over 2.2° lon      lebanon-south-sq   92×48 over 1.3° lon
taiwan          140×48 over 7.0° lon      taiwan-hero        84×48 over 5.2° lon
ukraine-reach   172×40 over 56° lon       ukraine-reach-hero 112×42 over 54° lon
```

- **`-sq`** is the earlier convention, June 13–17 only: a hard re-crop to
  92 × 48, roughly square once the 2:1 character cell is accounted for, and a
  much tighter longitude window at the same latitude span. Two exist:
  `hormuz-strait-sq`, `lebanon-south-sq`.
- **`-hero`** replaced it from 5 July onward: same idea, less aggressive —
  84 to 116 columns instead of 132 to 172, and a modestly tighter box. Twelve
  exist: `arizona-hero`, `bavi-hero`, `britain-north-hero`, `el-obeid-hero`,
  `gulf-war-hero`, `guyana-coast-hero`, `hormuz-hero`, `malvinas-hero`,
  `metro-cordon-hero`, `puget-hero`, `sudan-gum-hero`, `taiwan-hero`.
  `britain-north-hero` is the pure case: identical bounds, 96 columns instead
  of 132.

Every article that ever set `hero_map` to a suffixed name paired it with the
unsuffixed base in `map` — `map: "hormuz"`, `hero_map: "hormuz-hero"` — and
by August the practice had settled on one name in both keys.

**The pairing is reachable, and it is the intended shape.** `compose_edition`
ships the *union* of every `art.map` and every `art.hero_map` on the day, so
naming the wide crop in `map` and its `-hero` re-crop in `hero_map` writes
both documents into the edition's `maps/` and both frames find their file.
`hero_map` is optional: leave it out where the archive holds no `-hero` for
the region, and the front panel draws `art.map`. `file_article` resolves both
names against this catalogue at filing time, in the reporter's own wake,
because a name that does not exist has to be refused where it can still be
corrected. Staging requires mechanical content, layout and build checks.

### How a region reaches a page

A baked map is region data, not edition data: the same bounds against the
same grid render the same relief in any edition, which is why the archive is
a catalogue and not a pile of dated artifacts. The route has four links and,
as of this change, an author at each one:

```
reporter files art        art.kind "map", art.map a listed region, art.hero_map its
        ↓                 -hero re-crop where one is listed (optional, may repeat map)
        ↓                 file_article resolves both names before the filing is written
ops/lay-page.mjs          resolves the name: today's maps/ first, then the committed
        ↓                 archive under content/editions/*/maps/ (newest crop wins)
        ↓                 emits MapGlyph in an illustrated slot, or the hero panel
        ↓                 when the lead itself declares one
compose_edition           supplied maps must EQUAL the union of the day's art.map and
        ↓                 art.hero_map values plus page MapGlyph references; each is authenticated
content/editions/<date>/maps/<region>.json     written, then published
```

What used to break it was the first link and only the first link: no brief
asked for `art`, so no article ever carried `hero_map`, so the gate's set was
always empty and the assembler had nothing to place. The second link was also
half-open — `lay-page.mjs` read maps only from the mutable edition state,
which is empty on a fresh day — and now reads through to the archive.

Two refusals guard it, both named `maps must match article art`: a region no
edition ever baked, and two stories claiming one region with different
`spots`. `file_article` refuses the same two, earlier, in the wake that named
them.

**On a day no story has a place, no map runs.** That is a normal edition, not
a failure, and the honest answer whenever no archived box contains the
story's geography.

### Fresh regions

Caslon's private `bake_map` tool reads the mounted ETOPO1 dataset, preserves
absolute terrain thresholds and writes immutable map/provenance/preview files
under shared edition state. It needs no GDAL installation or developer path.
`inspect_artifact` provides optional image diagnostics, not a release gate. `lay_pages` and
`compose_edition` authenticate the selected `{kind,name,sha256}` reference;
only used maps reach the composed edition. Source data stays read-only.

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

| gap | status |
| --- | --- |
| ~~`art.hero_map` has no author~~ | **closed.** The six reporter briefs ask for `art` where a story has a place; `ops/lay-page.mjs` resolves the region out of this archive and places it. All 120 regions are reachable from a page |
| ~~No brief named the atlas~~ | **closed.** Every reporter brief, `agents/caslon/PAGES.md` and `agentic-org/SYSTEMS.md` name it and point here |
| ~~A `-hero` crop cannot be paired with a wide `map`~~ | **closed.** `compose_edition` ships the union of every `art.map` and `art.hero_map`, so a story may name the wide crop and its `-hero` re-crop and both reach the edition. `hero_map` is optional; `file_article` resolves both names against this catalogue in the reporter's own wake |
| Cannot bake a new region | private `bake_map` now reads the mounted grid and writes shared immutable artifacts; deployment verification pending |
| Cannot bake a new glyph shape | private `bake_glyph` now renders the committed microchip; additional model sources still require review |
| OG cards | open, unchanged. Need a dev server; nobody owns it |

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

An earlier revision of *this file* then made the adjacent mistake. It found
the 192 files, counted them correctly, and still recorded the atlas as
"unusable today" — because it read the route as a deadlock when only its
first link was missing. Nobody was telling reporters to write `art`. Six
paragraphs in six briefs and one archive lookup in the assembler were the
whole of it. **A gap with no author is not a gap in the machinery.**
