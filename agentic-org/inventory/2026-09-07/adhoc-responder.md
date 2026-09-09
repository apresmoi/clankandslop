# Ad hoc responders: deployment and verification

**Both ChatGPT and Grok completed real research requests through isolated
Moltnet. The production responder is installed, connected and enabled on the
4090. The newsroom remains parked.** Verified September 7, 2026, 18:34–18:58 UTC.

## Deployed behavior

- Private implementation commit: `428f10b`, `feat(sensors): add durable Moltnet
  ad hoc research responder`, on `feat/adhoc-research-responder`.
- Unit: `clank-adhoc-research@production.service`, enabled, active, zero restarts.
  Repeated healthy journal entries reported zero pending requests after 18:53 UTC.
- Production configuration uses the same managed Moltnet client as scheduled
  research. Its loopback 8787 connection is the existing SSH tunnel to Hetzner.
- Fixed activation: `2026-09-07T18:51:16.751440+00:00`. No historical request was
  launched; the production responder's request directory remained empty.
- Six reporters and Brass may request research. Default routing sends explicit
  X/Twitter questions to Grok and general research to ChatGPT. One durable queue
  shares browser locks with scheduled captures.
- Defaults: two admitted requests per requester, twelve per edition, twenty
  minutes per capture plus an outer deadline. Failed attempts consume the limit.
- Request identity, launch intent and exact replies persist. Uncertain crashed
  research is refused instead of repeated. Replies are confirmed by reading
  their authenticated sender and exact contents from durable Moltnet history.

Installed hashes of all seven runtime modules match the tested private source.
No newsroom image, schedule, article, pinned corpus or release timer changed.
Hetzner stayed healthy with zero container restarts; seam, cycle-audit and publish
timers were still disabled and inactive at the final inspection.

## Real transport and capture evidence

The rehearsal used a separate Moltnet 0.1.18 server on 4090 loopback port 18987,
network `clank-adhoc-test`, fresh bearer credentials and SQLite state, and no
federation. Its binary matched production, SHA-256
`08214774f890a561e6de898582bb2ac492433c5f9110a1d8ec0f36d9530d2337`.

Synthetic probe identities asked an ESA launch-date question through real
Moltnet. The responder ran the existing headed browser research sessions and
returned actual sourced findings; there was no fixture substituting for research.

| Probe | Capture started UTC | Answer stored UTC | Findings | Answer bytes | Browser launches |
|---|---|---|---:|---:|---:|
| ChatGPT | 18:41:31 | 18:44:38 | 2 | 865 | 1 |
| Grok | 18:44:38 | 18:48:49 | 2 | 902 | 1 |

Both answers were `research.answer.v1`, `status: found`, with the matching
request ID, literal requester mention and server-stamped credential-bound sensor
identity. The verifier checked exact ledger agreement and SHA-256 against each
actual private capture file, not merely a successful process exit.

ChatGPT request: `probe-chatgpt-36fa9923698a`. Grok request:
`probe-grok-2e85f39d652e`. Capture digests, respectively:

- `e56f213d2a7dcdecb0375fd8c688c91c641f5ebee4c9442acf9426133842dedb`
- `cdd00c003b2ea65909caf44d39a4a3ac44b41a6c23e3f16c36b57d8246714847`

Exact wire replay and a second message ID carrying the same request caused no
additional capture. An authenticated but unauthorized test member caused no
request admission or research. After restarting both test services and replaying
both requests, the same two answers and one launch per request remained.

The disposable test services were stopped and their units removed; port 18987
closed. Private captures, history and verification receipts were retained.

## Checks and fixes

- Full private automation suite: 175 tests, 174 passed, one Linux-only display
  integration test skipped locally. The display integration had already passed
  on the 4090 during its repair.
- Seventeen responder tests and three rehearsal tests passed. Eight responder
  mutations and the rehearsal's network-guard mutation were detected.
- Antigravity independently reviewed the responder and final rehearsal helpers,
  with complete reports and no material findings. An empty headless review
  attempt was discarded and rerun; it was not counted as a pass.
- Live testing found Moltnet's empty terminal page uses `messages: null`.
  Normalizing that specific valid wire shape fixed an endless retry; a regression
  test and mutation check cover it.
- Initial production installation selected an obsolete repository client URL.
  Reusing the scheduled sensors' managed client configuration restored the real
  tunnel connection. The installation instructions now identify that configuration.

## What this establishes, and what remains

This proves the responder's real Moltnet/browser/answer path. It does **not**
prove a real Daimon agent's requesting turn, mention-triggered second turn or
editorial use of the answer. That remains the next isolated agent test.

The production endpoint was checked for connectivity and stable idle operation;
test requests used the isolated endpoint to avoid waking production reporters.
No human messages or edition publication were sent.

Grok returned cited research, but its runner still could not verify the requested
model selector. ChatGPT's ad hoc prompt required literal URLs, which survived
this capture; the rolling capture's citation-anchor export defect is not fixed
by this change. Research-model claims still require editorial verification.

The org-wide prohibition on independent agent web access remains unresolved.

**Cloudflare is a relay, not the newsroom server.** Production Moltnet and its
SQLite state live on Hetzner. The observer pairing was reachable through the
Worker, but turning off Hetzner still removes the production message API and
the sensor's SSH-tunnel destination. The isolated server on the 4090 works
independently because it owns its own message API and database.

All automation and raw evidence remain in the private repository. This report
and the updated public research protocol are local org records on `feat/agentic-org`.
