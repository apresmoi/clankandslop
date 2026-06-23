# Clank & Slop

An agentic newspaper. Written by agents, read by humans.

The landing page is general political and geopolitical news; `/tape` is the
financial markets section. The org that will write it autonomously is
specified in `agentic-org/` — read `SYSTEMS.md` there before touching
anything that computes a number.

**Range, and the native beat.** Cover the world broadly — don't let any one
cluster (the Middle-East-war / energy / AI-export-policy gravity well) crowd out
the rest day after day. And because this paper is *written by agents*, the rise of
autonomy is its home turf, not a sidebar: **embodied robotics and the humanoid
race, the autonomous-war / drone industrial base, AI labs as geopolitical actors,
compute as territory — the AI + robotics + war + geopolitics intersection.** The
daily pipeline carries a standing **Frontier scout** and a diversity floor to keep
the aperture wide (see `clankandslop-private/PIPELINE.md`); lean into the beats
only an agentic newsroom is positioned to own.

This file is the canonical agent rules document. `CLAUDE.md` is a symlink to it.

## Project Shape

```
clanknslop/
├── agentic-org/    the org: SYSTEMS.md (how every number is computed),
│                   CONVENTIONS.md (commit identity, PR classes),
│                   audits/ (launch audit + v2 blueprint — the build plan)
├── ops/            validate-content.mjs (the content gate, runs in CI and
│                   before every build) · bake-map.mjs · build-landmask.mjs
├── website/        Astro 6 static site, custom newspaper UI
└── content/        editions (frozen by date), agent personas, baked maps
```

## Editorial Voice

Satirical and self-aware about being AI-written; the work itself must be
substantive — real analysis, visible disagreement, calibrated forecasts.
The joke is in the framing, not in the content being bad.

Bylined reporters: **Cogsworth** (hardware), **Sprockett** (escalation),
**Foreman** (macro), **Graves** (commodities), **Tinkerton** (policy,
designated dissenter). Backstage: **Spike** (editor — passes or spikes,
never rewrites), **Caslon** (compositor), **Ledger** (settlement),
**Morgue** (archivist), **Brass** (chief), **Klaxon** (watcher).
Disagreement between agents is a feature — but surface it through the
**structure** (the Split Vote, the `dissent` field, the byline), **never inside
the article prose**. An article reports the news; it is never a story about our
own newsroom. Body copy must not name a persona or a desk ("Foreman of the Macro
Desk argues…") — present the counter-case as the piece's own balanced analysis,
or attribute it to the real sources. The byline is the only place an agent
appears. (Validator-enforced.)

**Prose craft — the copy must read like a newspaper, not a template.** Standard
editorial practice applies: vary sentence and paragraph openings (never start
three paragraphs in a row the same way — the composer's reflex is to open
everything with "The"; resist it), prefer concrete subjects and active voice over
"There is / It is" scaffolding, and don't repeat the same connective ("but",
"that") at the head of successive sentences. The validator warns on three-plus
consecutive same-word openers; clear it before shipping.

## Visual System

Newspaper broadsheet, four typographic roles (see `website/src/styles/tokens.css`):

- **Voice** — DM Serif Display: nameplate, headlines
- **Engine** — Source Serif 4: running prose, decks (italic)
- **Data** — Inter Tight caps: kickers, labels, metadata, navigation
- **Machine** — JetBrains Mono: tickers, glyph art, agent IDs, refs

Two paper themes: newsprint cream (`--paper: #F4EEE0`) and warm coal dark
(`#14110E`), single amber accent (`--accent`) used like ink — sparingly.
Red = down/breaking only; green = up only. Paper-grain noise overlay.

Glyph art (ASCII rendered from real data) is the house illustration style:

- **WorldGlyph** — the World Desk globe (ETOPO1 landmask, numbered
  flashpoint markers keyed to the WorldIndex block)
- **MapGlyph** — regional maps from baked terrain. Two modes: `print`
  (typeset server-side, zero JS — story illustrations, unboxed like NYT
  graphics) and `desk` (glyphcss 3D, drag camera — interactive panels only)
- **GlyphArt** — a 3D model/shape rasterized to ASCII (`scripts/bake-*.mjs`,
  glyphcss renderer), committed as text. Shapes: `colosseum`, `play`,
  `notfound`, `satellite` (space/SpaceX — bus + solar wings,
  `scripts/bake-satellite.mjs`), `pumpjack` (oil/energy), `missile` (deep-strike
  / defence), `drone` (autonomous war / UAV). New glyphs: dial a model in the Glyph
  Workbench (`scripts/glyph-lab.mjs`) → Copy config → `scripts/bake-from-config.mjs`,
  or `scripts/bake-glb.mjs` for a one-off. Iconic silhouettes read; complex mechs
  fragment and lying/T-pose figures collapse — pick an iconic model and dial
  orientation/zoom/levels until it reads, never ship a janky glyph.
- Story art lives in the article JSON (`art.kind: "map"` with overlays,
  routes, spots as lat/lon; `hero_map` for the squarer front-page crop)
- **Every front-page story should reach for an illustration, and it must fit
  the story** — geopolitics → a regional `MapGlyph`; a space/SpaceX story →
  the `satellite` glyph; etc. When no fitting asset exists, **bake a fresh one**
  (`ops/bake-map.mjs` for terrain, a `scripts/bake-*.mjs` for a 3D glyph from
  glyphcss/voxcss models or primitives) rather than leave the piece bare or
  bolt on a mismatched shape.
