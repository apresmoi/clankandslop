# Unattended operation

Host-side jobs. **Nothing here runs inside a container, nothing here is declared
by an agent, and nothing here may be reached from a compiled workspace** — the
same placement rule `scripts/publish-edition-branch.mjs` follows, for the same
reason: a restriction that executes inside the process a model drives is a
claim about that process, not a boundary around a credential.

The three human steps this replaces:

```
was:  research lands on edition/<date>   →  a person repins, rebuilds, redeploys
      pressman promotes an artifact      →  a person pushes the branch
                                         →  a person opens and merges the PR
      something breaks                   →  systemd says Failed into a void

now:  the release timer        (Hetzner)      hourly, `--if-changed`: no-op unless public main's HEAD moved
      clank-feed-corpus        (Hetzner)      `clank-newsroom-corpus` fed volume ← edition/<today>, frozen at 12:00
      clank-feed-content       (Hetzner)      `clank-newsroom-content` fed volume ← every published edition, from public main
      clank-feed-private-tools (Hetzner)      `clank-newsroom-private-tools` fed volume ← private newsroom tools + art deps
      clank-publish.timer      (Hetzner)      17:00 staged artifact → edition/<date>
      merge-edition.yml        (Actions)      PR + merge, only on its own green CI
      clank-alarm@.service     (both boxes)   ntfy → a phone
```

## The pieces

| File | Runs | Does |
|---|---|---|
| `scripts/seam-run.mjs` | Hetzner, on a timer with `--if-changed` | clean public main snapshot → `spawnfile build --release` (builds every bundle) → `up` → settle → record the release |
| `scripts/release-ledger.mjs` | inside the seam | `/home/clank/deploy-work/released.json`: which commit is actually running, so a timer can do nothing cheaply |
| `scripts/wake-window.mjs` | inside both | derives the safe window from the Spawnfiles, and reads the container to prove nothing is awake |
| `scripts/publish-edition-branch.mjs` | Hetzner, 17:00 Berlin | today's staged artifact → `edition/<date>` on GitHub |
| `clank-feed-content.timer` | Hetzner, every 5 min | `spawnfile volume refresh public-content-volume`: published editions + bylines at `origin/main` → `clank-newsroom-content` fed volume |
| `clank-feed-private-tools.timer` | Hetzner, every 2 min | `spawnfile volume refresh newsroom-private-tools`: the private newsroom tools at clankandslop-private `origin/main` → `clank-newsroom-private-tools` fed volume |
| `scripts/cycle-audit.mjs` | Hetzner, 18:15 Berlin | did today's cycle reach `composed`? |
| `scripts/alarm.mjs` | both boxes | one HTTPS POST that reaches a person |
| `ops/bin/clank-handler-reaper.sh` | Hetzner, every 5 min | kills leaked Daimon engine handlers older than any possible turn; its age floor is pinned above the longest Spawnfile turn timeout by `systemd-contract.test.mjs` |
| `../../.github/workflows/merge-edition.yml` | GitHub | opens and merges the edition PR, only on green CI |

## Why the seam refuses more often than it runs

A redeploy kills every in-flight wake. `wake-window.mjs` therefore answers
"is it safe" from two independent places and needs both:

- **the schedule**, parsed out of `agents/*/Spawnfile` — not out of
  `policies/schedule.json`, and never hardcoded, because the Spawnfile is the
  only file the compiler lowers into the container's cron. The crons have
  already moved once: the repin script's own header still says the reporters
  wake at 10:00; the tree now says 12:00.
- **the running container** — daimon's wake-acceptance receipts (any in
  `accepted` or `running`), the turn usage ledger (any incomplete turn, or any
  turn metered in the last 15 minutes), and the process table (anything outside
  the steady-state set). A container that cannot be read is not quiet: every
  unreadable signal is a finding, and findings block.

## The seam is a release job, not a daily one

The corpus used to be `newsroom-private.tar`, a checksum-pinned bundle whose
digest sat in all twelve agent Spawnfiles and was repinned here every morning —
so a new day's research meant a new ~5GB image, a daily build, and a daily
chance to lose the day to something that had nothing to do with journalism. It
happened twice in two days (2026-09-30 at the candidate health probe, 2026-10-01
at the deploy gate). `agentic-org/Spawnfile` now mounts the corpus as the
team-shared `clank-newsroom-corpus` fed volume, landed by `spawnfile volume
refresh` outside the agent boundary.

