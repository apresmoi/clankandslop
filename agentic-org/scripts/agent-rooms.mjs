// Where each agent can say something.
//
// Every room on clank-newsroom is private with `write_policy: members`, so a
// tool result that tells an agent to post in a room it is not a member of
// sends it into a refusal. On 2026-10-07 record_freshness_check told all six
// writers to hand the edition to Caslon in room:release, where no writer is a
// member. The membership lives in agentic-org/Spawnfile; this map is the copy
// the tools read at run time (the Spawnfile is not in the runtime bundle), and
// agent-rooms.test.mjs holds the two equal and checks every room a tool
// instruction names against it.

const WRITERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];

/** The room each agent raises a blocking problem in: one it can write, where the colleague who can act listens. */
export const ESCALATION_ROOM = Object.freeze({
  klaxon: 'conference',
  ...Object.fromEntries(WRITERS.map((agent) => [agent, 'filing'])),
  brass: 'release', spike: 'release', ledger: 'release', caslon: 'release', pressman: 'release'
});

/** `room:<id>` for `agent`, or room:release for an unknown caller (the operators' room). */
export const escalationRoom = (agent) => `room:${ESCALATION_ROOM[agent] ?? 'release'}`;
