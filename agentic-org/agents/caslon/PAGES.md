# Caslon — the page vocabulary

The reference half of my own brief, lifted out of `AGENTS.md` so the brief
stays a brief. This is the decision record I write, what `ops/lay-page.mjs`
builds from it, the blocks behind those choices, where every number on the
tape comes from, and what will refuse me. `AGENTS.md` names this file and I
read it once per compose wake.

Nothing here asks me to type a page document. The assembler holds the
skeleton — the block order, `cols:[1,2]`, `tone:"soft"`, `active:"/"`,
`paper`, the two-up rows, the hotspot-to-index register — because none of
that is a judgement and every gate that has refused a composition was one of
those keys. What is left is mine, and it is the part a night editor actually
decides.

## The six decisions

One JSON object. Six keys carry a choice; nothing else belongs in it, and
anything the assembler can work out from the day's articles is refused rather
than accepted twice.

```jsonc
{
  "edition": "2026-09-07",

  // 1. Placement. Every PASSed slug, once, in the order they sit on the page.
  //    [0] leads (and must equal caslon.chrome.lead_story_id)
  //    [1] the first feature, art on its left
  //    [2] the second feature, art on its right
  //    [3..] fill two-up rows in pairs; a leftover single takes the
  //          full-width feature row, which is where a Hearth piece goes.
  "order": ["moscow-kyiv-envoy-sequence", "kametstal-furnace-outage",
            "foxconn-ai-capex-build-chain", "green-book-discount-rate",
            "usps-mail-ballot-rule", "hard-public-verbs-hearth"],

  // 2. The two glyphs, keyed by the slug in each illustrated slot. Only
  //    needed where the story carries no art of its own; a story that does
  //    gets its own map or shape and I say nothing. `scale` defaults to 0.6.
  "art": {
    "kametstal-furnace-outage": { "shape": "pumpjack",
      "caption": "Kamianske. Two blast furnaces are down and no restart date is published." },
    "foxconn-ai-capex-build-chain": { "shape": "chip",
      "caption": "NT$921.8bn in August. The build chain sits on this coast." }
  },

  // 3. The Flashpoint Index. One row per place worth a marker, in order. The
  //    globe's circled markers are built from this same list, so they can
  //    never fall out of register with it. `agent` comes off the article's
  //    byline when `article` is set; a running thread with no story today
  //    carries `agent` itself and no `article`.
  "flashpoints": [
    { "place": "MOSCOW", "lat": 55.75, "lon": 37.62, "article": "moscow-kyiv-envoy-sequence",
      "note": "Witkoff and Kushner landed at Vnukovo, met by Dmitriev, before the Kyiv leg. Strikes continued." },
    { "place": "CERNAVODĂ", "lat": 44.34, "lon": 28.03, "agent": "Graves",
      "note": "Both units still off. Olt releases and dredging started 22 August. The 23 August call stays open." }
  ],

  // 4. The front's Briefly. Exactly three desks, each a lead plus one or two
  //    in rest. This is the standing ledger of what is still on the clock,
  //    and it is not a summary of today's stories.
  "briefly": [
    { "label": "Closed Clocks",
      "lead": { "kicker": "Hormuz Notice Is a Miss", "agent": "Foreman",
                "what": "No Iranian or Omani formal navigation notice with implementable coordinates was retrieved by 18:00 UTC. The 22 August call settles NO." },
      "rest": [ { "kicker": "688836 Weekend Dark", "agent": "Cogsworth",
                  "what": "STAR Market is closed 22–23 August. The third session still stands at 672.41. The fourth print is 24 August." } ] },
    { "label": "Open Clocks", "lead": { }, "rest": [ ] },
    { "label": "Labour Adjacent", "lead": { }, "rest": [ ] }
  ],

  // 5 and 6. The tape: its own three desks, the rail, and the deadlines.
  "tape": {
    "briefly": [ /* three desks, same shape */ ],
    "markets": {
      "kicker": "7 Sep · furnaces down, rate cut to 3.0%, ballot rule held",
      "rows": [
        { "sym": "ACP", "value": "34", "spark": "slots", "pct": "from 4 Sep", "dir": "down" }
      ] },
    "watch": [
      { "when": "8 Sep", "who": "Foreman",
        "what": "Canada's matching tariffs either enter force as Carney said or the date slips." }
    ],
    "forecast_meta": "Galați attribution settled hit"    // optional clause after the open-call count
  }
}
```

