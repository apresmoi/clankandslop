# Sensor inventory — 2026-09-07

**LeDeluge is reachable, but today's research production is broken: all eight scheduled captures failed before Chrome could start. No September 7 corpus was produced.** The research transport now answers through its SSH tunnel; that does not repair capture, corpus freshness, or agent wake routing.

Read-only inspection at **15:00–15:03 UTC / 17:00–17:03 Berlin**. Production was left parked: no restarts, research requests, agent wakes, Moltnet sends, commits, or publication actions. Times below are UTC unless explicitly marked Berlin. LeDeluge's operating-system timezone is UTC−3; its research calendar explicitly uses Europe/Berlin.

## Live inventory

| Component | Location | Verified state | Consequence |
|---|---|---|---|
| Sensor workstation | `LeDeluge`, LAN `192.168.178.24`, SSH `ledeluge` | SSH responds; uptime 43 days | Workstation is available on this network |
| GPU | NVIDIA GeForce RTX 4090 **Laptop** GPU, 16,376 MiB | 10 MiB used, 0% GPU utilization | These research sensors use browser subscription sessions; GPU availability does not establish research health |
| Ollama | LAN TCP 11434 | GET `/api/version` returns `0.14.2`; service active | Local model endpoint reachable; no inference request was sent |
| ChatGPT research | User `clank-research@chatgpt.service` | Failed, exit 1; latest attempt 11:31:47 | No latest capture |
| Grok research | User `clank-research@grok.service` | Failed, exit 1; latest attempt 12:05:47 | No latest capture |
| Research timers | User `clank-research-chatgpt.timer`, `clank-research-grok.timer` | Enabled and waiting | Timers remain armed despite broken capture |
| Display dependency | Research services set `DISPLAY=:99`; `/usr/bin/Xvfb` exists | No Xvfb process, no X99 socket, no managed Xvfb unit found; only GDM X0 exists | Both headed browser launches fail immediately |
| Moltnet tunnel | User `clank-moltnet-tunnel.service` | Active since September 7 00:55:57; restart count **35**, unchanged across repeated probes | Historical restart storm, currently stable |
| Transport endpoint | LeDeluge `127.0.0.1:8787` through SSH to Hetzner | GET `/healthz` returns HTTP 200, `{"status":"ok"}` | HTTP routing works; no authenticated message was sent during this audit |
| Private research merge | User `clank-edition-merge.service` | September 7 14:15:50 exit 0: **“no edition/2026-09-07 on origin — nothing to merge”** | Success exit code is a no-op, not an edition |
| Alarms | User `clank-alarm@.service`, local alarm log | All eight capture failures recorded | Current handler intentionally records locally and sends nothing |
| Sensor containers | Docker on LeDeluge | No Clank research sensor container | Relevant sensors run as host user services; unrelated Docker workloads were not assessed |

## Capture and timing

- September 7 failed ChatGPT slots: **02:00, 06:38, 10:52, 13:31 Berlin**.
- September 7 failed Grok slots: **03:07, 07:59, 12:22, 14:05 Berlin**.
- Every launch reports `Missing X server or $DISPLAY`, then `deep-research capture failed (exit 1)`; the wrapper removes empty intake stubs. The absent corpus is therefore an honest failure, not eight prompt-only files masquerading as output.
- No September 7 intake files were present, and a read-only `git ls-remote` found no `edition/2026-09-07` branch.
- The capture wrapper stops accepting slots at **15:00 Berlin**. Today's cutoff had already passed when inspected.
- Configured ChatGPT hours are **01, 06, 10, 13 at :13**, Grok **02, 07, 11, 13 at :41**, each with up to 50 minutes randomized delay. The descriptions saying “every four hours” are imprecise.
- Next actual timer deadlines observed: **September 8 01:37:29 Berlin** for ChatGPT and **02:45:47 Berlin** for Grok. Next research cutoff: **September 8 15:00 Berlin**.
- Private research merge runs around **16:08–16:18 Berlin**; next observed deadline was September 8 16:09:23. This merges the private research branch, not a newspaper edition publication.

The owner of the current failure is the **host display lifecycle**: the services depend on a headed display but neither start it nor declare a managed display dependency. Browser login validity remains unverified because launch fails first. Changing model settings or restarting the newsroom would not address this failure.

## Yesterday's corpus and delivery

| Evidence | Verified result |
|---|---|
| Last scheduled capture and split | September 6 12:20; Grok intake committed, then corpus split committed as `5280db2` |
| September 6 corpus | **25 story files, 8 intake markdown files**, no unrouted stories in index |
| Latest index generation | September 6 **14:02:26**, from a later re-split |
| Desk membership counts | Cogsworth 16; Foreman 8; Graves 11; Sprockett 19; Tinkerton 20; Vesta 4; stories can belong to several desks |
| Producer checkout | `/home/apresmoi/clankandslop-private`, branch `edition/2026-09-06`, HEAD **`6f2524d`** |
| Remote private branches | `edition/2026-09-06` also `6f2524d`; `main` **`54cb8d8`**; edition branch is one commit ahead |
| Public archive used by producer | `/home/apresmoi/clankandslop`, **`d898e8f`**; prepared documents stamp this archive identity |
| Old notification failures | September 6 journals prove completed captures/splits followed by HTTPS port 443 connection refusal and exit **75/TEMPFAIL** |
| Queue markers now | **0** top-level undelivered files; **15** old files under `delivered/` |

