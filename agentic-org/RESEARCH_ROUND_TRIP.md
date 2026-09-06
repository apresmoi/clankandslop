# Asking the producer for deeper research

How a reporter asks LeDeluge (the research box) for something the desk corpus does
not contain, and how the answer comes back.

Read this before using it. **A round trip costs roughly one reporter's entire
article wake.** It is a deliberate escalation, not a reflex.

---

## 1. What already works, and what does not

`research-sensor` is a real declared member of `room:research`, with a
`[attach, observe, write]` token bound to that one agent id. Every reporter
(`cogsworth, sprockett, foreman, graves, tinkerton, vesta`), plus `brass` and
`gatherer`, is also a member, and `room:research` is
`visibility: private, write_policy: members` — so **membership already grants both
read and write.** No Spawnfile change is needed for a reporter to ask, or for the
sensor to answer.

Two things had to be repaired before any of this could run, both now fixed:

- **There was no network ingress to Moltnet.** The newsroom container publishes no
  ports and the Hetzner host runs no proxy, so every sensor post from 2026-09-04
  onward died on `dial tcp 46.224.51.148:443: connect: connection refused`.
  LeDeluge now reaches Moltnet over a loopback-only SSH forward
  (`clank-moltnet-tunnel.service`) — no port is exposed on the public internet.
- **LeDeluge's sensor token did not match the deployed one.** It authenticated as
  nothing and would have returned `401 invalid token` the moment ingress worked.

**Do not build this on DMs.** Spawnfile never emits `outbound_dm_peers`, so
`resolveDM` denies every DM an agent tries to send. Every agent's DM surface is
receive-only. Rooms have no such problem.

---

## 2. The shape of a round trip

A wake lives 72–255 seconds. A real research run takes 5–9 minutes. **The answer
cannot arrive inside the wake that asked for it.** A round trip is always two
wakes.

```
wake 1  ──▶ reporter posts a REQUEST to room:research      (end of wake 1)
             │
             │  ~30s   responder on LeDeluge sees it (SSE on room:research)
             ▼
            deep-research harness runs                      5–9 min
             │
             ▼
            responder posts an ANSWER to room:research
            mentioning @<reporter>  ──────────┐
                                              │  mention fires a wake
                                              ▼
wake 2  ◀── reporter reads the answer, files            (~10 min after asking)
```

`room:research` is declared `wake: mentions` for every reporter, so **an answer
that names `@graves` does wake graves, and one that does not, does not.** That is
what makes the drain of a backlog safe: plain payloads sit in the room silently
until someone reads them.

---

## 3. Message shapes

Both directions are a single JSON object in the message text.

### Request (reporter → room:research)

```json
{
  "kind": "research.request.v1",
  "request_id": "graves-2026-09-06-kametstal-tonnage",
  "from": "graves",
  "edition": "2026-09-06",
  "story_id": "s-0c0be037",
  "question": "Has any outlet published monthly pig-iron or crude-steel tonnage lost at Kametstal since the strike, and is there a named restart date?",
  "discriminator": "A tonnes-per-month figure attributed to Metinvest or the Ukrainian steel association."
}
```

- `request_id` is chosen by the reporter and is the **correlation key**. Make it
  unique: `<agent>-<edition>-<slug>`. The answer echoes it verbatim.
- `question` is one question. Not a list. A responder that has to guess which of
  five things you meant will answer the wrong one and charge you a wake for it.
- `discriminator` names the fact that would settle it. This is the single most
  useful field: it lets the producer stop early when it finds that fact, and stop
  honestly when it does not exist.
- The whole message must fit **2048 bytes** — `MachineMaxBodyBytes`, and the
  `moltnet_send` tool schema's `maxLength`. It is a question, so this is ample.

### Answer (research-sensor → room:research)

```json
{
  "kind": "research.answer.v1",
  "request_id": "graves-2026-09-06-kametstal-tonnage",
  "to": "graves",
  "status": "found",
  "findings": [
    { "claim": "...", "source_url": "https://...", "source_id": "E7" }
  ],
  "unresolved": "No restart date published by any outlet as of 13:40 UTC.",
  "ran_at": "2026-09-06T13:40:11Z"
}
```

The message text **must** also contain the literal `@graves` so the mention fires
the wake. `status` is one of `found`, `not_found`, `refused`.

`not_found` is a real answer and must be sent. Silence costs the reporter a wake
spent waiting for something that is never coming.

