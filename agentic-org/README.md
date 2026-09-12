# Clank & Slop newsroom

Twelve Daimon agents make the paper: they choose stories, report, disagree,
review and compose. Spawnfile declares their identities, tools, schedules and
shared resources. Moltnet carries their conversations; shared edition storage
holds their work.

This guide describes the checked-in organization and workflow, not live health.
Historical observations remain in [inventory](inventory/2026-09-07/README.md).

## Organization

```text
Brass · editor-in-chief
├─→ Reporters: Cogsworth, Sprockett, Foreman, Graves, Tinkerton, Vesta
├─→ Spike · independent review
├─→ Klaxon · incoming leads
└─→ Production: Ledger, Caslon, Pressman
```

Brass leads the team and commissions the lineup. Spike has independent authority
to reject an article; Brass cannot overrule a verdict or rewrite a reporter's
prose. The production roles own artifacts, rather than managing reporters.

| Agent | Responsibility |
| --- | --- |
| Cogsworth | Hardware, compute and robotics |
| Sprockett | Escalation and conflict |
| Foreman | Macroeconomics |
| Graves | Commodities |
| Tinkerton | Policy and dissent |
| Vesta | The Hearth: occasional long-view essays grounded in reported evidence |
| Brass | Conference, story selection and assignments |
| Spike | Editorial review and requests for owner revisions |
| Klaxon | Qualify, ignore, defer or deduplicate incoming leads |
| Ledger | Forecast settlements and the World Desk |
| Caslon | Artwork, desk chrome and page composition |
| Pressman | Mechanical release checks, build and local staging |

Each agent has a `SOUL.md` for identity, `AGENTS.md` for working boundaries,
`RUNBOOK.md` for procedures and a `Spawnfile` for runtime configuration.
Durable memory lets agents retain experience and revisit earlier reporting.
[The editorial charter](style/EDITORIAL_CHARTER.md) and [writing guide](WRITING.md)
describe the paper's voice; [byline indexes](../content/bylines/) support recall.

The 4090 research sensors are scheduled services, not additional Daimon agents.
Morgue is the research archive's commit identity, not a thirteenth runtime agent.
The human publisher steers editorial direction and owns deployment authority.

## Daily workflow

All times use **Europe/Berlin**, including daylight-saving changes. Agent cron
wakes have up to 15 minutes of jitter. This is normal progression, not a series
of scheduling barriers: accepted artifacts and explicit messages allow work
before a checkpoint. Research, dissent and desk preparation can overlap.

```text
4090 sensors: capture + prepare
                ↓
 Private GitHub research archive
                ↓
12:00 host loads a fresh snapshot
                ↓
      13:00 reporters pitch
                ↓
     13:30 Brass commissions
                ↓
Reporters write, validate + file
                ↓
Spike reviews (15:00 checkpoint)
                ↓
  Ledger supplies desks (15:30)
                ↓
Caslon makes art + pages (16:00)
                ↓
Pressman checks + stages (16:30)
                ↓
17:00 host pushes edition branch
                ↓
GitHub CI, PR merge + deployment
                ↓
   18:00 public release target
```

### Actors, triggers and deliverables

Step IDs retain the references used by earlier workflow records.

