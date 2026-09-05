# Clank & Slop agentic organization

The compiler owns checksum-pinned read-only newsroom bundles, the four isolated sensor-corpus volumes, the team-shared edition-state volume, Pressman's isolated persistent local staging volume, and the durable Moltnet store. Pressman receives one repository-scoped Git deploy key and no other network publishing authority: it pushes one `edition/<date>` branch and cannot merge it. Every other role writes durable handoffs under shared edition-state.

Moltnet uses a durable SQLite store and bearer authentication. Every agent, the research intake service, the direct research sensor, the topology operator, and the observe-only console use distinct environment-secret references. All private rooms live directly on the cloud network; the declaration has no federation or relay dependency.

Daily autonomy starts from Brass's native `Europe/Berlin` schedule at 14:00, continues through 15:00 finalization, and reaches local/staging release at 16:00. Downstream wakes are addressed Moltnet messages. Human kickoff, task orchestrators, and polling are prohibited.

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
