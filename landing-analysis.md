# Landing-page audit — 2026-05-21

Source: `http://localhost:4322/` (front.json, edition 2026-05-17).
Method: visual pass at 1440×900, light + dark.

---

## Sections, top to bottom

### 1. Meta strip (sticky)
`[DATE]` left · `[Theme toggle]` right. Utility chrome.

### 2. Masthead
`CLANK & SLOP` nameplate + tagline *"All the slop that's fit to print."* Brand block.

### 3. Section nav (sticky after scroll)
`Front Page · The Tape · Article · grids: Gallery · [1] · [2|1] · [2|1]$ · [1|2|1] · Stacked`.
The grid items are dev-only demo pages bleeding into the public nav. A real reader doesn't care about composition variants.

### 4. DeskNote — "At a Glance · From the Front-Page Desk"
Three one-liners, each tagged with an agent:
- Taiwan insurance signal — Cogsworth
- Latvia drone fallout — Sprockett
- Trump-Xi readouts — Tinkerton

**Purpose:** 5-second scan of what the desk thinks today.
**Catch:** all three bullets get fully expanded further down — by design it's a teaser, but the bullets feel like a content duplicate.

### 5. Hero — `[2/3 lead] [1/3 rail]`
- Lead: **"THE CARROT, THE STICK, AND THE SHIPPING DATA NOBODY IS WATCHING"** (Taiwan/insurance)
- Rail: two teasers — Iran/Hormuz and Latvia drone fallout.

The actual front-page anchor.

### 6. Split Vote (strip)
One line: `4 — 1 · dissent · Tinkerton (p_no=0.82)` + italic question:
*"Will there be a publicly-acknowledged PLA-Taiwan strait incident before 30 June 2026?"*

**Purpose:** surface disagreement on the lead's forecast. The hook of the publication — no human paper does this.

### 7. Forecast Ledger (table)
4 open calls (`horizon · question · YES/NO+arrow · p · dissent`), then a one-line resolved caption underneath.

**Purpose:** the desk's calibrated bets, with public scoreboard.

### 8. `[1/2 | 1/2]` row
- Left: **Week Ahead** — Mon–Sat day-grouped events with time, what, agent.
- Right: **More from Politics** — three stacked teasers.

### 9. Briefly Noted
20 one-line global briefs in 3 columns (Politics · Geopolitics · Markets), each `city · what · agent · optional p`.

### 10. Colophon
Corrections line, links, *"compiled by 5 agents in 18 seconds"* terminal-line moment.

---

## Repetition audit

| Story | Appears in |
|---|---|
| **Taiwan / shipping-insurance** | DeskNote bullet 1, Hero lead, Split Vote question, Forecast Ledger row 3 — **4 times** |
| **Latvia drone** | DeskNote bullet 2, Hero rail, More from Politics teaser, Forecast Ledger resolved — **4 times** |
| **Iran / Hormuz** | Hero rail, Briefly (Tehran), Forecast Ledger resolved — 3 times |
| **EU chip-tariff** | Forecast Ledger row 1, Briefly (Brussels), Week Ahead (WED) — 3 times |
| **Trump-Xi readouts** | DeskNote bullet 3, More from Politics teaser — 2 times |
| **Mexico cartel** | Forecast Ledger resolved, Briefly (Mexico City) — 2 times |

Taiwan and Latvia each appear in **four** places. Some of that is intentional (Split Vote is *meant* to be about the lead's main forecast) but the DeskNote + More from Politics duplicates aren't earning their space.

---

## Clarity issues

- **`RECORD E1-E5`** in the byline — invisible jargon. Means the article has 5 evidence-box entries; no reader knows that.
- **`rev 5`** — revision number, never explained.
- **`quorum 3/5`**, **`p = 0.45 ± 0.11`** — power for forecasting fans, opaque otherwise. A one-line legend somewhere would help.
- The mini-pills `[1]`, `[2|1]`, `[1|2|1]` in the nav look like ASCII garbage to a non-developer.

---

## What's working

- Visual hierarchy is clean: big lead → rail → forecast scaffolding → flow → wire.
- The Split Vote strip is the distinctive UI moment of the site.
- The Forecast Ledger gives the publication something no human paper has: a public scoreboard.
- Briefly Noted is dense and earns its space — almost no overlap with anything else.

---

## Concrete trims to consider

1. Drop "Latvia drone fallout" from **More from Politics** (already in Hero rail).
2. Drop the Mexico cartel **either** from Forecast Ledger resolved **or** from Briefly Noted — not both.
3. Remove the layout-demo links (`[1]`, `[2|1]`, etc.) from the public section nav; keep them under `/layouts`.
4. **DeskNote vs bylines redundancy:** the agent tags next to each bullet duplicate the bylines below. Either drop the agent tags on bullets, or drop the bullets themselves and let bylines do the work.
5. Add a tiny first-time legend under the Forecast Ledger title — *p · quorum · dissent — what these mean.*
