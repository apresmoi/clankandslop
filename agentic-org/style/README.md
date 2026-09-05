# Style — what this is and how it got here

On 2026-09-05 the newsroom produced its first complete edition and the prose was
bad in a specific, diagnosable way. This folder is what came out of fixing it.
Nothing here is deployed yet. `CLANK_TO_PROD.md` §5m and §1b carry the plan.

## The two findings that explain almost everything

**We deleted a working style guide.** `clankandslop-private/COMPOSE-STYLE.md`
(2,042 words) went into every writing prompt until the 2026-08-24 scaffold replaced
it with ~110 words. It already banned pipeline vocabulary, hedge scaffolding and
capped contrast at one. **15 of 15 August leads are event-first; 3 of 5 on 09-05
were not.** The sheet is still on disk, unused.

**The editor required the word we were trying to ban.** Spike's brief and the review
checklist said the discriminator "has to actually be operational in the piece", so
reporters printed *discriminator* to pass review — 4 of 5 pieces. Fixed in PR #107
across ten agents' standing rules, Spike, Cogsworth, Vesta, Brass and the root
brief. Deliberately **not** replaced with "falsifier"; that just moves the echo.

## Files

| file | what it is |
|---|---|
| `general-tier.md` | **The shared prose tier, 414 words.** Ships as the standing writing rules for all six desks. Validated in isolation on all five wire desks. |
| `vesta-brief.md` | **The rewritten Hearth brief.** Replaces Vesta's `AGENTS.md` section. Cold-tested: clean on every tell, first draft, no revision passes. |
| `rules-01…05` | The four rule sets written across the afternoon, in order of sharpness. Kept because they show *why* each rule exists; `general-tier.md` is the distillation. |
| `drafts/` | The evidence. `hearth-original` → `v4` → `v5` → `weave` → `cold3` shows the Hearth going from unreadable to over-corrected to right. The five `*-rewritten` files are each wire desk under the tier. |

## What the tier did, measured

Each reporter run in isolation with only its own `AGENTS.md` plus the tier:

```
              scaffolding    words
Sprockett        5 → 0     481 → 297
Graves           3 → 0     436 → 266
Cogsworth        2 → 0     443 → 363
Foreman          2 → 0     402 → 346
Tinkerton        5 → 0     434 → 338
```

Foreman's arithmetic paragraph survived intact. All five desks remain
distinguishable in a blind read — by beat and desk logic, not sentence texture.

## Three amendments before it ships

- **Contrast "once" reads as "never".** It cost Graves his desk's axis
  ("furnace-days offline rather than prices" was the only sentence carrying
  physical-flow-not-price) and all three of Cogsworth's, which were his habit in
  August and not part of the disease. Reword as an allowance: *use one; make it the
  best sentence in the piece.*
- **Banning the checklist's label left the structure standing** in three pieces.
  Needs a structural form: one conditional sentence about later evidence per piece.
- **"has not been made public"** invites a false statement when the document exists
  but is unread. Permit *"the order has not been reviewed here."*

## Three additions

- **Every paragraph carries a cited fact.** August cited nearly every sentence; the
  rewrites lost it in four paragraphs across three pieces.
- **Name a thing before you use it.** Compression reorders and creates dangling
  antecedents — Cogsworth's "Rubin racks" appear a paragraph before they are
  introduced.
- **A rewrite adds no fact the original did not carry.** This one is from a mistake:
  a reporter was instructed to "say what the rule requires" with no source, and
  wrote barcodes and portal uploads from memory, cited to evidence nobody read. A
  first-law violation caused by a prompt.

## The Hearth is a separate tier

Movement is **weave → smoke → residue**. The third was missing entirely: the column
stated a pattern, tested it, and stopped.

Two lines in her old brief *caused* the failure:

> "End on the punch… If my sharpest sentence sits in paragraph two, I'm not done."

An aphorism per paragraph, so the last one can beat it.

> "checks its own vision at least once… in the same paragraph, on purpose."

A hedge everywhere instead of one central null. The old brief also demonstrated the
disease — six antitheses in 855 words.

**The pitch is load-bearing.** Given raw facts the brief invents a shape that fits
the easy examples and drops the hard one (it dropped Kharg, the only case where the
right act was to say nothing). Given the shape, it executes it. The assignment must
carry the shape into the writing wake — **which has no prompt at all**, only Brass's
message.

## What a rule cannot fix

- **Cadence.** Vesta filed on 09-04 and 09-05 against "back once in roughly seven
  editions". Needs a gate in `recordAssignment`, not a sentence.
- **The prose lints ran at 16:00**, after the editor passed the piece at 14:00.
  Moved to `fileArticle` in PR #107.
- **The research files hand each reporter "Confidence… Unresolved…" sections**,
  which is the raw material they paraphrase into scaffolding. Upstream of every
  prose rule here.
