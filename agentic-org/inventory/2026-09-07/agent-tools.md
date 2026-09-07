# Agent tools and workflow alignment

The twelve live agents have their declared role tools. Their complete tasks
are not yet proven. Production remains parked. Read-only deployment checks
completed September 7, 19:26–19:31 UTC.

The local [workflow diagram](../../WORKFLOW.html) provides seventeen numbered
stages, Berlin start times, the research and revision loops, and unresolved
handoffs. It follows the executable declarations, while displaying the
conflicting daytime playbook separately. It does not change the schedule.

## Live availability

| Role | Newsroom operations | Rooms |
|---|---|---|
| Six reporters | file_article, record_dissent | conference, assignment, filing, research, sensor |
| Brass | record_assignment | all six |
| Spike | review_article | conference, assignment, filing, release, sensor |
| Klaxon | qualify_signal | conference, assignment, research, sensor |
| Ledger | file_desk | release |
| Caslon | file_desk, compose_edition | conference, assignment, filing, release |
| Pressman | stage_release | release |

Every declared executable and MCP server file exists; deployed server role
allowlists match the declarations. All twelve have Moltnet read/send and
personal memory configured. Historical rollouts demonstrate messaging and
newsroom-tool use; this audit did not exercise memory or wake cognition.
Rooms wake on mentions. Klaxon additionally accepts sensor DMs.

The six reporters and Brass have research-room access and are admitted by the
4090 responder. No new tool or room membership is needed for these requesters.
Other desks must ask through their existing shared rooms and receive findings
back there, rather than an inaccessible research-room pointer.

## Corrected on this branch

All twelve role briefs now prohibit independent web research while permitting
bounded local reads and declared offline work. Seven requester briefs explain
the request fields, stable retry identity, ending the turn, matching a sourced
answer and honest provenance. Other roles have explicit requester routes.

FLOOR and TEAM now recognize service JSON, inline research answers and the
per-role tool map. Obsolete guaranteed timings and pointer-only answers are
removed. Shared Caslon guidance uses the committed art catalogue. Spike checks
supplied evidence and sends actionable missing-source requests to the owner;
an unreadable external page alone does not justify HOLD.

The TEAM and Klaxon engine descriptions now agree with the declared Codex
engine. The separate declared-versus-live model discrepancy remains open.

These are source instruction corrections, not network enforcement or a
production deployment. The deployed bundled research guide is still the old
213-line specification claiming that the responder is not built. Before
deployment, require the rebuilt source bundle and its matching declarations.

## Reporter format validation

The local org declarations now give all six reporters a separate read-only
`validate_article` tool, implemented in private automation. It checks the same
public publication-format contract enforced by `file_article` before writes.
Reporters correct their own JSON; Caslon composes the accepted record.
The separate [validation report](article-validation.md) records the isolated
Daimon result, packaging and remaining deployment prerequisites. This addition
is not part of the live availability audit above.

## Remaining acceptance requirements

- **Enforcement:** the live Codex launcher uses danger-full-access. Recent
  reporter rollouts contain six native web-search calls across two sessions.
  A real execution-boundary restriction must fail an isolated bypass test;
  prompt text alone does not close this requirement.
- **Daimon research:** use a separate network and fresh state to prove an
  authenticated agent request, sensor answer, mentioned second turn, correct
  request matching and valid evidence use. The previous browser rehearsal
  used scripted requesters and does not establish agent competence.
- **Model identity:** all twelve live Codex homes name gpt-5.5; a real reporter
  turn confirms it. Source declarations name gpt-5.4-mini. The deployed Klaxon brief still
  names Grok; the local source correction above has not been deployed.
- **Clock and handoffs:** decide daytime versus evening, unify the assignment
  room contract, connect rolling notices to Klaxon and refresh corpus pins.
- **Edition correctness:** retain the earlier inventory's HOLD recovery,
  World Desk input and failed-turn accounting findings. The new local shared
  article-format gate addresses filing/site-schema drift; deployment and a
  complete autonomous edition remain unproven.
- **Release policy:** TEAM describes a human PR decision; the checked-in
  edition workflow automerges after its CI/content gates. Resolve that policy
  and validate the publication hop before enabling it.

The audit changed no production service, credential, schedule, message or
edition artifact. The local diagram is an alignment aid, not a readiness
certificate or a new operating policy.

## Local validation

The diagram passed the skill's static safety/accessibility checks and actual
Chrome rendering: fonts loaded, seventeen node text bounds fit, and mobile
horizontal scrolling remains within the figure. Independent AGY review found
no blocking or minor defects in the diagram and instruction packet.

Private instruction-contract checks cover all twelve roles, seven requesters,
the actual responder parser and seventeen mutations. The instruction-budget
suite passes with all twelve readers. After adding article validation, the
organization suite passes 212 tests with one dependency-dependent skip, and
all 55 operations tests pass. An isolated website build produced 971 pages
after content validation. The new reporter-format rehearsal passed through
real Daimon; its scope and earlier failed attempts are in the validation report.

The existing Docker e2e launcher was attempted but could not resolve its sibling
ecosystem checkouts from this nested worktree. It did not exercise cognition.
This does not replace the explicitly required isolated real-Daimon acceptance
case, and no synthetic test result is presented as a production-agent pass.