The published editions had the same defect one level down, and it is closed
the same way. They rode inside `newsroom-runtime.tar`, so every edition moved
its digest, the publisher repinned all twelve Spawnfiles, `main` moved in an
image input every evening, and the release timer rebuilt and redeployed the
org every night. Now `content/editions/` and `content/bylines/` are excluded
from the source bundle (`scripts/public-content.mjs` is the one list), served
by the team-shared `clank-newsroom-content` fed volume at
`./repos/newsroom-content` (readers resolve `current/content/editions`,
`current/content/bylines`), and landed by `clank-feed-content.timer`.

Private code took the same road, for a different reason: the image is public,
so nothing from clankandslop-private may be a layer. The state adapter, the
art, visual and validation servers and the release adapter are the
`clank-newsroom-private-tools` fed volume at `./tools/private`
(`current/newsroom/...`), landed by `clank-feed-private-tools.timer`. An edition commit touches nothing an image is
built from, and the release gate answers it with *"already released; nothing
to do"* — `releaseGate` diffs the released commit against the tip and treats a
diff made only of those paths as released (`publish-edition-branch.test.mjs`
proves it end to end). Everything else under `content/` (personas, topics,
log, fixtures), the site code and every runtime script stay in the image and
still ship through a release.

```
image (rebuilt only when code/prompts change)      volume (refreshed after every merge)
  ./repos/newsroom          code, prompts, ops/,      ./repos/newsroom-content
                            website/, content/          current -> trees/<revision>
                            {agents,topics,log}           content/editions/<date>/...
                                                          content/bylines/<agent>.tsv
```

So: **an org image is day-agnostic, and there is no `repin` stage.** What the
seam ships is code and prompts, and `--if-changed` makes that literal — it
compares `git rev-parse HEAD` against the release ledger and exits 0 having
touched nothing when they match. Under `--if-changed` a closed wake window is a
*deferral* (logged, exit 0, with the pending commit and its age written beside
the ledger, and one `release-deferred` alarm once it passes a day), because an
hourly job that paged on every busy hour would train you to ignore the pager.
Run by hand, a refused gate still alarms and still exits non-zero.

Two things the daily deploy was doing for free had to be given their own homes:

- **the wake budget.** The org is compiled once, deployed only when `main`
  changes (`clank-release.timer`, `--if-changed`), and **never restarted
  daily**. Daimon renews the wake fuse's budget in-process: with
  `DAIMON_WAKE_FUSE_EPOCH` unset it derives the epoch from the date in
  `DAIMON_WAKE_FUSE_EPOCH_ZONE` and rolls it at both the snapshot gate and
  admission. So `deploy.env` carries `DAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin`
  exactly once and **no** `DAIMON_WAKE_FUSE_EPOCH` line — a pinned epoch never
  rolls, and the newsroom would wedge after its first day. The seam's
  `wakeBudget` stage refuses to deploy against any other file and writes
  nothing. (This retired `epoch-roll-run.mjs` and its daily recreate.)
- **corpus provenance.** It travels with the data now, as Spawnfile's
  `.spawnfile-feed.json` beside the tree, checked by `scripts/corpus-contract.mjs`
  when Brass commissions; the publisher checks it against Spawnfile's host record.

## No bundle stage

