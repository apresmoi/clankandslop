# Sensor display repair — September 7, 2026

**Fixed and installed on LeDeluge. Both ChatGPT and Grok completed fresh research captures. The Hetzner newsroom remains parked.**

The sensor services selected virtual display `:99`, but no X server was running there. Chrome therefore exited before research began. The repair adds a managed Xvfb user service, starts it at user-manager startup, restarts it on failure, and waits for a successful X11 probe before dependent research services can start.

Implementation is in private repository branch `fix/sensor-display`, commit `030454c`, [PR #7](https://github.com/apresmoi/clankandslop-private/pull/7). Org findings remain here on `feat/agentic-org`; capture files, testing and automation are in the private repository.

| Check | Result |
|---|---|
| Service definition | Validated by the host's systemd 255 |
| Dependency integration | Starting an isolated consumer started its absent X server and produced a successful X11 response |
| Mutation check | Removing `Requires` made that same consumer fail; restoring it recovered the client |
| Crash recovery | Killing the isolated test display caused systemd to start a new working process |
| Automation suite | 157 local tests passed; the additional Linux integration test passed on LeDeluge |
| Independent review | Antigravity reviewed the supplied implementation and found no material defects; Grok CLI's empty timeout was not counted as a review |
| Installed source | Service and drop-in digests match the private-repo implementation |
| Live display | Enabled and active, PID 1651798, zero restarts throughout both captures |
| Browser sessions | Both existing `.clanknslop` profiles opened successfully, with no login intervention |
| Research services | Historical failed state cleared after verification; services inactive and waiting for their next timer occurrences |
| Existing configuration | Timer, tunnel and alarm definitions preserved; daemon reload recomputed the timers' existing randomized delays |
| CI | No CI checks are configured/reported for this private-repo branch |

## Actual capture evidence

These were isolated diagnostic captures using the installed runner, real sensor profiles, `DISPLAY=:99`, and the same per-site locks as scheduled research. The rolling wrapper was not invoked: it would publish to Git and notify Moltnet, and after the daily cutoff it can exit zero without capturing. The diagnostic captures were neither published nor announced to the newsroom.

| Capture | Completed UTC | Report characters | Saved markdown | Exported source links |
|---|---|---:|---:|---:|
| Grok | 15:52:29 | 12,738 | 15,826 bytes | 15 |
| ChatGPT | 15:55:50 | 23,342 | 24,823 bytes | 0 |

The saved files were read back, not inferred from process exit status. ChatGPT's visible task also reported research completion; its requested Extra High effort and Deep Research mode were confirmed before submission.

Private verification state is under `.runtime/sensor-display/` in the private implementation worktree, with corresponding captures under `/home/apresmoi/clankandslop-private/.runtime/sensor-display/` on LeDeluge. Markdown SHA-256:

- ChatGPT: `4e21f5c7e074dae8355b42ebfca3ea02991cf09c88f7db5eed3d0f0b6d38fbd5`.
- Grok: `10f1c40635b253cc1ef0f4799d6933143029a37f5e3977544a9a6d6cc582f8fc`.

## Separate runner problems exposed by the successful launches

1. **ChatGPT citation capture:** the report text was saved, but no source links were exported and the HTML sidecar is empty. The runner reads the research iframe's text and searches it for literal URLs; it does not preserve that iframe's HTML citation anchors. This capture is not adequate evidence-backed research for filing until its source references are recovered and verified.
2. **Grok model selection:** the runner could not verify its requested Expert model because the expected selector did not match the displayed UI. It nevertheless submitted and labelled the export with the requested model. That label is not evidence of the actual selected model; repair selection/verification before relying on the configured depth.

The display repair is complete. These two runner issues are follow-up work; no prompt, article, corpus pin, newsroom schedule or publishing gate was changed by this repair.
