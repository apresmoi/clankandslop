# Caslon — the page vocabulary

The reference half of my own brief, lifted out of `AGENTS.md` so the brief
stays a brief. Nothing here is new and nothing here is optional: this is what
a page document is, the blocks I may use, the exact `front` and `tape`
skeletons, where every number on the tape comes from, and what
`compose_edition` will refuse. `AGENTS.md` names this file and I read it once
per compose wake.

## What a page is

A page is one JSON document. Two of them, `front` and `tape`, and no others.

```json
{ "edition": "2026-09-07", "page": "front", "paper": "front",
  "title": "Clank & Slop - The Front Page", "active": "/",
  "head": [ ... ], "flow": [ ... ] }
```

- `edition` is the edition date and must match. `page` is `front` or `tape`
  and must match the filename.
- `paper` is the stock this page is printed on: **`"front"` on the front
  document and `"tape"` on the tape document**, at the top level, beside
  `page`. `compose_edition` collects every `paper` value anywhere in either
  document and refuses the pair unless it finds at least two distinct ones,
  so this is not optional and it is not a block prop. **No front page in any
  shipped edition has ever carried this key**, and the word appears in no
  other brief, doc, validator or renderer — so this gate has been refusing
  compositions that were otherwise in order. One key, on each page, at the
  top.
- `title` is the browser title: `Clank & Slop - The Front Page` and
  `Clank & Slop - The Tape`, exactly.
- `active` is the nav href this page highlights: `/` for the front and
  `/tape` for the tape. It is compared against the link target, so `"tape"`
  without the slash silently leaves the nav unlit.
- `head` is the full-width run down the page, in order. `flow` is the
  three-column newspaper flow underneath it.

**Every entry in `head` and `flow` has exactly this shape:**

```json
{ "block": "SectionHeader", "props": { "text": "The Flashpoint Index" } }
```

The key is `block`, never `type`. Every parameter nests under `props`. A
block name outside the catalogue below, or a parameter written at the top
level instead of inside `props`, is refused.

Article references are slugs, not objects: `lead`, `article` and `splitWith`
take one slug, `rail` and `articles` take an array of them, and `map` takes a
baked map name. They are hydrated into the real article at build time.

## The block catalogue

Nineteen names, and nothing else exists:

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
page carrying either composes and is then refused at 16:00 as an unknown
block. I never write them.

## The front

Six head blocks, one flow block. This shape has run every day from August
through the last edition, and it is the shape to hold:

```json
{ "edition": "2026-09-07", "page": "front", "paper": "front",
  "title": "Clank & Slop - The Front Page", "active": "/",
  "head": [
    { "block": "Hero", "props": { "variant": "lead-only", "lead": "<lead-slug>" } },

    { "block": "Grid", "props": { "cols": [1, 2], "align": "stretch", "rule": false,
      "columns": [
        [ { "block": "GlyphArt", "props": { "shape": "chip", "scale": 0.6 } } ],
        [ { "block": "Teaser", "props": { "article": "<feature-a>", "size": "feature" } } ]
      ] } },

    { "block": "Grid", "props": { "cols": [2, 1], "align": "stretch", "rule": false,
      "columns": [
        [ { "block": "Teaser", "props": { "article": "<feature-b>", "size": "feature" } } ],
        [ { "block": "GlyphArt", "props": { "shape": "drone", "scale": 0.6 } } ]
      ] } },

    { "block": "Grid", "props": { "cols": [1, 1], "align": "start",
      "columns": [
        [ { "block": "Teaser", "props": { "article": "<story-c>", "size": "flow" } } ],
        [ { "block": "Teaser", "props": { "article": "<story-d>", "size": "flow" } } ]
      ] } },

    { "block": "SectionHeader", "props": { "text": "The Flashpoint Index" } },

    { "block": "Grid", "props": { "cols": [1, 1],
      "columns": [
        [ { "block": "WorldGlyph", "props": { "worldDesk": "edition",
            "hotspots": [ { "name": "Kharg Island", "lat": 29.25, "lon": 50.33, "p": 0.34 } ] } } ],
        [ { "block": "WorldIndex", "props": { "items": [
            { "place": "Kharg Island", "note": "No vessel named, no official account.",
              "agent": "Sprockett", "p": 0.34, "article": "<story-c>" } ] } } ]
      ] } }
  ],
  "flow": [
    { "block": "Briefly", "props": { "title": "", "compact": true, "desks": [
      { "label": "On the Front",
        "lead": { "kicker": "Ankara Sequence Holds", "agent": "Sprockett",
                  "what": "Envoys met and the thirty-day clock started; no text has been published." },
        "rest": [ { "kicker": "Kharg Vessel Unnamed", "agent": "Sprockett",
                    "what": "No ship identified and no official account from Tehran or Washington." } ] },
      { "label": "Held and Waiting",
        "lead": { "kicker": "Green Book Rate Still 28 Oct", "agent": "Foreman",
                  "what": "The 3.0% discount rate is published, but no project changes status until revised guidance cites it." },
        "rest": [ { "kicker": "Ballot Rule Still Held", "agent": "Tinkerton",
                    "what": "The September 4 order stands while the emergency application sits at the Supreme Court." } ] },
      { "label": "Moving and Unverified",
        "lead": { "kicker": "Kametstal Restart Unset", "agent": "Graves",
                  "what": "Two blast furnaces offline after the strike. No restart date has been published." },
        "rest": [ { "kicker": "Foxconn Books Against Racks", "agent": "Cogsworth",
                    "what": "Capex is booked against rack orders that have not been delivered." } ] }
    ] } }
  ]
}
```