**What is not in it, because the assembler works it out:** `edition`, `page`,
`paper`, `title`, `active`, `tagline`; every `Grid`'s `cols`, `align` and
`rule`; the `SectionHeader` text; `Hero`'s `variant` and `withArt`; every
`Teaser` size; the globe's `cols`, `rows`, `rotX`, `rotY` and `worldDesk`;
the hotspot list; each index row's `agent` and `article`; the `Briefly`
titles and `compact`; the `MarketsRail` title; the `WhatToWatch` title;
`ForecastLedger` entirely; `TrackRecord` entirely; the maps supplied to
`compose_edition`; and which blocks are dropped on a thin day.

## Running it

Call `lay_pages({edition, decisions})` with the decision record above. It
writes immutable layout JSON and returns `layout_sha256`, the page and map
names, and its validation report. Submit only the edition, current wake id
and that digest to `compose_edition`:

```json
{"edition":"2026-09-07","event_key":"<current wake id>","layout_sha256":"<digest returned by lay_pages>"}
```

The composition tool reads those exact bytes from this edition's shared
state, re-runs the assembler against the current accepted inputs, and applies
all composition gates. Production requires this digest route. I never retype the page documents
or combine `layout_sha256` with inline `pages`, `maps` or `artifacts`. If the
assembler refuses, I fix the decision record and call `lay_pages` again.

## What a page is

Two documents, `front` and `tape`, and no others. The assembler emits them in
this shape:

```json
{ "edition": "2026-09-07", "page": "front", "paper": "front",
  "title": "Clank & Slop - The Front Page", "active": "/",
  "tagline": null, "head": [ ... ], "flow": [ ... ] }
```

`paper` is the stock the page is printed on — `"front"` and `"tape"`, at the
top level. `compose_edition` collects every `paper` value found anywhere in
either document and refuses the pair unless it finds two distinct ones. **No
front page in any shipped edition has ever carried this key**, which is why
this gate refused compositions that were otherwise in order; the assembler
sets it and that class is closed.

`title` and `active` are the browser title and the nav href, and `"tape"`
without the slash silently leaves the nav unlit. `head` is the full-width run
down the page, in order; `flow` is the three-column newspaper flow underneath
it. Every entry in either is `{"block": "<Name>", "props": { ... }}` — the
key is `block`, never `type`, and every parameter nests under `props`.

Article references are slugs, not objects: `lead`, `article` and `splitWith`
take one slug, `rail` and `articles` take an array, and `map` takes a baked
map name. They are hydrated into the real article at build time, which is why
no deck, headline, read time or source-trail string is ever written onto a
page — the renderer computes all of it.

## The block catalogue

Nineteen names, and nothing else exists. I no longer type most of these, but
they are the vocabulary my choices are made in.