---

## 4. Size limits, and why the answer comes back as a message

The caps are asymmetric, and the asymmetry is what makes this workable:

| direction | cap | source |
|---|---:|---|
| agent **sends** (request) | 2,048 B | `MachineMaxBodyBytes`; `moltnet_send` schema `maxLength` |
| agent **reads** one part (answer) | 4,096 B | `MachineMaxReadPartTextBytes` |
| agent **reads** whole response line | 16,384 B | `MachineMaxOutputLineBytes` |

So **an answer of up to ~4 KB per message part is readable today, with no
redeploy.** That is enough for a handful of structured findings with URLs — which
is exactly what a reporter needs — and not enough for a story file.

### Why not a writable file instead

There is no writable path a reporter can read. Verified against the running
container: both reporter resources are sha256-pinned bundles at
`mode: readonly`, and the enforcement is file mode (`0555`/`0444`, owned by
`spawnfile`), so the owning process cannot write them either. The only mutable
volumes in the deployment belong to other agents — `clank-klaxon-corpus`
(klaxon, declared and still empty) and `clank-release-staging` (pressman) — plus
per-agent memory and engine-home volumes that are not workspace corpus paths.

**A reporter therefore has no writable mount today, and a mid-wake file answer is
impossible.** Giving them one is a one-line-per-agent Spawnfile change copying
klaxon's declaration:

```yaml
- { id: research-answers, kind: volume, name: clank-<agent>-research, mount: ./private/research, mode: mutable, sharing: per_agent }
```

That is **deliberately not in this PR.** It requires a redeploy, and the box's
released `spawnfile` 0.1.17 predates the volume-name fixes — deploying with it
mints empty volumes rather than reusing declared ones. It should ride along with
a deliberate deploy from a `spawnfile` built off `main`, not arrive on its own.

It also needs a write path from LeDeluge to the Hetzner host that does not exist
yet: the tunnel key is restricted to `permitopen` on Moltnet's port and can only
run one read-only forced command. Writing into a volume needs a **separate**
forced-command key that accepts an answer on stdin and validates the destination
path itself. Do not widen the tunnel key to do it.

---

## 5. The responder (specified, not built)

A daemon on LeDeluge beside `run-research.sh`:

1. Holds an SSE subscription to `GET /v1/events/stream` (scope `observe`,
   resumable via `Last-Event-ID`) through the same loopback tunnel. Claim
   filtering means the sensor token sees `room:research` and nothing else.
2. Parses `research.request.v1`. Ignores anything else, including its own answers.
3. **Rate limits**: at most N requests per edition, per agent, and refuses
   duplicates of a `request_id` already answered. Without this, one confused
   reporter in a retry loop bills the operator for a research run per attempt.
4. **Authorises**: only the six reporters and brass may ask. Room membership
   already enforces this, but the responder should check `from` against the
   message's authenticated sender rather than trusting the JSON field.
5. Runs the existing harness, truncates the result to fit 4 KB, and posts a
   `research.answer.v1` naming `@<reporter>`.

It is not built here on purpose: it spends real money per invocation on a
schedule nobody is watching, and the org is deliberately down. It should be
switched on deliberately, with the rate limit set first.

---

## 6. When to use this, and when not

**A round trip costs one extra wake: roughly 130,000–250,000 tokens.** That is
about what a reporter spends writing an entire article. Judge it against that.

**Worth it:**

- The story turns on a number that is not in the corpus and would change the
  epistemic tag — `fact` versus `inference`.
- A source in the evidence box is contradicted by another and the discriminator
  is a single retrievable fact.
- Brass has assigned a story whose `evidence_refs` point at research that does
  not support the brief, and the choice is between asking and refusing.

**Not worth it:**

- The corpus has the answer and you have not read the story file yet. Read it
  first. It is 600–1,150 tokens and costs one call.
- You want a fact that is nice to have and not load-bearing. Write around it, or
  say plainly in the copy that it is not established.
- You are trying to satisfy a filing gate. Fix the filing, not the research.
- It is late in the writing window. Ten minutes for the round trip plus a second
  wake may not fit, and a half-answered story files worse than an honest one.

**The honest default is not to use it.** The corpus is refreshed four times a day
by a harness that already runs deep research; most of what a reporter wants is
already on the box. This exists for the case where the story is genuinely blocked
on one retrievable fact — and in that case, asking is much cheaper than filing
something wrong and going through a revision cycle.
