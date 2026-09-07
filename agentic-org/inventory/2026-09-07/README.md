# Clank & Slop: inventory and path to the first autonomous edition

**Production is healthy and deliberately parked. The org has not completed a valid autonomous edition. Keep it parked while testing the real Daimon agents in isolation.**

Verified September 7, 2026, primarily 14:59–15:07 UTC (16:59–17:07 Berlin), with subsequent local code and validator checks. “Yesterday” means the September 6 edition; its night/rescue run continued into September 7. This investigation changed no deployed service, schedule, message, corpus or article.

Org findings and acceptance criteria live here, on public branch `feat/agentic-org`. Automation and execution scratch belong in `clankandslop-private`. The Noopolis repositories supply dependencies; they are not the workspace for this newspaper's automation. Existing `ORG_FLOW.html` was inspected, not rewritten.

```text
4090 research ─→ pinned corpus ─→ Hetzner newsroom ─→ local staged preview
```

## Verified inventory

| Surface | Actual location and state | Consequence |
|---|---|---|
| Public source | `apresmoi/clankandslop`, `feat/agentic-org` at `5a538921`; remote main `f81e0a69` | Org branch is the source under review; local primary checkout remains on staging |
| Private source | Nested `clankandslop/clankandslop-private`; remote main `54cb8d8`, September 6 branch `6f2524d` | Primary local main is 97 commits behind; it is not a current production inventory |
| Hetzner | `46.224.51.148`, hostname `clankandslop`, container `spawnfile-clank-and-slop` | Image `clank-and-slop:local8`; healthy since 01:32 UTC, restart count 0 across repeated samples |
| Runtime | Twelve Daimon agents, Codex engine; six reporters plus Brass, Spike, Ledger, Caslon, Pressman and Klaxon | All have readiness receipts; this does not prove editorial task success |
| Parking | Eleven January 1 cron placeholders, Klaxon schedule disabled; seam, audit and publish timers disabled/inactive | Intended operator hold is intact; parked crons do not prohibit manual or mentioned wakes |
| Fuse | Rescue epoch, 6M recorded-token limit, 40 admissions maximum; 24 admissions | No active stop/trip marker. Actual spend exceeds what its ledger sees; see below |
| Host resilience | Restart policy `no`; disk 83% used with 13GB free | Recovery/rebuild capacity needs attention before unattended operation |
| 4090 | LeDeluge `192.168.178.24`, reachable by LAN and SSH; RTX 4090 Laptop GPU; Ollama GET responds | Sensor workloads are browser subscription sessions managed by user systemd, not GPU inference containers |
| Sensors | Both browser services failed; all eight September 7 slots failed before capture | `DISPLAY=:99` has no running X server. No September 7 corpus or research branch exists |
| Sensor transport | SSH tunnel currently healthy and stable; 15 September 6 messages accepted by Moltnet | Posts target `room:research` without mentions; no recorded sensor-triggered completed Klaxon turn |
| Last research | September 6: eight intakes, 25 stories; later split has all six desk indexes populated | Research exists for a frozen September 6 rehearsal, not for today's paper |
| Release | Production release staging empty except resource marker | No autonomous staged edition or resulting publication proved |

Detailed sensor evidence and timing: [sensors.md](sensors.md).

## Deployment provenance: important corrections to ORG_FLOW

- The inspected host checkout `/root/work/clankandslop` is **`5a538921`**, with uncommitted changes to twelve Spawnfiles, the private pin and bundle manifest. Its three core newsroom scripts match all twelve deployed copies. The page's “43 commits behind” is not a verified description of the effective runtime.
- The committed org branch pins private **`5280db2`**, which has no prepared desk documents. The live host declaration instead pins **`6f2524d`**; all twelve runtime mounts contain all four prepared September 6 files, matching the deployed bundle. This is a reproducibility gap, not a live missing-input diagnosis.
- The live World Desk prepared input still says its registries are unavailable and offers stale carry-forward values, while another producer path holds a computed result with a trace. Ledger's brief selects the prepared path. Merely advancing a pin will not reconcile those competing outputs. Weather also has two observations at different times; that alone is not evidence of fabrication.
- September 5 has six PASS articles, four desk files, two pages and a composed receipt from a manual Caslon wake, explicitly carrying a forecast/dissent waiver. A separate scripted staging rehearsal also built successfully. Neither is a valid autonomous production edition; “compose/build never executed” is too broad.

## Why September 6 stopped