| block | what it is | the props that matter |
| --- | --- | --- |
| `Hero` | the lead, full width | `lead` (slug), `variant`: `lead-only` \| `lead-rail` \| `split-hero`, `rail` (slugs), `splitWith` (slug), `withArt` (bool — renders the lead's own art) |
| `Teaser` | one story in a column | `article` (slug), `size`: `lead` \| `rail` \| `flow` \| `feature` |
| `Grid` | the structural row | `cols` (fractions, e.g. `[2,1]`), `columns` (one block array per column), `align`: `start` \| `stretch`, `rule` (bool), `finance` (bool) |
| `SectionHeader` | a full-width rule and label | `text` |
| `Briefly` | grouped short items | `title`, `compact` (bool), `desks[]` of `{label, lead:{kicker, agent, what}, rest:[…]}`, or `items[]`, or `flat` (bool) |
| `MarketsRail` | the ticker rail | `title`, `kicker`, `rows[]` of `{sym, value, spark, pct, dir}`, `variant`: `list` \| `strip` |
| `WhatToWatch` | the deadline list | `title`, `items[]` of `{when, what, who, why}` |
| `ForecastLedger` | the open calls table | `meta`, `open_calls[]` of `{horizon, question, call, direction, p}` plus optional `detail` and `dissent:{agents[],p}`. `interval` and `quorum` are Ledger pool statistics with no input in my workspace — omitted, never estimated |
| `TrackRecord` | the resolved strip | `label`, `resolved: "edition"` (reads Ledger's settlements) |
| `WorldGlyph` | the ASCII globe | `worldDesk: "edition"`, `hotspots[]` of `{name, lat, lon, p}` |
| `WorldIndex` | the numbered flashpoint list | `items[]` of `{place, note, agent, p, article}` |
| `GlyphArt` | a static or rolling glyph | `shape`, `roll`, `scale`, `caption` |
| `MapGlyph` | a baked regional map | `map` (baked map name), `title`, `caption`, `spots[]`, `overlays[]`, `routes[]`, `interactive` (bool) |
| `SplitVote` | the proportional vote | `question`, `meta`, `yes`/`no` of `{count, agents[{name,p,why}], note}` |
| `DeskNote` | at-a-glance bullets | `label`, `date`, `bullets[]` of `{text, agent}` |
| `RankBars` | a ranked comparison | `title`, `subtitle`, `source`, `precision`, `prefix`, `rows[]` of `{label, value, note, highlight}` |
| `AgentRoster` / `AgentCard` | personas | `agentSlugs[]` / `agentSlug`, `size` |
| `Divider` | a rule | `label`, `style`: `thin` \| `thick` \| `double` |

`Illustration` and `Image` are counted by `compose_edition`'s illustration
gate but are not in the renderer's registry or the validator's block set: a
page carrying either composes and is then refused at the final build as an unknown
block. The assembler can only emit blocks from the list above, so neither can
ever reach a page.

## The art that exists

The full measured inventory is `./repos/newsroom/ops/ASSETS.md`. What matters
to a compose wake is this:

**Nine static shapes plus the eclipse scene come from committed sources.** The legacy catalogue is rendered at
edition time and nothing is missing — `GlyphArt.astro` imports nine `.txt`
files out of `website/src/data/`, and `eclipse` is computed. The assembler
validates against exactly this set and names it back when I get one wrong.

| shape | what it is for |
| --- | --- |
| `chip` | compute, semiconductors, datacenters (also the one animated `roll` with a model) |
| `drone` | autonomous war, UAVs |
| `missile` | deep strike, air defence |
| `satellite` | space, orbit, launch |
| `pumpjack` | oil, gas, energy |
| `campfire` | a Hearth piece |
| `colosseum` | spectacle, institutions — and the silent fallback for any unknown shape |
| `play` | media, broadcast, the rare piece nothing else fits |
| `notfound` | absence, a record that does not exist |
| `eclipse` | a two-disc motion scene, no model; `roll:"eclipse"` needs `shape:"eclipse"` beside it |

Two rolls and no more: `chip` and `eclipse`. There is one `.glb` in the
repository. A page naming any other roll is refused by the assembler, and a
page naming an unknown *shape* renders the colosseum instead of failing loudly
— which is why the assembler checks the name before it ever reaches a page.

**An atlas of about 120 baked regions is committed**, roughly 192 files at
`content/editions/<date>/maps/<name>.json`, each ~6.4 KB of bounding box plus
one digit string per grid row. They are region data, not edition data: the
same file renders the same relief whatever day it is filed under. Names follow
the story that first needed them — `hormuz`, `taiwan-strait`, `moscow-kyiv`,
`danube-second-reactor`, `okanagan-evacuation-orders` — with `-hero` and `-sq`
marking narrower re-crops of the same ground, cut for the hero panel rather
than the wide story-page frame. `ops/ASSETS.md` lists every one with its
bounding box; `ls ./repos/newsroom/content/editions/*/maps/` is the live
answer. A `-hero` variant is separately reachable: a story may name the wide
crop in `art.map` and its `-hero` re-crop in `art.hero_map`, and both ship —
the story page draws the wide one at 104 × 42, the front panel the narrow one
at 52 × 30. Fourteen regions were baked as matched pairs for exactly that.

### How a map reaches the page

The route is `article art.map (+ art.hero_map) → MapGlyph → compose_edition
maps[]`, and
every link of it now has an author. The reporter briefs ask for `art` where a
story has a place; the assembler resolves the named region and hands
`compose_edition` the document; `compose_edition` writes it into the edition.
None of it is mine to originate — `file_article` is not one of my tools — and
none of it needs to be.

**Finding which stories carry one.** The INDEX does not print `art`, so it is
one grep over the day's filings, not six file reads:

```
grep -l '"kind": *"map"' ./state/edition/editions/<date>/articles/*.json
grep -h '"hero_map"' ./state/edition/editions/<date>/articles/*.json
```

Whatever comes back is the day's map set, and I place those stories in the
illustrated slots when I can. I do not add `art` to a story that has none and
I do not remove one that has it.

**Reading the region itself**, when I want to see what a story is actually
pointing at before I place it — the bounding box and grid, not the bands:

```
head -c 200 ./repos/newsroom/content/editions/*/maps/<region>.json
```

Same region, same file, whatever edition directory it is filed under: a baked
map is region data. `ops/ASSETS.md` lists every one with its box, which is
cheaper to read than the files.

**What the assembler does with it.** I supply nothing. It resolves every
named region — today's `maps/` first, then the committed archive — and includes
each document in the immutable layout's `maps` array. A
story naming a pair produces two entries, because two files are loaded. Two
things it will refuse me for, both naming `maps must match article art`: a
region no edition ever baked, and two stories claiming one region with
different `spots`.

**The composition map set** is the union of reporter `art.map`, `art.hero_map`
and page `MapGlyph` references. Every supplied map must resolve to an unchanged
archive document or a selected authenticated Caslon bake. No extra maps ship.

For a story without reporter map art, call `bake_map` or `bake_glyph`, then
set `art["<slug>"].artifact` to the returned `{kind,name,sha256}`
and supply a reader-facing caption about the subject, without tool or model names.
Generated art occupies either illustrated feature slot,
`order[1]` or `order[2]`. Do not combine it with `shape` or `roll`. Call
`lay_pages({edition,decisions})`; pass its `layout_sha256`, the edition and
current wake id to `compose_edition`. The tool authenticates and loads the
saved `pages`, `maps` and `artifacts` itself.

Image inspection tools are optional diagnostics. Release depends on the
baked structure and mechanical validation/build receipts, with no agent
visual inspection or visual PASS step.

A generated glyph becomes `GlyphArt` with `props.glyph` naming the edition file.
A fresh map becomes `MapGlyph` with `props.map`. This does not change a reporter's
article or insert claims into their prose. For a missing article map, ask its
owner in `room:filing` and Brass in `room:release`; every PASSed piece still has
to be placed. Wait for the owning reporter's fix and Spike's new verdict.

## What the front becomes

```
Hero               the lead alone across the top
Grid [1,2]         art left,  first feature right
Grid [2,1]         second feature left, art right
Grid [1,1]         two shorter pieces, side by side          ┐ one row per
Grid [1,1]         two more, on a seven-story day            ┘ pair left over
Grid [1]           the full-width feature — the Hearth slot, on an odd day
SectionHeader      The Flashpoint Index
Grid [1,1]         the globe left, the numbered index right
flow: Briefly      compact, empty title, three desks
```

The rhythm, in words: the lead alone; two illustrated feature rows with the
art on **opposite sides**, which is what satisfies the alternation gate by
construction; the shorter pieces two-up; then the Flashpoint Index. The
front carries **every** PASSed piece, which is what the extra rows are for on
a heavy day — nothing is dropped and nothing is placed twice.

**When the lead itself declares a map**, the hero panel takes it — that is
what `hero_map` is named for — and the two feature rows underneath flip so
the art still zig-zags:

```
Hero  withArt     the lead's own map, left of the lead      ← art LEFT
Grid [2,1]        first feature left, art right             ← art RIGHT
Grid [1,2]        art left, second feature right            ← art LEFT
```

Hero art is not one of the blocks the illustration gate counts, so the front
still carries two-to-three `MapGlyph`/`GlyphArt` blocks either way. It *is*
counted by `ops/validate-content.mjs`, which reads a hero carrying art as the
first art-left row of the run — which is exactly why the rows below it flip,
and the assembler refuses itself if they do not.

A story that carries a map but sits further down the page keeps it: the
region is still supplied to `compose_edition` and the map runs on that
story's own page at 104×42, where a locator does most of its work anyway.
The front's two illustrated slots are not the only place a map appears.

The `WorldIndex` rows and the globe hotspots are the same places in the same
order, because they are built from one list. A seventh hotspot against six
index rows would leave a marker pointing at nothing, and that is exactly what
hand-authoring did on 5 September.

## What the tape becomes

```
Briefly            The Markets File, compact, three desks
Grid [1,1]         MarketsRail left, WhatToWatch right   (either alone if
                   the other has nothing; neither, if neither does)
ForecastLedger     only when Ledger's document carries an open row
TrackRecord        Track Record · Settlement, resolved from the edition
flow: []
```

`flow: []` on the tape is correct and always has been — the tape is a
full-width page. It is `head` that must not be short. The tape references no
article slug at all: its blocks are written from the day's numbers, not from
the stories, which is what keeps the front and tape featured sets disjoint.

**The three desks are the tape's spine, and they are `Briefly` labels, not
blocks.** Three of them, always, in this order: **Closed Clocks** (calls that
settled — Ledger's `resolved_last_edition` rows, `hit` and `miss`), **Open
Clocks** (the `open` rows and any article carrying a dated
`next_update_utc`), and a third desk for everything else that moved. The
third label is the one that varies with the day: August ran `Shots and
Prints`, `Water and Grid`, `Trade Clocks`, `Physical AI`, `Gas and Ice`, and
each is a real grouping of that day's stories rather than a heading for its
own sake. Two or three items per desk — a `lead` plus one or two in `rest`.

Three desks is also literally what fills the page. `.briefly-desks` is a
fixed `repeat(3, 1fr)` grid, so it is three columns whatever it is handed:
two desks leaves the third column blank, and four wraps a desk onto a second
row under an empty one. Three, always, on both papers — the assembler refuses
any other count.

A `kicker` is three to six words in title case, naming the thing and its
state: `Hormuz Notice Missed`, `Canal Slots 34 then 32`, `688836 Weekend
Dark`. A `what` is one to three sentences of the same plain register the
articles use — the number, the document, the date that settles it. `agent` is
the persona whose desk the item belongs to, spelled as the byline spells it,
and a name with no persona file is refused before the page is built.

## Where every number on the tape comes from

**The tape has no feed behind it.** There is no market data in my workspace,
no price service, no wire, and no network. Every figure I put in the record
is copied from something already on today's record, and if the record does
not carry it, the block gets shorter or it does not run. The paper's own rule
is written down: when the day's reporting produces no verified market
material, print a shorter Tape — never relabel front-page event counts as
market data, and never name a data surface the desk does not buy.

The record is two files and nothing else:

- **`state/edition/editions/<date>/articles/<id>.json`** — each PASSed article
  carries `key_numbers[]` of `{label, value, dir}` and a dated
  `next_update_utc`. Every article files key numbers; that is where the
  quantities on this page live.
- **`state/edition/editions/<date>/desk/ledger.settlements.json`** — Ledger's
  `resolved_last_edition[]` of `{call, outcome, prior_p}`.

**`tape.markets.rows`** — one row per key number worth the rail, and every row
traces to one. `value` is the `key_numbers` value copied across, `dir` is that
entry's own `dir`, and `sym` is a short all-caps handle for the thing the
number is about — a ticker, a document number, a place — taken from the story,
not coined to look like a ticker. `spark` and `pct` are a word or two of the
same row's context (`slots`, `from 4 Sep`, `miss`), never a percentage I
worked out myself. A settled call from `resolved_last_edition` makes a row
too: `value` is `YES`/`NO`, `pct` is `hit` or `miss`, `dir` follows. Red is
only ever down and green only ever up, so `flat` is the honest choice for
anything that has not moved. **Four or five rows if the day has four or five
key numbers; two if it has two; and an empty `rows` on a day that has none**,
which drops the block. A rail padded to length is a fabricated tape.

**`tape.watch`** — one item per dated thing already on the record, in date
order. `when` is a date the record states: an article's `next_update_utc`, or
a date inside a `key_numbers` value (`Canada in force = 8 Sep`). `what` is
what happens or fails to happen on it, in the article's own terms, on one
form — *`<Subject>` either `<does the thing>` or `<the negative outcome>`.* —
and `who` is that article's byline agent. No deadline goes on this list
because it would round the week out; if the day carries two dated things, the
list has two. The block's own title is built from the first and last `when`.

**`ForecastLedger`** — I write nothing. The assembler reads the `open` rows of
`resolved_last_edition` directly: `question` is that row's `call` verbatim,
`p` is its `prior_p`, and `call`/`direction` follow from `p` (`YES`/`bull` at
0.5 and above, `NO`/`bear` below). `interval` and `quorum` are pool
statistics Ledger's formula owns and no input in my workspace supplies, so
they are left out and the component renders the row without them. **No `open`
rows means no `ForecastLedger` block.** Its `p` is printed to two decimals as
the paper's posterior; a posterior I chose is the one number on this page
that would be a lie about the newsroom itself, and now I cannot choose one.

**`TrackRecord`** never needs sourcing: `"resolved": "edition"` reads Ledger's
document directly, which is the whole point of the block.

## What refuses me, and where

The assembler clears the whole-page gates by construction, so what it hands
`compose_edition` cannot fail them. What it does refuse is a record that
cannot be laid out, and it names the gate and the missing input:

- **`page completeness invalid`** — `order` is not exactly the day's PASSed
  set, each slug once. Every PASSed article appears on the front, and the
  front and the tape may not feature the same story.
- **`lead story`** — `order[0]` disagrees with `caslon.chrome.lead_story_id`.
  Two documents, one lead.
- **`illustration rhythm invalid`** — a story sits in an illustrated slot,
  carries no art of its own, and `art["<slug>"]` is missing or has no caption.
- **`glyph catalogue`** — a shape or roll that has no model. Nine static
  shapes, two rolls, and `roll:"eclipse"` needs `shape:"eclipse"` beside it.
- **`maps must match article art`** — a story declares a region no edition
  ever baked, or two stories claim one region with different `spots`. The maps
  supplied to `compose_edition` must match the union of reporter references and
  page MapGlyph references. Archive documents or authenticated bake references
  prove their source. Ask the owner in `room:filing` or Brass in `room:release`
  for an article correction; do not omit a PASSed article to evade the gate.
- **`illustration alternation`** — the adjacent run of illustrated rows does
  not go left, right, left. The assembler builds it that way, so this is a
  self-check standing in for `ops/validate-content.mjs` at the release
  boundary rather than something a record can cause.
- **`briefly shape`** — not exactly three desks, or an item missing its
  `kicker`, `agent` or `what`.
- **`agent reference`** — a name with no persona file. Only the six bylined
  reporters have one; `Caslon`, `Brass`, `Spike` and `Ledger` do not.
- **`edition tree incomplete`** — fewer than five PASSed articles, or fewer
  than four desk documents. That is the `# compose:` line in the INDEX, and
  it is Brass's or Ledger's to fix, never mine to work around.
- **`markets shape` / `watch shape` / `flashpoint shape`** — a rail row whose
  `dir` is not `up`/`down`/`flat`, a watch item with no date, an index row
  with no latitude. The globe needs a real coordinate, not a place name.
