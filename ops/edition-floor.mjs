// The one place the edition's composition floor lives.
//
// It used to live in three, and they disagreed. PR #188 lowered the floor to
// four in `agentic-org/scripts/compose-gate.mjs` and left a literal 5 in
// `ops/lay-page.mjs` and `agentic-org/scripts/production-newsroom.mjs`. On
// 2026-09-27 the gate therefore reported
//   `passed=4/4 desks=4/4 sections=3/3 owners=4/4 ... -> ready`
// and the page assembler refused the same book: "at least 5 PASSed articles
// required, found 4". Caslon read both, believed the assembler, and said so:
// "compose gate says ready, but the page assembler still wants five PASSed
// slugs before it will lay. I cannot invent a fifth." It was right to refuse.
//
// A floor stated in more than one place is a floor that will eventually
// disagree with itself, and the disagreement surfaces as an agent being blamed
// for a lineup it cannot change. Import these; never restate the number.
//
// `ops/` is the lower layer: it imports nothing from `agentic-org/`, while
// `agentic-org/` already imports from here. So the constant lives here and
// `compose-gate.mjs` re-exports it for its existing callers.
//
// Two numbers, because they answer two questions. The edition ships at the
// compose deadline with whatever has passed review, as long as one piece has:
// a day that printed nothing for want of a fourth body (2026-11-04) is worse
// than a short paper, and a piece that passes later joins the same day's
// edition. A full paper is still four reviewed stories across the desks; that
// is what `ready` means, and what lets Spike hand the edition over early.
export const PASSED_ARTICLES_MINIMUM = 1;
export const FULL_EDITION_ARTICLES = 4;
export const DESK_DOCUMENTS_REQUIRED = 4;
// record_assignment's minimum: a full paper plus one spare, because a single
// spiked piece on a lineup level with a full paper leaves it short. The spare
// may be a short piece; it is never a reason to pad the others.
export const ASSIGNMENTS_MINIMUM = FULL_EDITION_ARTICLES + 1;
// The front carries two or three illustrations; a one-piece paper has only its
// lead's art to show, and the globe beside it is not counted.
export const FRONT_VISUALS_MAXIMUM = 3;
export const frontVisualsMinimum = (passed) => Math.min(2, passed);