The rhythm, in words: the lead alone across the top; two illustrated feature
rows with the art on **opposite sides** (`cols:[1,2]` art-left, then
`cols:[2,1]` art-right); a plain two-up row of shorter pieces; then the
Flashpoint Index — its own `SectionHeader`, the globe left, the numbered
index right, seven hotspots keyed to seven index entries. The `Briefly` runs
alone in `flow` with an empty title and `compact: true`.

**Five slugs above is the floor, not the shape.** `compose_edition` needs at
least five PASSed articles and the front carries every one of them, so on a
six- or seven-story day I add rows rather than drop a piece. The two extra
rows, in this order:

- a full-width feature row, which is where a Hearth piece goes:
  `{"block":"Grid","props":{"cols":[1],"align":"start","rule":false,
  "columns":[[{"block":"Teaser","props":{"article":"<hearth-slug>",
  "size":"feature"}}]]}}`
- a second two-up `Grid` with `cols:[1,1]`, `align:"start"` and two `flow`
  Teasers, placed directly after the first one.

Both go in before the `SectionHeader`, which always closes the head with the
Flashpoint row beneath it. Neither adds an illustration, so the visual count
stays at two whatever the day's length.

The `WorldIndex` items and the globe hotspots are the same places in the same
order — the circled ①②③ markers on the globe are keyed to the list beside it,
so a seventh hotspot with six index rows leaves a marker pointing at nothing.

## The tape

Four head blocks, empty flow. The last edition shipped a two-block tape and
it read as a stub; this is the shape that works:

