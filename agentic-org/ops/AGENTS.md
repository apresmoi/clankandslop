# Unattended operation

Host-side jobs. **Nothing here runs inside a container, nothing here is declared
by an agent, and nothing here may be reached from a compiled workspace** — the
same placement rule `scripts/publish-edition-branch.mjs` follows, for the same
reason: a restriction that executes inside the process a model drives is a
claim about that process, not a boundary around a credential.

The three human steps this replaces:

```
was:  research lands on edition/<date>   →  a person repins, rebuilds, redeploys
      pressman promotes an artifact      →  a person opens and merges the PR
      something breaks                   →  systemd says Failed into a void

now:  clank-seam.timer         (Hetzner)      repin → bundle → build → deploy
      merge-edition.yml        (Actions)      PR + merge, only on its own green CI
      clank-alarm@.service     (both boxes)   ntfy → a phone
```

## The pieces

| File | Runs | Does |
|---|---|---|
| `scripts/seam-run.mjs` | Hetzner, 16:30 Berlin | repin → `org:bundle` → build → `up` → settle |
| `scripts/wake-window.mjs` | inside the seam | derives the safe window from the Spawnfiles, and reads the container to prove nothing is awake |
| `scripts/cycle-audit.mjs` | Hetzner, 23:30 Berlin | did today's cycle reach `composed`? |
| `scripts/alarm.mjs` | both boxes | one HTTPS POST that reaches a person |
| `../../.github/workflows/merge-edition.yml` | GitHub | opens and merges the edition PR, only on green CI |

## Why the seam refuses more often than it runs

A redeploy kills every in-flight wake. `wake-window.mjs` therefore answers
"is it safe" from two independent places and needs both:

- **the schedule**, parsed out of `agents/*/Spawnfile` — not out of
  `policies/schedule.json`, and never hardcoded, because the Spawnfile is the
  only file the compiler lowers into the container's cron. The crons have
  already moved once: the repin script's own header still says the reporters
  wake at 10:00; the tree says 18:00.
- **the running container** — daimon's wake-acceptance receipts (any in
  `accepted` or `running`), the turn usage ledger (any incomplete turn, or any
  turn metered in the last 15 minutes), and the process table (anything outside
  the steady-state set). A container that cannot be read is not quiet: every
  unreadable signal is a finding, and findings block.

## Order is not a style choice

```
repin-private-source.mjs  →  check-bundle-descriptor --repin-source  →  org:bundle  →  check-bundle-descriptor
   private tar,                  descriptor.source                        six tars,        the proof
   private pins,                 + 12 Spawnfile source pins               descriptor
   descriptor.private                                                     (no Spawnfile)
```

- **repin before `--repin-source`**: repinning rewrites
  `policies/private-source.json`, a *tracked* file and therefore part of the
  source archive, so the source digest is only measurable once the pin is in.
- **`--repin-source` before `org:bundle`**: `--repin-source` finds the twelve
  Spawnfile pins by searching for the descriptor's *current* source digest.
  `org:bundle` advances the descriptor and writes into no Spawnfile at all, so
  running it first leaves the repin nothing to match and produces an image
  whose agents pin an archive that no longer exists. Confirmed on the box on
  2026-09-06 by doing it in the wrong order and watching all twelve Spawnfiles
  fall out of agreement with the descriptor.

`seam-run.test.mjs` asserts the order; it is not defended only by this section.

The dependency and asset archives have **no repin at all** — their digests
exist only in the Spawnfiles. If `npm ci` moves `website/node_modules` under
the job, `org:bundle` advances the descriptor and the pins stay put.
`assertPinsMatchDescriptor` catches that and **refuses**; it does not repair
it, because rewriting a dependency pin from an unreviewed rebuild is how you
deploy an archive nobody chose. `etopo-relief.tar` is the one archive a
Spawnfile may pin that the descriptor does not describe (it is built
separately from a ~395MB external download) and it is named in the code, not
skipped silently.

## The build root is load-bearing

Durable volume names are derived from the **path** of the Spawnfile that was
compiled: the edition-state volume is
`…-team-clank-and-slop-root-work-clankandslop-agentic-org-spawnfile-016c21d8-…`.
Building the same tree from a different directory mints different volume names
and silently detaches every agent's mneme memory. `--repo` defaults to
`/root/work/clankandslop` for that reason and for no other.