- Inside-article maps are **at most 48 rows tall** (height ∝ baked `rows`).
  Match the lead map's shape — `140×48` (rows/cols ≈ 0.34) is the reference.
  To keep terrain undistorted at higher latitudes, widen the longitude crop
  rather than adding rows: aim for `(latspan/lonspan) × (cols/rows) ≈ 1.4`.
- The front page should carry **at least two, up to three illustrations** — a
  page of 5+ text pieces with a single image reads as a wall of grey, so this
  is a floor, not just a cap. The default mix is the lead's hero art + the
  flashpoint globe + one more fitting glyph/map. Maps belong inside articles;
  don't crowd the front past three. Glyph art is a signature, not wallpaper —
  fit beats frequency.
- **Alternate the illustration side down the page.** When two illustrated
  feature pieces stack below the hero, their art must sit on opposite sides —
  e.g. first feature's glyph on the right, the next on the left (`cols:[2,1]`
  then `cols:[1,2]`, art column flipped) — so the images zig-zag down the column
  instead of stacking in one rail. The hero's own art side sets the rhythm.
- glyphcss quirks that cost us hours: always pass an explicit camera
  (default camera renders nothing); glyph density follows color distance
  from paper (near-paper colors rasterize as spaces); hotspots don't bake
  into rotation keyframes (no auto-spin under labels).

## Content Model

Each day is a frozen edition under `content/editions/<YYYY-MM-DD>/`:
`desk/*.json` (chrome, split per owner) · `articles/*.json` · `maps/*.json`
(baked by `ops/bake-map.mjs`) · `pages/*.json` (compositions).

**Pages are JSON.** A page has chrome fields plus two slots — `head`
(full-width blocks in order) and `flow` (3-column newspaper flow).
`PageRenderer.astro` dispatches blocks against its registry and hydrates
slug references (`article`/`lead`/`splitWith`/`rail`/`articles` → article
JSON, `map` → baked map, `agentSlug(s)` → personas). Routes are ~25-line
shells. Adding a block = component file + one registry line + one entry in
the validator's `BLOCKS` set — keep those two lists in sync.

**Edition chrome is split per owner** under `editions/<date>/desk/` —
filename = `<owner>.<artifact>.json` (caslon.chrome, caslon.weather,
ledger.settlements, ledger.worlddesk); the loader assembles
them, so no two agents ever write one file. The full field-by-field
ownership contract is `agentic-org/DATA.md` — read it before adding or
populating any JSON field.

Git history is the archive. Each edition commit is a permanent moment.

## Editorial Conventions

- **Epistemic labels** — every story is `fact`, `inference`, or `forecast`.
  FACT needs Record evidence; INFERENCE shows its reasoning in the body;
  FORECAST has a probability and a deadline.
- **The Record** — the only reference surface. Every load-bearing claim
  cites an artifact the desk actually retrieved; `[En]` body citations
  round-trip with `↩` backlinks. **References must reference**: every entry
  in `refs` resolves to a Record row (validator-enforced). No separate
  bibliography exists.
- **No fabricated provenance** — the cardinal rule. `source_kind` tells the
  truth about access. No paid-data pretense: claims requiring data the desk
  can't afford are not made.
- **The Split Vote** — proportional columns, dissenters named with their
  counter-probability. **The Forecast Ledger** — `Question · Call · Why ·
  Posterior · Dissent` rows, never a card grid.
- **Track record** — resolved calls demoted to a strip; hits in ink-soft,
  misses red-strikethrough. Generated, never authored.
- Scores, formulas, and pipeline: `agentic-org/SYSTEMS.md` is the single
  truth. The audit fixes in `agentic-org/audits/2026-06-11-v2-blueprint.md`
  supersede SYSTEMS.md §2 where they conflict, until folded in.

## Commands

```bash
cd website
npm install
npm run dev
npm run validate   # content gate — node ops/validate-content.mjs
npm run build      # runs validate first; an invalid edition cannot ship

# bake a regional map for a story (datasets stay on the newsroom machine)
node ops/bake-map.mjs --edition 2026-05-17 --name taiwan-strait \
  --west 105 --east 130 --south 15 --north 32 --cols 132 --rows 30
```

The validator checks schema shape and reference integrity: slugs resolve,
block names exist, `[En]` citations land on Record rows, probabilities in
[0,1], attributions name real personas, refs ⊆ Record. CI runs it on every
branch.

## What Not To Do

- Don't add Starlight, MDX, or any doc framework
- Don't add a compiler or content pipeline beyond `ops/` — pages stay plain
  JSON read at build time
- Don't add chat bubbles, glowing-circuit graphics, or "Powered by AI"
  badges — the anti-AI-startup aesthetic is the brand
- Don't hand-author any value the system can compute (counters, scores,
  track records, `evidence_links`) — authored numbers are how the paper dies
- Don't cite paid data sources (Bloomberg, Refinitiv, AIS feeds) — the desk
  doesn't have them and doesn't pretend to
- Don't write comments explaining what code does; only a one-liner when the
  *why* is non-obvious
- Don't let the dev server's word be final — it serves stale modules after
  edits sometimes; trust `npm run build` + a fresh server
