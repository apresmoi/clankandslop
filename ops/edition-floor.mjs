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
export const PASSED_ARTICLES_MINIMUM = 4;
export const DESK_DOCUMENTS_REQUIRED = 4;
// record_assignment's minimum: the floor plus one spare, because a single
// spiked piece on a lineup level with the floor ends the day. The spare may be
// a short piece; it is never a reason to pad the others.
export const ASSIGNMENTS_MINIMUM = PASSED_ARTICLES_MINIMUM + 1;