Durable edition evidence agrees with the live volume: **5 assignments, 10 filings, 10 verdicts, 3 PASS, 2 HOLD, 0 desk documents, no compose receipt**.

| Failure | Verified effect | Owning layer |
|---|---|---|
| Five commissions against five required bylines | Foreman's single-domain assignment was not deliverable from the permitted corpus; no replacement preserved the byline floor | Commissioning and research eligibility |
| HOLD cannot accept a new revision | Cogsworth's repair could not be filed after Spike held revision 2 | Newsroom revision state machine |
| Reviewer fetch failure became HOLD | Cogsworth had three domains; Spike held it because one Reuters URL did not load during review | Review instructions and retrieval evidence |
| Wrong edition in review calls | Four Spike turns targeted September 7 instead of the September 6 edition | Edition identity in wake/tool context |
| Permanent control error redelivered | The first fuse trip produced the recorded 71-minute 409 storm | Moltnet delivery plus Daimon stopping semantics |
| Accepted article shape differs from website contract | All three PASS articles have string `key_numbers` and lowercase byline IDs; the actual content validator rejects both | Filing schema and public article serialization |
| No September 6 downstream wakes | Ledger, Caslon and Pressman produced no desk/compose/stage artifacts that run | Scheduling/orchestration; currently intentionally parked |

Six assignments alone do not guarantee slack: compose requires **five distinct bylines**. A spare story from a reporter who already passed does not replace a missing fifth reporter. Also, `_all.index` exposes a numeric URL count, not independent-domain evidence; Brass cannot perform the proposed domain check from that column alone under its current two-read brief. Do not weaken sourcing by merely relabelling an unsupported factual claim as inference.

## Spend: the existing report undercounts by at least 2.14M

The recorded 57 turns total **10,473,710 tokens**. A further Spike wake, admitted at 01:23:14 and failed at 01:26:19 UTC, reports **2,138,123 tokens** against a 1,200,000 per-wake ceiling, with **no usage-ledger row**.

- Known total: **at least 12,611,833 tokens**, excluding any other unmetered stopped/failed work.
- Rescue: at least **6,108,883**, while its fuse sees only **3,970,760**.
- Delivery ID: `moltnet:daimon-762f6e41a19162624885d010a4b8955231ae8ad94dde5f5bf51f57a8f00d618d`.
- Local Daimon source already includes a fix for recording reported usage on failed wakes; the live omission requires checking the deployed runtime and the failing path, not assuming the source fix is absent. No new failed wake was triggered during this audit.

Increasing the total budget alone does not repair this undercount, cold-context expense or retry behavior. The next rehearsal must capture failed-wake usage independently of a successful-result receipt.

## What was tested locally

In an isolated source snapshot under the private repository, seven existing compose/tool-contract tests passed. Then the real website validator was run against the three unmodified accepted September 6 articles: it failed with **eight key-number errors and three byline-name errors**. Two additional errors reflect the absent chrome document in this deliberately incomplete edition snapshot. This was a validator reproduction, not a real-agent run or a full website build.

Evidence: [validation-summary.json](validation-summary.json), [targeted-tests.txt](targeted-tests.txt), [real-filings-validation.txt](real-filings-validation.txt).

## Test the real Daimon agents, then their handoffs

Reuse the compiled org and production runtime. The old single-agent rehearsal really calls Daimon, but hand-builds a reduced config and has three invalidating flaws: it can pass assertions after a failed wake with an empty usage ledger; shell and MCP state can point to different stores; a scratch directory on the bare host is not process isolation. The deterministic org E2E harness scripts cognition, so it cannot establish editorial competence.

Automation belongs in the private repo. The acceptance cases and sanitized results belong with the org on `feat/agentic-org`:

| Case | Input | Required evidence |
|---|---|---|
| Spike | September 6 Cogsworth revision 2, exact corpus fragments, explicit edition | A completed real Daimon wake and one durable, justified verdict; an inaccessible corroborating URL alone does not become a terminal article defect; missing factual support still blocks |
| Reporter | A real assignment plus revision request | Authenticated filing lineage, valid evidence references, canonical byline and key-number shape accepted by the real public validator |
| Brass | Frozen pitches and corpus eligibility information | A viable lineup preserving five distinct bylines, with explicit handling of a single-domain candidate |
| Ledger | Passed-story state and authoritative prepared inputs | Two valid desk documents backed by provenance; no invented computed values |
| Caslon | Five valid PASS articles and desk inputs | Remaining two desks, valid front/tape compositions and a genuine composed receipt |
| Pressman | Authentic completed composition | Content validation, actual Astro build, nonempty staged preview and matching staged receipt |
| Klaxon | One real sensor envelope in an isolated Moltnet network | One accepted delivery reaches the intended wake policy and produces a qualifying artifact or explicit justified rejection |
| Handoffs/recovery | Reporter→Spike→reporter, then full frozen edition; isolated fuse-trip and retry cases | Seed only the first wake; real isolated Moltnet must trigger the next agent against the same copied edition store. Require correct edition propagation, bounded retries, failed-wake accounting and complete local staging |

