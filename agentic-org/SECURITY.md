# Security boundary

Runtime admission is fail-closed. Each agent must have an isolated HOME, XDG root, and workspace; a host-provisioned logical CLI identity; permitted broker, network and Git capabilities; and a private root outside the repository. Spawnfile creates the declared Git workspaces and volumes, verifies required environment-secret references before launch, and materializes Moltnet values only into private runtime state. `provision.mjs` creates only configured private day directories after the local admission check and never creates secrets, profiles, or Git state.

Codex subscription credentials use Spawnfile's declared `auth.method: codex` import path for the six release-desk roles. AGY host authentication may be checked as an operator capability, but it is not portable into this Linux runtime and is not mounted or declared as an active engine. AGY use is deferred until a versioned broker contract exists.

The public Git declaration uses HTTPS and contains no repository authentication. Sensor corpus volumes are available only to World Scout, Klaxon, Frontier, and Closure. All roles need the shared edition-state volume to contribute or consume causally linked artifacts; `DATA.md` narrows their writable subpaths.

Pressman is the sole mutable public-content principal through its isolated persistent `./staging` volume. Its release path is local filesystem I/O only: no Git resource, remote endpoint, network publisher, push command, publishing token, or publishing credential is declared or accepted.

Broker results expose cited URLs, retrieval times, a capture digest, private locator, and health only. Public output and Moltnet forbid raw captures, prompts, HTML, account/profile identifiers, secret values, and tooling details.