There is nothing to order any more. `spawnfile build --release` builds every
image bundle from the Spawnfiles: the public source tree (git-tracked files of
the build root, published content excluded), the website dependencies
(`npm ci` in the runtime's own digest-pinned Node image) and the og assets. It
keys each by its inputs, refuses a build root whose bundle inputs do not match
`HEAD`, and records every digest in the compile report. Nothing is written back
into the tree, so the release gate refuses any tracked modification. The one
prebuilt archive is `etopo-relief.tar` (`scripts/build-etopo-bundle.mjs`, from
a ~395MB external download), which Spawnfile hashes at compile.

## The build root is load-bearing

Durable volume names are derived from the **path** of the Spawnfile that was
compiled: the edition-state volume is
`…-team-clank-and-slop-root-work-clankandslop-agentic-org-spawnfile-016c21d8-…`.
Building the same tree from a different directory mints different volume names
and silently detaches every agent's mneme memory. `--repo` defaults to
`/root/work/clankandslop` for that reason and for no other.

## Install (Hetzner, root) — complete from clean state

```bash
# 1. the local alarm recorder, independent of every checkout. It records locally
#    and sends nothing; the script is shipped from the private host automation
#    release because the public repository must not carry host-local runtime
#    scripts as publication content.
install -d -m 755 /usr/local/lib/clank-alarm
install -m 755 /root/work/clankandslop-private/sensors/automation/clank-alarm.sh /usr/local/lib/clank-alarm/clank-alarm.sh

# 2. the local alarm state directory
install -d -m 700 /var/lib/clank-alarm

# 3. prove the recorder before trusting it
CLANK_ALARM_SCOPE=--system CLANK_ALARM_STATE=/var/lib/clank-alarm \
  /usr/local/lib/clank-alarm/clank-alarm.sh clank-alarm-selftest.service
tail -5 /var/lib/clank-alarm/alarm.log

# 4. the units, loaded and DISABLED
install -m 644 /root/work/clankandslop/agentic-org/ops/systemd/*.service \
               /root/work/clankandslop/agentic-org/ops/systemd/*.timer \
               /etc/systemd/system/
systemctl disable --now clank-epoch-roll.timer clank-content-refresh.timer clank-corpus-refresh.timer 2>/dev/null || true   # retired
rm -f /etc/systemd/system/clank-epoch-roll.service /etc/systemd/system/clank-epoch-roll.timer \
      /etc/systemd/system/clank-content-refresh.service /etc/systemd/system/clank-content-refresh.timer \
      /etc/systemd/system/clank-corpus-refresh.service /etc/systemd/system/clank-corpus-refresh.timer
systemctl daemon-reload
systemctl disable clank-seam.timer clank-cycle-audit.timer clank-publish.timer clank-feed-content.timer clank-feed-private-tools.timer clank-feed-corpus.timer 2>/dev/null || true

# 5. the retired refreshers' work roots are not used any more (Spawnfile keeps
#    fed-volume state beside each volume, in spawnfile-feed/)
rm -rf /var/lib/clank-content /var/lib/clank-corpus

# 6. dry-run the seam without deploying
node /root/work/clankandslop/agentic-org/scripts/seam-run.mjs --check

# 7. prove the deploy key opens the public repository (read-only check; it
#    prints the repository the key is registered against and nothing secret)
ssh -o BatchMode=yes -i /root/.ssh/clank_public -T git@github.com
```

**Moving to the fed volumes (once).** The three volumes are Spawnfile fed
volumes; `spawnfile volume refresh` refuses a volume no container has
initialized, and the new readers refuse a volume with no `.spawnfile-feed.json`
or `current/` rather than read nothing. Do it inside a deploy window.

```bash
SF="/home/clank/deploy-work/node24/bin/node /home/clank/deploy-work/spawnfile-main/dist/cli/index.js"
ORG=/root/work/clankandslop/agentic-org
VOL=/var/lib/docker/volumes
# BEFORE the deploy: stop the retired refreshers, and land the corpus beside
# its old layout (the running container keeps reading CORPUS.json and the dated
# links; the new names do not collide). Exit 1 here only reports those old names.
systemctl disable --now clank-corpus-refresh.timer clank-content-refresh.timer
$SF volume refresh research-corpus $ORG || true
readlink $VOL/clank-newsroom-corpus/_data/current
# DEPLOY (the release creates clank-newsroom-private-tools), then at once:
C=$VOL/clank-newsroom-content/_data
rm -rf "$C/current" "$C/CONTENT.json" "$C/trees"            # the old content layout uses `current` too
P=$VOL/clank-newsroom-corpus/_data
rm -rf "$P/CORPUS.json" "$P"/20??-??-?? "$P"/trees/????????????????????????????????????????   # old 40-hex trees and dated links only
systemctl enable --now clank-feed-corpus.timer clank-feed-content.timer clank-feed-private-tools.timer
systemctl start clank-feed-private-tools.service clank-feed-content.service clank-feed-corpus.service
for id in newsroom-private-tools public-content-volume research-corpus; do $SF volume verify $id $ORG; done   # each exit 0
rm -rf /var/lib/clank-content /var/lib/clank-corpus
```

**To arm the seam and the audit, one command:**

```bash
systemctl enable --now clank-seam.timer clank-cycle-audit.timer
```

To disarm again: `systemctl disable --now clank-seam.timer clank-cycle-audit.timer`.

**To arm the publisher, one command — but read the paragraph under it first:**

```bash
systemctl enable --now clank-publish.timer
```

Arm it only after `stage_release` has produced a `staged-` receipt on its own,
in a real cycle. Until then `current-edition` does not exist, the job refuses
every night, and the alarm fires every night for a reason nobody can act on.
A dry run costs nothing and answers the question without arming anything:

```bash
node /root/work/clankandslop/agentic-org/scripts/publish-edition-branch.mjs \
  --staging /var/lib/docker/volumes/clank-release-staging/_data \
  --state   /var/lib/docker/volumes/clank-edition-state/_data \
  --key     /root/.ssh/clank_public \
  --edition today --dry-run
```

In the same change that arms the publisher, raise the audit's bar to `staged`:

```bash
install -d -m 755 /etc/systemd/system/clank-cycle-audit.service.d
install -m 644 /root/work/clankandslop/agentic-org/ops/systemd/clank-cycle-audit-require-staged.conf \
               /etc/systemd/system/clank-cycle-audit.service.d/require-staged.conf
systemctl daemon-reload
```

Not before: on a box where the publisher is disabled the cycle never reaches
`staged`, so installing that drop-in early guarantees an alarm at 18:15 every
single night.

Arming host timers does not remove the newsroom's stop marker. The source
declares midday agent schedules; create `fuse.stop` before replacing a parked
deployment and retain it through verification. Record the prior fuse state and
usage history before starting a new explicitly bounded run epoch.

The seam runs under the scoped Node 24 binary at
`/home/clank/deploy-work/node24/bin/node`, with that directory first in its PATH.
Install it from the immutable builder image recorded in the approved website
dependency provenance. The private dependency packager validates that provenance
before rebuilding the same archives; host Node 22 is insufficient for this job.
Do not regenerate provenance or advance dependency pins to make a daily refresh pass.

## Install (LeDeluge, user units)

The three research timers already exist and stay exactly as they are. The only
change is that their failures now reach a person:

```bash
install -d -m 700 ~/.config/clank-alarm ~/.local/lib/clank-alarm ~/.local/state/clank-alarm/spool
printf 'CLANK_ALARM_URL=https://ntfy.sh/<topic>\nCLANK_ALARM_HOST=ledeluge\nCLANK_ALARM_SPOOL=%s/.local/state/clank-alarm/spool\n' "$HOME" > ~/.config/clank-alarm/alarm.env
chmod 600 ~/.config/clank-alarm/alarm.env
cp <clankandslop>/agentic-org/scripts/alarm.mjs ~/.local/lib/clank-alarm/alarm.mjs
systemctl --user daemon-reload
# node is under nvm here, so the unit names it absolutely:
#   ~/.nvm/versions/node/v22.14.0/bin/node ~/.local/lib/clank-alarm/alarm.mjs --selftest
```

The drop-ins live in `~/.config/systemd/user/<unit>.d/alarm.conf` and add only
`OnFailure=`; no timer is enabled, disabled or rescheduled by them.

## Preparing publication for approval

`clank-publish.timer` fires `publish-edition-branch.mjs` at 17:00 Berlin. It is
the same job a person used to run by hand; three properties make it safe to run
without one, and none of them relaxes anything the manual job enforced.

- **`--edition today`.** `current-edition` is durable: it keeps naming last
  night's artifact until pressman promotes a new one. A person reads that as
  "publish what was staged". A timer must read it as "publish TODAY'S paper or
  nothing", or the first evening the org fails to compose it re-pushes
  yesterday's edition, silently, for as many nights as the org stays down.
- **`--state`, and therefore the receipt.** The staged receipt has to name the
  same artifact directory, that directory's name has to be the one
  `stage_release` derives from the composition digest it recorded, and the
  artifact's bytes have to hash to the `artifact_digest` in the receipt. The
  hash is recomputed here, on the host, from the bytes on disk — the rule is a
  second implementation of the producer's `directoryDigest`, on the other side
  of the airlock, because a digest a host recomputes is evidence and a digest it
  copies out of the receipt is a restatement. `--edition` refuses to run without
  `--state`.
- **An already-published edition is a quiet success.** After the merge the
  edition directory is on `main`; the next run finds nothing to push and says
  so, exit 0. A nightly alarm for "the paper you published is published" is how
  an alarm stops being read. A branch that exists at a *different* commit is
  still a refusal — that one really does need a person.

What the receipt binding could NOT do, and now does: `stage_release` records
`staging_root` as the container sees it (`…/agents/pressman/staging/<artifact>`)
and the host reads the same volume at
`/var/lib/docker/volumes/clank-release-staging/_data/<artifact>`. The two
strings never match, so the old path comparison refused every real artifact —
verified on the box on 2026-09-06 against the first artifact `stage_release` has
ever produced. Comparing the artifact's *name* and *contents* is mount-point
independent and catches the hand-edited volume the path comparison never could.

### What `main` has to carry for this to land

An edition branch is cut from `main` and pushed, and a `push`-triggered workflow
runs **the workflow file on the branch it was pushed to** — which is `main`'s.
So `merge-edition.yml` is live only once it is on `main`, and it invokes
`agentic-org/scripts/ci-gate.mjs`, which must be on `main` too. The org tree now
lives on public `main`, and the daily host job takes a clean fast-forward
snapshot from it before building the next runtime image.

When an edition branch lands with `merge-edition.yml`, `ci.yml` validates the
content and builds the site. The merge workflow checks the exact head SHA, dated
branch name and allowed paths (published content only), then opens or updates a
pull request. It rechecks the same head and CI immediately before merging. A
green push CI run is mandatory; a duplicate pull-request run can be ignored only
when it is from `github-actions[bot]` and GitHub did not execute any jobs for
it. After the guarded merge, the
workflow explicitly dispatches the website deployment for `main`.

## What is deliberately not automated

- **No browser step in CI, for anything.** Ten glyph shapes and 133 map regions
  are curated and committed, `ops/lay-page.mjs` refuses any name outside either,
  `compose_edition` enforces visual count, alternation and map set equality, and
  `verify-glyph-cameras.mjs` already rasterizes the cameras headlessly. The
  failure class a screenshot gate would catch is already unrepresentable.
- **No OG card rendering in CI.** The structural defect is fixed —
  `articleOgPath` returns a path only for a card that exists, so a story can no
  longer advertise an image that answers 404, and `website/src/lib/edition.test.ts`
  holds that. The *rendering* stays a laptop job (`npm run og`, commit the
  PNGs). 280 cards shipped that way; three editions went without and nothing
  broke. A `continue-on-error` Chromium step would cost ~90 s of every deploy,
  grow by ~6 cards a day because CI output is not committed, and buy a social
  preview image — measure a reason to want it before paying for it.

## What the publisher commits, and what it no longer does

`publish-edition-branch.mjs` commits the edition directory and regenerates
`content/bylines/*.tsv` (a view CI diff-checks that nothing else rebuilds) —
and nothing else. It used to repin `newsroom-runtime-bundle.json` and the
twelve Spawnfile source pins too, because `content/editions/**` was inside the
source archive; that repin is exactly what made every edition a release. The
editions are excluded from the source bundle now, so an edition branch changes
no image input, and the publisher refuses to commit any staged
path outside `content/editions/` and `content/bylines/` (read back from the
index, not trusted from its own pathspecs). `content/topics.txt` is no longer
regenerated: it is a view of `topics.json`, which an edition never changes.

`merge-edition.yml` admits exactly those two prefixes — the same list as
`PUBLIC_CONTENT_PATHS`, held equal by a test — and nothing under
`agentic-org/` on any leash.

## What the alarm fires on

| Reason | Raised by |
|---|---|
| `repin-failed` | the edition branch is missing, a desk index is absent, a digest survived the rewrite (corpus refresher only; the seam no longer repins) |
| `release-deferred` | a commit has been waiting more than a day for a quiet deploy window — the newsroom is up, it is simply not shipping code |
| `deploy-failed` | the image build failed, `deploy.env` pins the wake epoch or lacks the Berlin zone, `up` failed, or the container never settled |
| `no-edition` | the cycle audit found no edition, or one that stopped below `composed` |
| `seam-blocked` | the schedule was not clear or the container was not quiet |
| `unit-failed` | a systemd unit failed for a reason its own code never got to name — the `OnFailure=` handler |

Every one of them also lands as a JSON breadcrumb under the spool directory
before the send, so an undeliverable alarm still leaves the text on disk.
