# Operations

Paths, ownership, history and the security boundary. A repository-relative
path here (`ops/…`, `website/…`, `agentic-org/…`) resolves under the read-only
mount `./repos/newsroom/` from an agent workspace.

## Numbers and clocks

No score, probability, settlement or counter is authored in this repository or
by an agent. The formulas live in `clankandslop-private/agentic-org/SYSTEMS.md`,
outside the agent mount. Ledger records inputs, formula version and a
deterministic receipt, and rejects absent or incompatible units, dates and
accounting bases.

An edition is its Europe/Berlin calendar date, DST included. Local staging
targets 17:00 and the public release clock is 18:00; the daily schedule is in
`FLOOR.md`.

## Ownership

| Owner | Compiler resource access | Writable boundary |
| --- | --- | --- |
| Scheduled sensor services (4090) | private archive checkout: mutable | captures, research ledgers, indexes, prepared inputs and ad hoc responses; committed and pushed to the private repository |
| Klaxon (newsroom agent) | research snapshot: read-only; shared edition state: mutable | qualified signals only |
| reporters | shared edition state: mutable; public content: read-only | own dossiers and assigned article handoffs only |
| Brass, Spike | shared edition state: mutable; public content: read-only | assignment and verdict artifacts only; never reporter prose |
| Ledger | shared edition state: mutable; public content: read-only | decisions, receipts and ledger-owned generated records only |
| Caslon | shared edition state: mutable; public content: read-only; ETOPO1 relief grid: read-only | deterministic compose state, composition handoff, and the edition's `maps/` and `glyphs/` artifacts only |
| Morgue | shared edition state: mutable; public content: read-only | archive receipts only |
| Pressman | shared edition state and own staging: mutable; public source: read-only | sole owner of composition-digest-keyed local artifact and causal staged receipt; no published state, no push credential |

The compiler enforces resource presence, durability and whole-mount mode; this
table narrows mutable mounts to owner subpaths, and admission and content gates
reject violations. Spike and Caslon may reject or request revision, never write
reporter prose. Edition chrome is one file per owner under
`editions/<date>/desk/<owner>.<artifact>.json`.

The article record's keys are in `ARTICLE_FORMAT.md`, enforced by
`scripts/production-newsroom-mcp.mjs` and `scripts/production-newsroom.mjs` and
validated at build by `ops/validate-content.mjs`. A file is `<id>.json`, named
by its row in `state/edition/editions/<date>/INDEX`.

Caslon alone bakes illustrations. The ETOPO1 grid (`./etopo`, `CLANK_ETOPO_GZ`)
and the model and glyph library in the pinned bundle are read-only; the
decompressed grid at `CLANK_ETOPO_GRD` is a regenerable cache, never committed.
No agent fetches a relief dataset or 3D model; the catalogue in
`agents/caslon/PAGES.md` is the whole permitted surface. Runtime tools live in
the private repository; declarations and publication formats live here.

## Accepted history

The private acceptance service commits assignments, filings, dissent, verdicts,
desk documents and compositions to edition-local Git before returning their
receipts: the producing agent is the author, the service the committer. Exact
retries keep the commit; corrections create new revisions, monotonic per owner
and artifact. A terminal message carries `terminal_state`. This history has no
remote or publishing credential. Agents submit only through their declared
tools: they never run Git, push, read credentials or publish. Mneme continuity
may hold only approved summaries and durable decisions, never raw corpus.

## Security boundary

- Runtime admission is fail-closed. Each agent has an isolated HOME, XDG root
  and workspace, a host-provisioned CLI identity, permitted broker, network and
  Git capabilities, and a private root outside the repository. Spawnfile creates
  the declared workspaces and volumes, verifies secret references before launch,
  and writes Moltnet values only into private runtime state. `provision.mjs`
  creates only configured private day directories, never secrets, profiles or
  Git state.
- Codex credentials use Spawnfile's `auth.method: codex` import for the six
  release-desk roles. AGY is not a declared engine until a versioned broker
  contract exists.
- The public Git declaration is HTTPS with no repository authentication. Sensor
  corpus volumes go only to World Scout, Klaxon, Frontier and Closure. Every role
  gets the shared edition-state volume, narrowed by the ownership table.
- Pressman is the only mutable public-content principal, through its isolated
  `./staging` volume, with local filesystem I/O only: no Git resource, remote,
  publisher, push command or publishing credential. No agent declares one.
- The deploy key that pushes an edition branch lives on the host, outside every
  container, used only by `scripts/publish-edition-branch.mjs`. It pins GitHub's
  ed25519 host key, never reads or copies the key material, derives the branch
  from the edition date and pushes one fast-forward ref, refusing `main`,
  `master`, `staging`, `gh-pages`, forced refspecs and deletions. Branch
  protection on `main` is the real control; nothing here merges to `main`, and
  publication stays a human decision.
- Releases run only on the host: `clank-release.timer` runs `spawnfile release`
  as root (drained deploy, see `ops/AGENTS.md`). The newsroom control token
  reaches each new container through `bootstrap-control-token.sh` after the
  deploy, never through the public image.
- Broker results expose cited URLs, retrieval times, a capture digest, private
  locator and health only. Public output and Moltnet never carry raw captures,
  prompts, HTML, account or profile identifiers, secrets or tooling details.

## Why the Spawnfile is the way it is

- **Read-only data on `mode: mutable` volumes.** The research corpus and public
  content are read-only data, but `mode: readonly` bricks the org: the
  entrypoint's `chmod -R a-w` hits the root-owned identity sentinel as uid 2000,
  fails with EPERM under `set -e`, and the container dies.
- **These mounts are writable by agents.** They are shared by every member and
  durable, and uid 2000 owns the volume root, so permissions do not protect
  them. Integrity is maintained by the host: Spawnfile keeps its own record
  outside the volume, re-verifies the served tree on every poll, alarms on drift
  and re-lands from git. `.spawnfile-feed.json` inside the mount is a
  convenience for readers, never proof.
- **Frozen volume fields.** `mode`, `sharing` and `name` are hashed into a
  volume's identity; changing one on a populated volume refuses start or
  strands it behind a new empty volume. `mount` is safe to change. Team volumes
  stay declared in the team Spawnfile: on an agent, `sharing: team` mints one
  volume per member and fails compile on the duplicate host name.
- **Data lives in fed volumes, not the image.** The corpus and published
  editions change daily and the code does not; baking them into a bundle forced
  a daily rebuild and redeploy. Fed volumes refresh on host timers with no image
  build. The corpus freezes at 12:00 Berlin so assignment receipts always cite
  what reporters actually read.
- **Public content sits at `./repos/newsroom-content`.** The compiler refuses a
  volume mounted inside a bundle's mount, so readers resolve it through
  `CLANK_PUBLIC_CONTENT_VOLUME`.
- **Private code never enters the image.** The state adapter, art, visual and
  validation servers and release adapter arrive as the `newsroom-private-tools`
  fed volume, so a private merge reaches agents on the next refresh.
- **Reporter and Spike execution ceilings.** Sized to filings including
  revisions, not assignments: each filing costs several turns, and Spike reviews
  everyone's. Lower ceilings stopped editions on cost rather than editorial
  judgement. The organization-wide fuse still bounds total spend.
- **Caslon's turn is 30 minutes.** `lay_pages` plus `compose_edition` is the
  longest turn in the newsroom; fifteen minutes killed it one call short.
- **Caslon has no `CLANK_PRIVATE_SOURCE_ROOT`.** Compose takes corpus identity
  from the assignment records, not the live mount, which may have been swapped
  since commissioning; `validate-org.mjs` refuses a declared mount no tool depends on.
