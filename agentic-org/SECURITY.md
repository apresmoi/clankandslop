# Security boundary

Runtime admission is fail-closed. Each agent must have an isolated HOME, XDG root, and workspace; a host-provisioned logical CLI identity; permitted broker, Moltnet, network and Git capabilities; and a private root outside the repository. `provision.mjs` creates only configured private day directories after that check and never creates credentials, profiles, or Git state.

Codex subscription credentials use Spawnfile's declared `auth.method: codex` import path for the six release-desk roles. AGY host authentication may be checked as an operator capability, but it is not portable into this Linux runtime and is not mounted or declared as an active engine. AGY use is deferred until a versioned broker contract exists.

Broker results expose cited URLs, retrieval times, a capture digest, private locator, and health only. Public output and Moltnet forbid raw captures, prompts, HTML, account/profile identifiers, credential fields, and tooling details.