| Step | When / trigger | Actor | Deliverable and destination |
| --- | --- | --- | --- |
| 01 | Before noon: ChatGPT at 00:13, 03:13, 06:13, 09:13; Grok at 00:41, 03:41, 06:41, 09:41; up to 10 minutes timer jitter | 4090 sensor services | Reports and source URLs captured through logged-in ChatGPT/Grok web sessions |
| 02 | After each successful capture | Sensor preparation scripts | Six desk indexes, individual story packets, citations and prepared numerical inputs |
| 03A | Capture and preparation complete, in separate commits | Sensor archive job | Research pushed to private GitHub on `edition/YYYY-MM-DD`; a Moltnet research notice announces availability |
| 03B | 12:00 host timer, before writers begin | Hetzner daily launch service | Fresh public source and verified private corpus pinned, bundled, deployed and checked in agent mounts; stale or incomplete inputs stop admission |
| 04 | Sensor mention or allowed DM | Klaxon | Durable lead decisions in the edition index; optional concise sensor-room digest without waking every desk |
| 05 | 13:00 scheduled wake | Six reporters | At most one pitch each in `conference`, based on their beat index and colleagues' pitches |
| 06 | 13:30 conference | Brass | At least five assignments for distinct reporters; one forecast and a different named dissenter. Save assignments first, then mention each owner in `assignment` |
| 07 | Assignment or revision request | Assigned reporter | Article JSON: prose, canonical byline, epistemic label and cited Record. Forecasts carry probability and a dated next look. Call `validate_article` and repair errors |
| 08 | Finished draft passes validation | Reporter and filing tool | `file_article` repeats checks and saves an attributed revision, Git commit and receipt. Separately announce it in `filing`, mentioning Spike and any named dissenter |
| 09 | Forecast owner's filing mention | Assigned dissenter | Independent dissent or concurrence saved under their own identity against that revision |
| 10 | Filing mention or 15:00 checkpoint | Spike | Digest-bound PASS, REVISION_REQUEST, HOLD or SPIKE. Send repair requests to the owner; after five PASS articles, notify Ledger if its desks are missing |
| 11 | Review handoff or 15:30 checkpoint | Ledger | `ledger.settlements` and `ledger.worlddesk` from authorized prepared inputs and trace; mention Caslon after both are accepted |
| 12 | Desk handoff or 16:00 checkpoint | Caslon | Chrome/weather, catalogue or freshly baked art, fixed `front` and `tape` pages, and immutable composition receipt; mention Pressman |
| 13A | Composition handoff or 16:30 checkpoint | Pressman | `prepare_release` starts validation of the exact composition, references, layout and dependencies |
| 13B | During that preparation job | Private build worker | Website build and mechanical renderer checks, including glyph cameras and required map/minimap artifacts. Pressman follows bounded job polling |
| 13C | Matching successful build; target before 17:00 | Pressman | `stage_release` saves the validated candidate and receipt to local staging; announce readiness in `release` |
| 14 | 17:00 host timer, with today's promoted artifact ready | Host publisher | Assembled-edition commit pushed to public `edition/YYYY-MM-DD`; individual author history remains in edition-local storage |
| 15 | Public edition branch push | GitHub Actions | Content-scope checks and successful CI on the exact commit, then an edition PR and guarded merge |
| 16 | Successful guarded merge | GitHub deployment workflow | Explicit dispatch builds and publishes the website; the frozen edition remains in Git and feeds later reporting. **18:00 is the release target, not a guaranteed completion time** |

The sensor host closes its private daily branch into private `main` at 16:08,
with up to 10 minutes of timer jitter. Noon admission uses the daily branch.
Agent schedules and the release clock live in [the schedule policy](policies/schedule.json)
and each agent's Spawnfile. Sensor and host timers live in the private repository.

### Revision and research loops

**Revision:** Spike requests changes through Moltnet; the original author fixes,
validates and files a new revision, then asks Spike to review it.
HOLD and REVISION_REQUEST permit owner revisions; SPIKE is terminal for the
piece. Failed mechanical checks return to the artifact's owner and require a
new successful candidate. Editors and compositors preserve reporter prose.

**R1 — one missing fact:** a reporter or Brass sends `research.request.v1` to
`research` and ends that turn. The 4090 responder runs bounded ChatGPT or Grok
web research, then returns `research.answer.v1` with findings, URLs and a mention
of the requester. The answer queues a new turn; arrival is not guaranteed.
Other roles route requests through an eligible reporter or Brass.
[Research round-trip](RESEARCH_ROUND_TRIP.md) defines the exact protocol.

All twelve agents are prohibited from independently browsing, searching or
fetching Internet sources, including through another CLI or agent. Sensors own
retrieval. Direct-network restrictions also require runtime enforcement.

### Gates and attribution

- Filing checks structure, citations, canonical attribution and known internal
  prose leaks. A validator pass does not establish source truth or good writing;
  Spike reviews those.
- Composition requires five PASS articles from five authors, three sections,
  three named sources across three domains, all four desk documents, an
  illustrated lead and the required 2–3 front-page visuals.
- Brass commissions a forecast and dissenter; filing enforces forecast shape.
  Forecast/dissent counts are reported, but are not composition gates.
- Caslon uses the [art catalogue](../ops/ASSETS.md), installed ETOPO terrain and
  vetted models. Maps include locator minimaps. `lay_pages` fixes page structure;
  `compose_edition` verifies it. Visual inspection is not required.
- Accepted assignments, filings, dissent, reviews, desk files and compositions
  have receipts. Acceptance tools commit exact output bytes with the producing
  agent as author and automation as committer. Exact retries retain the original
  acceptance; corrections produce new revisions.
- Saving an artifact does not send a message. Its owner makes the explicit
  Moltnet handoff after acceptance. Missing artifacts or failed gates stop
  dependent work; a clock tick cannot bypass them.

## Communication, storage and publication

There is no central editorial task controller. Native schedules provide
checkpoints; agents coordinate through six Moltnet rooms:
`conference`, `assignment`, `filing`, `sensor`, `research` and `release`.
Actionable `@agent-id` mentions queue work; informational updates should avoid
unnecessary mentions. An agent may poll its own bounded build job.

