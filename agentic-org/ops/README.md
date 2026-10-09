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

now:  clank-release.timer      (Hetzner)      hourly `spawnfile release`: no-op unless the image identity changed; drains turns, never kills one
      clank-feed-corpus        (Hetzner)      `clank-newsroom-corpus` fed volume ← edition/<today>, frozen at 12:00
      clank-feed-content       (Hetzner)      `clank-newsroom-content` fed volume ← every published edition, from public main
      clank-feed-private-tools (Hetzner)      `clank-newsroom-private-tools` fed volume ← private newsroom tools + art deps
      clank-publish.timer      (Hetzner)      17:00 staged artifact → edition/<date>
      merge-edition.yml        (Actions)      PR + merge, only on its own green CI
      clank-alarm@.service     (both boxes)   records the failure locally
```

## The pieces

| File | Runs | Does |
|---|---|---|
| `systemd/clank-release.service` | Hetzner, hourly | fast-forward to `origin/main` + disk floor → `spawnfile release` (identity no-op, build, drain, deploy, settle, resume, control-token bootstrap, ledger, prune) |
| `scripts/release-notify.mjs` | inside the release | Spawnfile's `--notify-command`: a failed or day-old deferred release → `alarm.mjs` spool |
| `scripts/publish-edition-branch.mjs` | Hetzner, 17:00 Berlin | today's staged artifact → `edition/<date>` on GitHub |
| `clank-feed-content.timer` | Hetzner, every 5 min | `spawnfile volume refresh public-content-volume`: published editions + bylines at `origin/main` → `clank-newsroom-content` fed volume |
| `clank-feed-private-tools.timer` | Hetzner, every 2 min | `spawnfile volume refresh newsroom-private-tools`: the private newsroom tools at clankandslop-private `origin/main` → `clank-newsroom-private-tools` fed volume |
| `scripts/cycle-audit.mjs` | Hetzner, 18:15 Berlin | did today's cycle reach `composed`? |
| `scripts/alarm.mjs` | both boxes | records the alarm in the spool, then POSTs it when a channel is configured |
| `../../.github/workflows/merge-edition.yml` | GitHub | opens and merges the edition PR, only on green CI |

## The release drains; it does not wait for a quiet hour

`spawnfile release` (Spawnfile `specs/RELEASE.md`) replaced `seam-run.mjs`, its
release ledger, the schedule-derived deploy window and the container
quiescence probe. A redeploy used to kill in-flight wakes, so the old job
refused unless the hour was clear and the container quiet. Now Daimon's
control API pauses admission (new wakes answer `work-blocked`, Moltnet retries
them, queued wakes stay queued), running turns finish within `--drain-timeout
30m`, and only then is the container replaced. A drain that does not finish
resumes admission and exits 75: a deferral, retried next hour, reported once
by the notifier after a day.

What stayed in the org, and why:

- **the source** (`ExecStartPre`): fast-forward the checkout to exactly
  `origin/main` on branch `main`, refusing local commits ahead of it; Spawnfile
  builds from the checkout and fetching it is the caller's job.
- **the 20 GiB disk floor** (`ExecStartPre`): Spawnfile prunes release tags but
  not build cache; a full disk fails the unit loudly instead of mid-build.
- **the control-token bootstrap** (`--post-deploy-command`): the newsroom
  control token is not in the image; `bootstrap-control-token.sh` from the
  private checkout installs it into the new container and proves an
  authenticated activity read. A failure leaves the release unrecorded and the
  next run redeploys and reruns it.
- **the notifier target**: the alarm spool, via `scripts/release-notify.mjs`.
- **`release-time.mjs` stays, untouched.** It is the edition release clock
  (18:00 publication) used by the newsroom tools and the publisher, not a
  deploy gate, so nothing in `spawnfile release` replaces it.

Dropped with the seam, with no replacement:

- the `wakeBudget` check of `deploy.env` (no `DAIMON_WAKE_FUSE_EPOCH`, exactly
  one `DAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin`): host configuration, already
  correct; recheck it by hand whenever `deploy.env` changes.
- the compiled engine-policy admission (`runtimePolicy`): `spawnfile release`
  has no pre-deploy hook; `engine-policy.mjs`'s compiled-side checks run only in
  their tests until one exists.
- the handler reaper: Daimon D1 (daimon-harness#42) fixed the leak at its
  source and runs in production.

## A release ships code and prompts, never data

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
built from (`publish-edition-branch.test.mjs` holds that), so its Docker
build context, and therefore Spawnfile's release identity, is unchanged and
`spawnfile release` exits 0 with *"… is already running as …; nothing to do"*. Everything else under `content/` (personas, topics,
log, fixtures), the site code and every runtime script stay in the image and
still ship through a release.

```
image (rebuilt only when code/prompts change)      volume (refreshed after every merge)
  ./repos/newsroom          code, prompts, ops/,      ./repos/newsroom-content
                            website/, content/          current -> trees/<revision>
                            {agents,topics,log}           content/editions/<date>/...
                                                          content/bylines/<agent>.tsv