## Install (Hetzner, root) — complete from clean state

```bash
# 1. the alarm channel: one random ntfy topic, 0600, outside every repository
install -d -m 700 /etc/clank-alarm
printf 'CLANK_ALARM_URL=https://ntfy.sh/<topic>\nCLANK_ALARM_HOST=hetzner\n' > /etc/clank-alarm/alarm.env
chmod 600 /etc/clank-alarm/alarm.env
install -d -m 700 /var/lib/clank-alarm/spool

# 2. a STANDALONE copy of the alarm, independent of every checkout. alarm.mjs
#    imports nothing but node builtins on purpose: an alarm that only works
#    when the repository is in the right state is missing exactly when the
#    repository is the problem.
install -d -m 755 /usr/local/lib/clank-alarm
install -m 755 /root/work/clankandslop/agentic-org/scripts/alarm.mjs /usr/local/lib/clank-alarm/alarm.mjs

# 3. prove the channel before trusting it
set -a; . /etc/clank-alarm/alarm.env; set +a
node /usr/local/lib/clank-alarm/alarm.mjs --selftest

# 4. the units, loaded and DISABLED
install -m 644 /root/work/clankandslop/agentic-org/ops/systemd/*.service \
               /root/work/clankandslop/agentic-org/ops/systemd/*.timer \
               /etc/systemd/system/
systemctl daemon-reload
systemctl disable clank-seam.timer clank-cycle-audit.timer 2>/dev/null || true

# 5. dry-run the seam without deploying
node /root/work/clankandslop/agentic-org/scripts/seam-run.mjs --check
```

**To arm, one command:**

```bash
systemctl enable --now clank-seam.timer clank-cycle-audit.timer
```

To disarm again: `systemctl disable --now clank-seam.timer clank-cycle-audit.timer`.

Arming the timers is **not** starting the org. The org's own guards are
separate and unaffected: every agent cron is parked at `0 4 1 1 *`, and
`fuse.stop` sits in the wake-fuse volume. The seam will happily repin, rebuild
and redeploy a parked organization — which is exactly what you want to be able
to rehearse before unparking anything.

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

## What the publisher now also commits

`publish-edition-branch.mjs` gained one step, for the same reason it already
regenerates `content/topics.txt` and `content/bylines/*.tsv`: those are views
CI diff-checks that nothing else in the pipeline rebuilds. The bundle
descriptor is the third instance, and the one that made unattended publication
impossible rather than merely annoying.

`content/editions/**` is **inside the source archive** — it is a tracked path
and not on the exclusion list — so landing an edition moves
`newsroom-runtime-bundle.json`'s source digest, and ci.yml's *"Check the
runtime bundle descriptor describes this tree"* fails on **every** edition
branch. Measured against `main` (green) plus one restored edition directory:
`source.file_count 1243 -> 1256`, digest moved, check red. Without the repin no
edition branch could ever be green, and the auto-merge would have had nothing
to merge, ever.

So the publisher now repins the descriptor and the twelve Spawnfile source pins
from the branch's own tree — **last**, after the generated views are staged,
because the measurement reads the git index. Nothing about what may be *pushed*
changed: same branch pattern, same refspec, same remote, same refusal of `main`.

`merge-edition.yml` admits those two paths on a shorter leash than the content
paths: every changed line under `agentic-org/` must differ only in a
`sha256:` value or a `file_count`/`content_bytes` field. A Spawnfile edit that
is not a checksum is refused and left for a person.

## What the alarm fires on

| Reason | Raised by |
|---|---|
| `repin-failed` | the edition branch is missing, a desk index is absent, a digest survived the rewrite |
| `bundle-mismatch` | `org:bundle` failed, or the descriptor still disagrees with the tree afterwards |
| `deploy-failed` | the image build failed, `up` failed, or the container never settled |
| `no-edition` | the cycle audit found no edition, or one that stopped below `composed` |
| `seam-blocked` | the schedule was not clear or the container was not quiet |
| `unit-failed` | a systemd unit failed for a reason its own code never got to name — the `OnFailure=` handler |

Every one of them also lands as a JSON breadcrumb under the spool directory
before the send, so an undeliverable alarm still leaves the text on disk.
