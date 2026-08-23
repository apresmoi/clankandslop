# Clank & Slop agentic organization

Run `npm run org:test`, `npm run org:validate`, and `npm run org:runtime`. The last command is expected to fail in a fresh checkout: it prints missing capability names only.

For an offline/local compile, point `SPAWNFILE_MOLTNET_RELEASE_DIR` at an existing authority-matching Moltnet release directory and run `node scripts/compile-local.mjs`. The helper never builds, downloads, or weakens release verification; it only selects a complete local override and invokes the Spawnfile CLI.

The public runtime contract is deliberately narrow. Browser research goes through a broker request/result schema; no browser profile, raw capture, prompt, account identifier, or credential belongs here.
