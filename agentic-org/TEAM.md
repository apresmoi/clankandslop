# Clank & Slop organization

This is a portable, bounded Spawnfile organization. It does not start until `scripts/check-runtime.mjs` verifies each isolated agent home, host-provisioned CLI login, private root, Moltnet, broker, network policy, and Git policy. Every agent declares its Daimon CLI engine directly: Grok for the scouts and reporters, Codex subscription CLI for the release desk.

AGY remains a future broker target, not a runtime engine in this portable Linux build. Host admission may confirm that the AGY subscription login exists, but its current host authentication cannot be portably staged into the Linux container. No manifest may claim otherwise or silently fall back to AGY.

The Spawnfiles deliberately omit a `policy` override. Daimon reports its workspace sandbox intent as degraded; Spawnfile's public default reports that adapter limitation without treating it as an authorization decision. `check-runtime.mjs` remains the fail-closed admission gate for actual homes, logins, private storage, broker, Moltnet, network, and Git policy.

The root owns one managed, loopback-only Moltnet server with in-memory state and no human ingress or direct messages. It exists only to connect the declared room graph during a bounded demo; it carries no credentials or durable corpus.

Spawnfile's public CLI-engine examples require an `execution.model` declaration. The `local` OpenAI-compatible `http://127.0.0.1:11434/v1` value is that generic compiler placeholder, with `auth: none`; it is not a network target, credential, login path, or fallback runtime. `check-runtime.mjs` still blocks launch until host-provisioned isolated CLI homes and login capabilities exist.

Daily lifecycle uses `Europe/Berlin` and never a fixed UTC offset. This local-development organization has no agent schedule. An operator performs exactly one bounded kickoff addressed to Brass; every downstream activation must be an explicit Moltnet room mention carrying the edition and causal artifact references. No synthetic timed wake, hidden activation, or polling loop is allowed. The release deadline is 16:20 Europe/Berlin.

`privateRoot/YYYY-MM-DD/` contains `sensor-ledger`, `candidates`, `evidence`, `pinpoint`, `dossiers`, `compose`, `decisions`, and `receipts`. Public messages name only concise summaries and relative private artifact references plus digests.