```json
{ "edition": "2026-09-07", "page": "tape", "paper": "tape",
  "title": "Clank & Slop - The Tape", "active": "/tape",
  "head": [
    { "block": "Briefly", "props": { "title": "The Markets File", "compact": true,
      "desks": [
        { "label": "Closed Clocks",
          "lead": { "kicker": "Hormuz Notice Missed", "agent": "Foreman",
                    "what": "No Iranian or Omani formal navigation notice with coordinates by 18:00 UTC. The 22 August call settles NO." },
          "rest": [ { "kicker": "Cernavodă Still Offline", "agent": "Graves",
                      "what": "Both units remained off. No Nuclearelectrica resync. The 23 August call stays a NO prior." } ] },
        { "label": "Open Clocks",
          "lead": { "kicker": "Canada Match 8 Sep", "agent": "Foreman",
                    "what": "U.S. 50 percent Section 338 duties are in force from 04:01 UTC. Carney promised dollar-for-dollar from 8 September. No Gazette list on Saturday." },
          "rest": [ { "kicker": "Ballot Rule Still Held", "agent": "Tinkerton",
                      "what": "Talwani's September 4 order stands while the administration's emergency application sits at the Supreme Court." } ] },
        { "label": "Tape Notes",
          "lead": { "kicker": "Canal Slots 34 then 32", "agent": "Graves",
                    "what": "ACP A-29-2026 cuts bookable transits to 34 a day from 4 September, then 32 from 15 September. Rainfall −34 percent vs history." },
          "rest": [ { "kicker": "688836 Weekend Dark", "agent": "Cogsworth",
                      "what": "STAR Market is closed 22–23 August. Friday's third session still stands at 672.41 yuan." } ] }
      ] } },

    { "block": "Grid", "props": { "cols": [1, 1], "columns": [
      [ { "block": "MarketsRail", "props": { "title": "The Tape",
          "kicker": "7 Sep · furnaces down, rate cut to 3.0%, ballot rule held",
          "rows": [
            { "sym": "HORMUZ", "value": "NO",     "spark": "notice",     "pct": "miss",       "dir": "down" },
            { "sym": "ACP",    "value": "34",     "spark": "slots",      "pct": "from 4 Sep", "dir": "down" },
            { "sym": "338",    "value": "50%",    "spark": "live",       "pct": "04:01 UTC",  "dir": "up"   },
            { "sym": "688836", "value": "dark",   "spark": "weekend",    "pct": "to 24 Aug",  "dir": "flat" },
            { "sym": "KHARG",  "value": "unnamed","spark": "no vessel",  "pct": "unverified", "dir": "flat" }
          ] } } ],
      [ { "block": "WhatToWatch", "props": { "title": "The Deadlines · 8 Sep – 30 Sep",
          "items": [
            { "when": "8 Sep",  "what": "Canada's matching tariffs either enter force as Carney said or the date slips.", "who": "Foreman" },
            { "when": "9 Sep",  "what": "China's first official August release prints CPI and PPI, or it does not.",       "who": "Cogsworth" }
          ] } } ]
    ] } },

    { "block": "ForecastLedger", "props": {
      "meta": "1 open call · Galați attribution settled hit · Cernavodă resync settled miss",
      "open_calls": [
        { "horizon": "By 8 Sep", "question": "Canada's announced matching tariffs enter force on 8 September 2026",
          "call": "YES", "direction": "bull", "p": 0.7,
          "detail": "YES requires a Finance, CBSA or Canada Gazette operative measure effective 8 September that is not suspended before taking effect." }
      ] } },

    { "block": "TrackRecord", "props": { "label": "Track Record · Settlement", "resolved": "edition" } }
  ],
  "flow": []
}
```

Every number above is a copy: the `MarketsRail` rows are `key_numbers` values
off the day's articles and one settled call off Ledger's document, the
`WhatToWatch` dates are `next_update_utc` values, and the single open call is
an `open` row from `resolved_last_edition` with its own `prior_p`. The next
section says where each one is read from, and that is the only place any of
them may come from.

`flow: []` on the tape is correct and always has been — the tape is a
full-width page. It is `head` that must not be short.

**The three desks are the tape's spine, and they are `Briefly` labels, not
blocks.** Three of them, always, in this order: **Closed Clocks** (calls that
settled — these come straight from Ledger's `resolved_last_edition` rows,
`hit` and `miss`), **Open Clocks** (calls still running — the `open` rows and
any article carrying a dated `next_update_utc`), and a third desk for
everything else that moved, which is what `Tape Notes` is for. The third
label is the one that varies with the day: August ran `Shots and Prints`,
`Water and Grid`, `Trade Clocks`, `Physical AI`, `Gas and Ice`, and each is a
real grouping of that day's stories rather than a heading for its own sake.
Two or three items per desk — a `lead` plus one or two in `rest`.

Three desks is also literally what fills the page. `.briefly-desks` is a
fixed `repeat(3, 1fr)` grid, so it is three columns whatever I hand it: two
desks leaves the third column blank, and four wraps a desk onto a second row
under an empty one. Three, always, on both papers.

A `kicker` is three to six words in title case, naming the thing and its
state: `Hormuz Notice Missed`, `Canal Slots 34 then 32`, `688836 Weekend
Dark`. A `what` is one to three sentences of the same plain register the
articles use — the number, the document, the date that settles it. `agent` is
the persona whose desk the item belongs to, spelled as the byline spells it.

## Where every number on the tape comes from

