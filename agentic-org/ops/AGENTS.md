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

`repin-private-source.mjs` runs **standalone and first**, `npm run org:bundle`
second. Two independent reasons:

1. `check-bundle-descriptor.mjs --repin-source` finds the Spawnfile pins by
   searching for the descriptor's *current* digest. A bundle build that ran
   first advances the descriptor and leaves the repin nothing to match.
2. `policies/private-source.json` is a tracked file and therefore part of the
   source archive. Repinning it changes `newsroom-runtime.tar`, so the tar has
   to be rebuilt *after* the repin or it stops being the archive every
   Spawnfile pins, and the image carries a resource no agent can verify.

`seam-run.test.mjs` asserts that order; it is not defended only by this
paragraph.

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

# 2. prove the channel before trusting it
set -a; . /etc/clank-alarm/alarm.env; set +a
node /root/work/clankandslop/agentic-org/scripts/alarm.mjs --selftest

# 3. the units, loaded and DISABLED
install -m 644 /root/work/clankandslop/agentic-org/ops/systemd/*.service \
               /root/work/clankandslop/agentic-org/ops/systemd/*.timer \
               /etc/systemd/system/
systemctl daemon-reload
systemctl disable clank-seam.timer clank-cycle-audit.timer 2>/dev/null || true

# 4. dry-run the seam without deploying
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
install -d -m 700 ~/.config/clank-alarm
printf 'CLANK_ALARM_URL=https://ntfy.sh/<topic>\nCLANK_ALARM_HOST=ledeluge\n' > ~/.config/clank-alarm/alarm.env
chmod 600 ~/.config/clank-alarm/alarm.env
systemctl --user daemon-reload
```

The drop-ins live in `~/.config/systemd/user/<unit>.d/alarm.conf` and add only
`OnFailure=`; no timer is enabled, disabled or rescheduled by them.

## What the alarm fires on

| Reason | Raised by |
|---|---|
| `repin-failed` | the edition branch is missing, a desk index is absent, a digest survived the rewrite |
| `bundle-mismatch` | `org:bundle` failed, or the descriptor still disagrees with the tree afterwards |
| `deploy-failed` | the image build failed, `up` failed, or the container never settled |
| `no-edition` | the cycle audit found no edition, or one that stopped below `composed` |
| `seam-blocked` | the schedule was not clear or the container was not quiet |

Every one of them also lands as a JSON breadcrumb under the spool directory
before the send, so an undeliverable alarm still leaves the text on disk.
