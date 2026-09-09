# Clank & Slop agentic organization

The compiler owns checksum-pinned read-only newsroom bundles, the four isolated sensor-corpus volumes, the team-shared edition-state volume, Pressman's isolated persistent local staging volume, and the durable Moltnet store. Pressman receives no Git remote or network publishing authority; a host-side job outside the organization pushes the promoted artifact to one `edition/<date>` branch for a person to merge. Every other role writes durable handoffs under shared edition-state.

Moltnet uses a durable SQLite store and bearer authentication. Every agent, the research intake service, the direct research sensor, the topology operator, and the observe-only console use distinct environment-secret references. All private rooms live directly on the cloud network; the declaration has no federation or relay dependency.

Daily autonomy starts from the reporters' native `Europe/Berlin` schedule at 13:00, continues through 16:30 mechanical release, and stages by 17:00 for an 18:00 public release clock. Downstream wakes are addressed Moltnet messages. Human kickoff, task orchestrators, and polling are prohibited.

From a clean checkout, run the targeted gates and compile with an authority-matching Moltnet release and the exact CLI:

```bash
: "${SPAWNFILE_CLI:?set SPAWNFILE_CLI to the Spawnfile 0.1.17 executable}"
: "${SPAWNFILE_MOLTNET_RELEASE_DIR:?set SPAWNFILE_MOLTNET_RELEASE_DIR to the matching release directory}"
SPAWNFILE_OUT="${SPAWNFILE_OUT:-$PWD/.spawn-local}"
export SPAWNFILE_CLI SPAWNFILE_MOLTNET_RELEASE_DIR SPAWNFILE_OUT
npm run org:test
npm run org:validate
npm run org:runtime
test "$("$SPAWNFILE_CLI" --version)" = "0.1.17"
node agentic-org/scripts/compile-local.mjs
```

The runtime check is expected to fail in a fresh checkout and prints missing capability names only. The compile helper never builds, downloads, or relaxes release verification. Browser research remains brokered; no raw capture, prompt, account identifier, private content, or secret value belongs here.

## Daily private-corpus repin

The reporters wake at 10:00 `Europe/Berlin` and read
`repos/newsroom-private/<edition-date>/desks/<agent>.index`, resolving
`<edition-date>` themselves — nothing templates it. That path only exists if
`newsroom-private.tar` was cut from a private commit that already carries the
day's corpus, so the pin in `policies/private-source.json` has to move every
day:

```bash
node agentic-org/scripts/repin-private-source.mjs
```

It resolves `edition/<today in Europe/Berlin>` in the private repo, rebuilds
`newsroom-private.tar`, rewrites the `private` block of
`newsroom-runtime-bundle.json` and the `private-archive` checksum in every
agent Spawnfile, and asserts that all six reporters' indexes — and every story
row they name — resolve inside the rebuilt archive. It is idempotent and exits
non-zero on any inconsistency; `--check` verifies without writing, and
`--edition=`/`--ref=` override the date and the branch.

**Run repin, rebuild and redeploy between roughly 08:00 and 09:45 Berlin.**
Earlier and the morning's last research intake is not in the branch yet; later
and the redeploy lands on top of a live wake and kills it. Never run it while
the agents are awake.

The source branch is not `main`. Producers commit each day's corpus to
`edition/<date>`, and a separate job merges that branch into private `main`
only in the late afternoon — hours after the reporters needed it — so `main`
carries the *previous* edition at 10:00. Pinning `main` leaves the
organization permanently one day behind, which is why the script refuses a ref
whose tree has no `<edition-date>/desks/` rather than falling back to one.

Installing the timer that calls this is deliberately out of scope for the
repository.