```

So: **an org image is day-agnostic, and there is no `repin` stage.** What a
release ships is code and prompts; an unchanged image identity is a no-op that
touches nothing.

Two things the daily deploy was doing for free had to be given their own homes:

- **the wake budget.** The org is compiled once, deployed only when its image
  changes (`clank-release.timer`), and **never restarted
  daily**. Daimon renews the wake fuse's budget in-process: with
  `DAIMON_WAKE_FUSE_EPOCH` unset it derives the epoch from the date in
  `DAIMON_WAKE_FUSE_EPOCH_ZONE` and rolls it at both the snapshot gate and
  admission. So `deploy.env` carries `DAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin`
  exactly once and **no** `DAIMON_WAKE_FUSE_EPOCH` line — a pinned epoch never
  rolls, and the newsroom would wedge after its first day. Nothing checks this
  automatically any more (see above). (This retired `epoch-roll-run.mjs` and
  its daily recreate.)
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
into the tree, and `--release` refuses bundle inputs that differ from `HEAD`. The one
prebuilt archive is `etopo-relief.tar` (`scripts/build-etopo-bundle.mjs`, from
a ~395MB external download), which Spawnfile hashes at compile.

## The build root is load-bearing

Durable volume names are derived from the **path** of the Spawnfile that was
compiled: the edition-state volume is
`…-team-clank-and-slop-root-work-clankandslop-agentic-org-spawnfile-016c21d8-…`.
Building the same tree from a different directory mints different volume names
and silently detaches every agent's mneme memory. `clank-release.service`
builds `/root/work/clankandslop/agentic-org` for that reason and for no other.

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
systemctl disable --now clank-seam.timer clank-handler-reaper.timer 2>/dev/null || true   # retired
rm -f /etc/systemd/system/clank-seam.service /etc/systemd/system/clank-seam.timer \
      /etc/systemd/system/clank-handler-reaper.service /etc/systemd/system/clank-handler-reaper.timer
systemctl daemon-reload
systemctl disable clank-release.timer clank-cycle-audit.timer clank-publish.timer clank-feed-content.timer clank-feed-private-tools.timer clank-feed-corpus.timer 2>/dev/null || true

# 5. the retired refreshers' work roots are not used any more (Spawnfile keeps
#    fed-volume state beside each volume, in spawnfile-feed/)
rm -rf /var/lib/clank-content /var/lib/clank-corpus

# 6. prove the deploy key opens the public repository (read-only check; it
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

**To arm the release and the audit, one command** (first time: do the cutover
below instead):

```bash
systemctl enable --now clank-release.timer clank-cycle-audit.timer
```

To disarm again: `systemctl disable --now clank-release.timer clank-cycle-audit.timer`.

**Cutover from the seam to `spawnfile release` (once, Hetzner, root) — complete from clean state.**
Production already runs Daimon 8349559 (D4 drain/resume), so the first
release drains like every later one: no `--no-drain` deploy is needed. The
first run has no ledger, so it releases (build, drain, redeploy) even though
the code is unchanged.

```bash
# 1. stop the old jobs FIRST, and wait for a running seam to end on its own
#    (a oneshot mid-run is "activating"; never stop a deploy mid-way)
systemctl disable --now clank-release.timer clank-seam.timer clank-handler-reaper.timer 2>/dev/null || true
while systemctl show -p ActiveState --value clank-release.service clank-seam.service | grep -qE '^(activating|active|deactivating|reloading)$'; do sleep 15; done
rm -f /etc/systemd/system/clank-seam.service /etc/systemd/system/clank-seam.timer \
      /etc/systemd/system/clank-handler-reaper.service /etc/systemd/system/clank-handler-reaper.timer
systemctl daemon-reload