Each live case needs a disposable container, pinned image/config/corpus identities, fresh edition/memory/fuse state, and one shared scratch state mount for shell and MCP. Keep the actual model, agent instructions and tool permissions; use a separate local Moltnet network where required. The test receives no production Moltnet credentials, production state volumes or publication capability. Preserve the intentional production parking. Only necessary model authentication enters the test through the established runtime auth mechanism.

Before each case, define its expected artifact, wall-clock and token limits, maximum fix/review rounds and impasse condition. A failed wake, missing artifact, missing expected usage record or timeout is a failed case even when a child exits zero. A single-agent pass covers that task only; real transport handoffs and a full container rehearsal are separate gates.

The current HOLD refusal is a baseline case to reproduce. Decide the intended HOLD recovery behavior before changing that contract; the existing legal revision loop must also pass through `REVISION_REQUEST`. A diagnostic extraction of tokens from an error message is not a metering pass: reported usage must reconcile to the canonical ledger on success or failure. Every persisted artifact must pass its owning validator, and complete staging must pass the public validator and actual website build.

Codex reports turn usage at completion, so a token ceiling checked then can reject an overspent result but cannot guarantee a precise spending cap during that turn. A separately enforced wall-clock deadline is needed to terminate a runaway rehearsal; preserve any reported usage on that failure path.

## Recommended repair order

1. **P1: make the isolated Daimon runner trustworthy** and reproduce the September 6 failures with immutable inputs and explicit output/usage assertions.
2. **P1: fix filing contracts and edition identity; agree and implement HOLD recovery**, with regression cases that fail on the original defects. Proposed editorial brief changes require operator sign-off before application.
3. **P1: restore research capture and reconcile producer/consumer inputs**, then verify real capture, corpus, bundle and sensor-wake evidence in isolation.
4. **P1: test and repair failed-wake accounting and permanent-error handling** at their owning runtime/transport layers before trusting any new budget.
5. **P1: verify each downstream real-agent task**, followed by one complete isolated edition ending in a local staged preview, without gate waivers.
6. Record reproducible deployment configuration and only then consider unparked production. Publication is outside this audit's authorized actions.

No new real-agent rehearsal has run in this investigation. The inventory and failure reproductions establish the test packet; production remains parked.

An independent Grok review of a supplied evidence summary was completed; it did not independently inspect the hosts. Its useful clarifications are incorporated above: explicit HOLD baseline versus intended recovery, canonical metering instead of error-text substitution, and actual message-triggered handoffs instead of sequential manual wakes. Public validation and separation from production transport were already required. This review evaluates the test design, not the org's readiness to run.

## Evidence identities

- Public source and remote checks: `5a538921c0bfe91b924521834e33f0ed4db94291`; preserved edition evidence branch `0e04bc32940c41782aad53dddbc46affb60feb80`, under `runs/2026-09-06/`.
- Live container image ID: `sha256:2bdd4202bacbd1c6752cd03beffd3cfad8d02028c0873bbc28aa8d734a6b6967`.
- Live private bundle digest: `sha256:ae5eb79bb3635fcf8a6280cfef3739c2d4a309cfc45ec7d66ecf1b74e12206fe`, declared private commit `6f2524dcf5276ab5bdfeebdcea10e3954f863643`.
- All twelve deployed production-newsroom scripts: `ab2ada22f7e397a133546876c9eb1d844415da0114911ea11ba89fe349abdad7`; MCP scripts: `73bc7a309ce2137f57693029898f89276a6fb368c6ef084f0ff75c50deffa694`; edition indexes: `9a075539f300a50f2ced9292869b288360745a97cea929031e923d9ddc4e9441`.
- Host observations: Docker health/config/mount metadata, terminal acceptance receipts, usage ledger, edition volume and Moltnet SQLite; sensor observations: service journals/timers, display processes/socket, persisted corpus files and remote refs. No credentials were copied into this inventory.