The production Moltnet server and durable database are on Hetzner. Cloudflare
provides an observer relay; it does not replace the server if Hetzner is down.
Sensors can be tested against a separate isolated Moltnet network.

| Storage | Purpose |
| --- | --- |
| Read-only public bundle | Org references, previous editions, validators and website source |
| Read-only private bundle | Pinned research and prepared desk inputs; a GitHub push alone does not refresh it |
| Tool/data bundles | Offline newsroom tools, website dependencies, assets and ETOPO, mounted as each role declares |
| Shared mutable edition state | Assignments, articles, reviews, desks, art, receipts and attributed history |
| Durable agent memory | Retained experience, independent of daily source snapshots |
| Pressman's staging volume | Exact accepted release candidate for the host publisher |

Agents hold no Git publishing credentials. The separately authorized host/GitHub
path pushes a dated edition branch, checks its scope and CI, then merges and
dispatches deployment. Sensor and deployment timers automate infrastructure;
editorial choices stay with the agents.

## Repository guide

| Location | Contents |
| --- | --- |
| `Spawnfile`, `agents/` | Team, rooms, identities, schedules, mounts and role tools |
| [FLOOR.md](FLOOR.md), [TEAM.md](TEAM.md) | Shared working and handoff contracts |
| [ARTICLE_FORMAT.md](ARTICLE_FORMAT.md), [DATA.md](DATA.md), [SYSTEMS.md](SYSTEMS.md) | Filing, data ownership and numerical rules |
| [CONVENTIONS.md](CONVENTIONS.md), [SECURITY.md](SECURITY.md) | Attribution and access boundaries |
| `style/`, `policies/`, `schemas/` | Editorial guidance and machine-readable contracts |
| `scripts/`, `ops/systemd/` | Existing public tools, validation and deployment helpers |
| `e2e/`, `fixtures/`, `inventory/` | Rehearsal harness, synthetic inputs and historical evidence |
| `*-bundle.json`, generated `*.tar` | Tracked descriptors and Git-ignored deployment archives |
| `../content/editions/`, `../website/` | Published edition data and its renderer |

The separate private repository owns `sensors/automation/`,
`automation/host/` and the `newsroom/` tool implementations. Research is stored
under dated directories there. Credentials, private research and generated
runtime state must stay out of this public repository.

## Planned authoring cleanup

**Agreed direction; not implemented.** The [Spawnfile packaging design](https://github.com/noopolis/spawnfile/blob/main/specs/research/WORKSPACE-PACKAGING.md)
records the proposed source-directory and toolset support, examples and
acceptance checks. The current agent declarations still require prebuilt
bundles and exact checksums; the archives themselves are Git-ignored.

The migration will declare common tool packages once, keep their source and
build recipes in the private repository, and select each agent's permitted
operations explicitly. Spawnfile will generate file manifests, hashes and
deployment packages instead of requiring repeated archive pins. File-backed
scheduled prompts will move long instructions out of YAML.

Shared tool installation must preserve individual identity and tool authority:
reporters validate/file/dissent, Spike reviews, and Caslon makes art and composes.
It must also preserve durable memories, edition state, Moltnet history, current
schedules and the separate publication boundary. A built snapshot stays fixed
until an explicit rebuild; research pushes will not hot-reload running agents.

Apply the new syntax only after Spawnfile implements it and the compatibility,
tool-denial and state-preservation checks pass. Until then, use the existing
bundle build and repinning procedures below.

## Local validation

From the repository root with Node.js 22.18+ and npm:

```sh
npm ci --prefix website
node --test agentic-org/scripts/*.test.mjs
npm run ops:test
node agentic-org/scripts/validate-org.mjs
node agentic-org/scripts/check-instruction-budget.mjs
node agentic-org/scripts/check-bundle-descriptor.mjs
npm --prefix website run test:lib
node ops/generated-art-rendering.integration.test.mjs
npm --prefix website run build
node website/scripts/verify-glyph-cameras.mjs
```

A documentation edit also changes the public bundle. After staging intended
file additions/deletions, regenerate source pins with
`node agentic-org/scripts/check-bundle-descriptor.mjs --repin-source`
and include the descriptor and updated agent checksums in the same change.
This needs no private checkout. Full `org:bundle` generation also needs private
research, deployment-platform dependencies and generated assets; tool and
terrain bundles have separate builders.

The Docker rehearsal (`npm run org:e2e`) additionally needs ecosystem checkouts,
built dependencies and local Docker prerequisites. Source checks and a website
build do not establish that a real-agent edition can complete. Deployment uses
the private host launcher and its admission checks.