The historical public URL `https://moltnet.46-224-51-148.sslip.io` was refused yesterday. Installed overrides now select a private loopback config and SSH tunnel:

```text
LeDeluge capture
├─→ private edition branch ─→ pinned runtime bundle
└─→ research-sensor ─→ SSH tunnel ─→ room:research (no mention)
```

The tunnel resolves the newsroom container IP when it starts. Its last successful start named `172.17.0.3`; the subsequent read-only health request succeeded. The inspected producer sends JSON to `room:research` with an event key, edition, sensor, intake path, digest and branch. It includes **no `@klaxon` mention**, sends no Klaxon DM, and has no live corpus-copy step: git push plus notification is not a refresh of an immutable runtime bundle.

The live Hetzner Moltnet store independently confirms **15 accepted research-sensor messages to room:research on September 6 13:17:25–13:17:39 UTC**, all without mentions. Klaxon has four token-tuning probe rows and no recorded sensor-triggered completed turn. Accepted delivery therefore did not demonstrate watcher cognition. The public org's deployed wake configuration must be used for that check: the private repo also carries an older Klaxon declaration with a different network and patrol schedule, which is not evidence of today's deployed watcher.

The live container mounts private bundle `ae5eb79b…`, declared at `6f2524d`, and all twelve agents have the four prepared September 6 desk files. Missing prepared files at the committed public branch pin `5280db2` are a reproducibility gap, **not a current live absence**. No mounted September 7 corpus exists.

## Prepared-input mismatch

**Advancing the corpus pin alone is insufficient; consumers must read the correct authoritative outputs.** Live producer files demonstrate two competing paths:

| Output | Current producer contents |
|---|---|
| `desks/ledger.worlddesk.prepared.json` | `document:null`; claims required registries do not exist; offers prior-edition carry-forward **0.68 / stale / 8 / 5** |
| `worlddesk/ledger.worlddesk.json` | Derived **0.4615 / first reading / 2 open / 1 watch**, with trace and registry identities |
| `desks/caslon.weather.prepared.json` | **16°C**, Open-Meteo observation September 6 **21:15** |
| `worlddesk/caslon.weather.json` | **20°C**, receipt fetched September 6 **16:09:36**, then reused from edition cache |
| Four `desks/*.prepared.json` files | Present in producer branch, generated September 6 **21:15:21** |
| Pinned commit `5280db2` | No prepared documents or World Desk output paths in its edition tree |

The derived World Desk trace names a seven-proxy registry, three triggering proxies and weighted sum **6/13**; this audit verified the persisted trace and result, not an independent recomputation of upstream market data. The two weather values have different timestamps, so disagreement is not proof of invented weather; it is proof that two producers offer competing observations.

The current `run-research.sh` runs desk preparation and World Desk/weather producers **after** browser capture and desk split. Today's capture failure prevented this entire downstream path from running. Their latest persisted files came from yesterday's subsequent producer work; no successful scheduled end-to-end run under the newer pipeline was observed.

The current `_all.index` still has a numeric **`urls` count**, not URL strings or source-domain lists. For example, the first rows carry 7 and 4. A commissioning rule cannot assess independent source domains from that column alone; a proposed fix must expose domain evidence or authorize the necessary story reads within the commissioning constraints.

## Bounded validation before the first edition

1. **P1 — restore the display dependency at its owner.** Provide a persistent managed display for the existing headed workflow; then verify a real non-empty capture, fresh split, git artifact and delivery receipt. A running Xvfb process alone is not acceptance.
2. **P1 — establish today's usable corpus.** Select an explicit edition date and cutoff, require fresh intake/corpus artifacts, and verify the running reporters actually see the selected corpus identity. September 7 has no research corpus now.
3. **P1 — resolve sensor-to-watcher routing.** Accepted delivery is now reconciled against the server store; next prove the intended notification wakes Klaxon under its deployed wake policy in an isolated network. HTTP health and archived markers are weaker evidence.
4. **P1 — resolve producer/consumer authority.** Ensure Ledger and Caslon consume the derived World Desk and chosen weather observation, with provenance, rather than the stale prepared fallback. Check the actual runtime bundle, not only repo HEAD.
5. **P2 — make missing output visible at cutoff.** The private merge currently returns success when the day's research branch is absent; failure logs are local only. The inventory should distinguish missing corpus from successful closure.
6. **P2 — preserve commissioning evidence.** Independent-domain eligibility needs actual domain provenance; the index's URL count cannot satisfy that check.

All validation that would start research, wake agents, redeploy or publish remains pending while production is parked. This report changes no running state.
