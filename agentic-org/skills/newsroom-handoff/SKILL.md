---
name: newsroom-handoff
description: Exchange bounded, typed Moltnet messages for one edition.
---

Use the v1 envelope. Include edition, named-zone release, owner, output `artifact_refs`, exact input identities in `derived_from`, revision, causal parent/correlation, deadline and terminal state. Brass assigns one reporter with `recipient` and `article_owner`; that reporter alone ACKs and files. Carry `article_owner` unchanged through review, composition and handoff. `FILED` causally follows its ACK and derives from that ACK plus a prior dossier; a refile derives from its filing, and each decision, composition and handoff derives from the exact prior output. A sensor alone claims and resolves pinpoint work; `PINPOINT_NOT_FOUND` is a valid result.