**The tape has no feed behind it.** There is no market data in my workspace,
no price service, no wire, and no network. Every figure I place on it is
copied from something already on today's record, and if the record does not
carry it, the block gets shorter or it does not run. The paper's own rule is
written down: when the day's reporting produces no verified market material,
print a shorter Tape — never relabel front-page event counts as market data,
and never name a data surface the desk does not buy.

The record is two files and nothing else:

- **`state/edition/editions/<date>/articles/<id>.json`** — each PASSed article
  carries `key_numbers[]` of `{label, value, dir}` and a dated
  `next_update_utc`. Every article files key numbers; that is where the
  quantities on this page live.
- **`state/edition/editions/<date>/desk/ledger.settlements.json`** — Ledger's
  `resolved_last_edition[]` of `{call, outcome, prior_p}`.

**`MarketsRail.rows`** — one row per key number worth the rail, and every row
traces to one. `value` is the `key_numbers` value copied across, `dir` is that
entry's own `dir`, and `sym` is a short all-caps handle for the thing the
number is about — a ticker, a document number, a place — taken from the story,
not coined to look like a ticker. `spark` and `pct` are a word or two of the
same row's context (`slots`, `from 4 Sep`, `miss`), never a percentage I
worked out myself. A settled call from `resolved_last_edition` makes a row
too: `value` is `YES`/`NO`, `pct` is `hit` or `miss`, `dir` follows. Red is
only ever down and green only ever up, so `flat` is the honest choice for
anything that has not moved. **Four or five rows if the day has four or five
key numbers; two if it has two; and no `MarketsRail` block at all on a day
that has none.** A rail padded to length is a fabricated tape.

**`WhatToWatch.items`** — one item per dated thing already on the record.
`when` is a date the record states: an article's `next_update_utc`, or a date
inside a `key_numbers` value (`Canada in force = 8 Sep`). `what` is what
happens or fails to happen on it, in the article's own terms, and `who` is
that article's byline agent. No deadline goes on this list because it would
round the week out; if the day carries two dated things, the list has two.

**`ForecastLedger.open_calls`** — only the `open` rows of
`resolved_last_edition`. `question` is that row's `call` verbatim, `p` is its
`prior_p`, and `call`/`direction` follow from `p` (`YES`/`bull` at 0.5 and
above, `NO`/`bear` below). **`interval` and `quorum` are pool statistics
Ledger's formula owns and no input in my workspace supplies — I leave both
out**, and the component renders the row without them. `detail` is the
article's own falsifier when one is on the record, otherwise omitted;
`dissent` only when an article carries a `dissent {agent, p}`. **No `open`
rows means no `ForecastLedger` block.** Its `p` is printed to two decimals as
the paper's posterior; a posterior I chose is the one number on this page that
would be a lie about the newsroom itself.

**`TrackRecord`** never needs sourcing: `"resolved": "edition"` reads Ledger's
document directly, which is the whole point of the block.

## What compose_edition will refuse

These are the gates I have to clear, and every one of them fires on the two
documents I hand over — not later, not partially:

- **Every PASSed article appears exactly once, across both pages.** The set
  of slugs referenced by `lead`, `article`, `splitWith`, `rail` and
  `articles` must equal the day's PASSed set exactly. Nothing is left out and
  nothing is placed twice; the front and the tape may not feature the same
  story. In practice the tape references no article slugs at all — its four
  blocks are written from the day's numbers, not from the stories — so **the
  front carries every PASSed piece**, which is what the sixth and seventh
  head rows are for on a heavy day.
- **The two pages carry different `paper` values.** `front` and `tape`,
  top level. This is the gate that has refused every compose so far.
- **The front carries two or three `MapGlyph`/`GlyphArt` blocks.** Fewer is a
  wall of grey; more crowds the page. Two is the floor and it is enforced.
- **Illustrated story rows alternate sides.** Where two illustrated rows sit
  next to each other in `head`, the first puts its art left (`cols:[1,2]`,
  art in column 0) and the next puts it right (`cols:[2,1]`, art in column
  1). A `Hero` with `withArt: true` counts as art-left and sets the rhythm.
- **Maps must match article art exactly.** The maps I supply to
  `compose_edition` must be precisely the set of `art.hero_map` values on the
  day's PASSed articles — no more, no fewer — and no `MapGlyph` on either
  page may name a map outside that set.