# 2. Spawnfile with --runtime-env-file and --post-deploy-command (noopolis/spawnfile#59, #60),
#    the org checkout on exactly origin/main, the drain token, the bootstrap, disk
git -C /home/clank/deploy-work/spawnfile-main fetch -q origin
git -C /home/clank/deploy-work/spawnfile-main checkout -q --detach origin/main
(cd /home/clank/deploy-work/spawnfile-main && PATH=/home/clank/deploy-work/node24/bin:$PATH npm ci --no-audit --no-fund && PATH=/home/clank/deploy-work/node24/bin:$PATH npm run build)
/home/clank/deploy-work/node24/bin/node /home/clank/deploy-work/spawnfile-main/dist/cli/index.js release --help | grep -c -- '--post-deploy-command'   # 1
git -C /root/work/clankandslop symbolic-ref --short HEAD                                   # main
GIT_SSH_COMMAND="ssh -i /root/.ssh/clank_public -o IdentitiesOnly=yes" git -C /root/work/clankandslop pull --ff-only origin main
test -z "$(git -C /root/work/clankandslop status --porcelain)" && echo clean
test "$(git -C /root/work/clankandslop rev-parse HEAD)" = "$(git -C /root/work/clankandslop rev-parse origin/main)" && echo at-origin-main
grep -c '^SPAWNFILE_DAIMON_CONTROL_TOKEN=' /home/clank/deploy-work/deploy.env   # 1
test -f /root/work/clankandslop/clankandslop-private/newsroom/runtime/bootstrap-control-token.sh && echo bootstrap-present
test -f /home/clank/deploy-work/grok-runtime-identity-20261009b.json && echo identity-present
df -h /var/lib/docker                                                                       # >= 20G available

# 2b. the deployment record moves from clank's Spawnfile home to root's
test -d /home/clank/.spawnfile/deployments/clank-and-slop && echo record-present
BACKUP=$(mktemp -d) && cp -a /root/.spawnfile "$BACKUP/" 2>/dev/null; echo "backup: $BACKUP"
install -d -m 700 /root/.spawnfile /root/.spawnfile/deployments
cp -a /home/clank/.spawnfile/deployments/clank-and-slop /root/.spawnfile/deployments/
rm -f /root/.spawnfile/deployments/clank-and-slop/.lock
chown -R root:root /root/.spawnfile/deployments/clank-and-slop

# 3. the new units
install -m 644 /root/work/clankandslop/agentic-org/ops/systemd/clank-release.service \
               /root/work/clankandslop/agentic-org/ops/systemd/clank-release.timer /etc/systemd/system/
systemctl daemon-reload

# 4. first release by hand, watched to a stable end state
systemctl start clank-release.service
systemctl show -p Result -p ExecMainStatus clank-release.service          # Result=success ExecMainStatus=0
journalctl -u clank-release.service -n 80 --no-pager | grep -E 'release:|FAILED'   # drained, deployed, post-deploy succeeded, recorded
cat /root/.spawnfile/releases/clank-and-slop/ledger.json
docker inspect -f '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}' spawnfile-clank-and-slop
ls /var/lib/clank-alarm/spool | tail -3                                     # no new deploy-failed breadcrumb

# 5. a second run must be a no-op
systemctl start clank-release.service
journalctl -u clank-release.service -n 5 --no-pager | grep 'nothing to do'

# 6. arm it
systemctl enable --now clank-release.timer
systemctl list-timers clank-release.timer --no-pager

# 7. after the SECOND real release (the first has no rollback tag): remove the
#    seam-era images; release images are clank-and-slop:r-* and pruned by Spawnfile
docker images clank-and-slop --format '{{.Repository}}:{{.Tag}}' | grep ':seam-' | xargs -r docker image rm
```

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

The release runs under the scoped Node 24 binary at
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
| `release-deferred` | `spawnfile release` has deferred the same identity for a day: running turns never drained within the bound — the newsroom is up, it is simply not shipping code |
| `deploy-failed` | any failed `spawnfile release`; the message names Spawnfile's reason word (`build-failed`, `drain-failed`, `deploy-failed`, `health-failed`, `resume-failed`, `post-deploy-failed`, `ledger-failed`, `blocked`, `interrupted`) |
| `no-edition` | the cycle audit found no edition, or one that stopped below `composed` |
| `unit-failed` | a systemd unit failed for a reason its own code never got to name — the `OnFailure=` handler |

Every one of them also lands as a JSON breadcrumb under the spool directory
before the send, so an undeliverable alarm still leaves the text on disk.

## Release runs as clank

`spawnfile release` runs as `clank` (Spawnfile refuses Daimon credentials as
root). One-time host setup, already applied on 2026-10-09:

```bash
setfacl -m u:clank:--x /root /root/work
setfacl -R -m u:clank:rX /root/work/clankandslop
find /root/work/clankandslop -type d -exec setfacl -d -m u:clank:rX {} +
mkdir -p /root/work/clankandslop/.runtime/release-compiled
setfacl -R -m u:clank:rwX /root/work/clankandslop/.runtime
find /root/work/clankandslop/.runtime -type d -exec setfacl -d -m u:clank:rwX {} +
setfacl -R -m u:clank:rwX /var/lib/clank-alarm
find /var/lib/clank-alarm -type d -exec setfacl -d -m u:clank:rwX {} +
sudo -u clank git config --global --add safe.directory /root/work/clankandslop
sudo -u clank git config --global --add safe.directory /root/work/clankandslop/clankandslop-private
# Moltnet local release lives where clank can write (compile writes a verify dir there)
install -d -o clank -g clank /home/clank/deploy-work/moltnet-local-release
```
