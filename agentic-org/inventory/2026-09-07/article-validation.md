# Reporter article validation

Implemented locally; production remains parked and has not received this change.
The six reporters have a declared read-only `validate_article` tool and a shared
format guide. They submit `{edition, article}`, correct field errors themselves,
validate again, then call `file_article`. Filing repeats the same contract before
any durable write. Caslon receives publication-shaped JSON and composes it.

## What is enforced

- Required publication fields and supported optional art, earlier coverage and
  `presentation.flashpoint`; unknown keys and malformed nested shapes reject.
- Canonical single-author byline and Record `used_by_agent`, bound to the
  authenticated reporter. The latter identifies the consumer, not the fetcher.
- Structured key numbers, real clock/date formats, forecast probability and
  confidence label; the next-update clock is not a settlement deadline.
- Positional citations, Record/ref integrity, public HTTP(S) source URLs or
  honest internal provenance, and known topics. New body prose rejects raw HTML.
- Assignment lineage, revisions and asset/earlier-coverage existence remain
  additional filing checks. The preflight names these exclusions explicitly.

The tool never rewrites, fetches, files, commits or fabricates provenance.
Source truth, faithful quotations, meaningful forecasts and editorial quality
still require evidence review. An unused Record row is a warning.

## Reference and validation evidence

The implementation was checked against articles from August 19–22, including
hardware, numeric and map-bearing pieces, plus the August 9 forecast/dissent
format. Existing archive JSON was preserved; all 71 editions validate.

Critical guard deletions fail tests: unconditional filing validation, canonical
author, consumer attribution, unknown-key rejection and positional E-ID
agreement. Direct filing mutations verify rejected drafts leave state unchanged.
All six tool declarations have mutation checks for actor, path, tool and mount.

The private adapter, real stdio MCP, deterministic bundle and installed Codex
configuration tests pass 7/7. Organization tests pass 212 with one dependency
skip. Operations tests pass 55/55, and an actual isolated
Astro build generated 971 pages. The diagram passed its static checks and Chrome
layout checks at desktop and mobile widths. Independent AGY reviews found no
blocking findings in the implementation or combined workflow/instruction changes.

## Real Daimon rehearsal

One isolated Cogsworth wake completed in 111.6 seconds using local Daimon 0.2.0
and Codex 0.153.4 with gpt-5.5. Actual MCP receipts show the exact malformed
August 21 draft rejected, then the saved corrected candidate accepted with zero
errors. Its digest matches the original published article: byline and key-number
format were restored, and every reporting field was unchanged. Complete usage
was recorded: 126,931 tokens, including 96,256 cached input tokens. The host
stopped and both staged authentication files were removed.

Two prior attempts remain recorded: an approval block (58,999 tokens), followed
by a 110-second timeout after a successful rejection and corrected draft. That
failed wake lacked a terminal Daimon usage row; its rollout reports at least
95,370 tokens. The successful third attempt used the narrow approval grant and
a 240-second limit. These failures are preserved, not counted as passes.

The test used real Daimon cognition, local isolated state and the actual MCP
adapter. It did not use Moltnet, file or publish an edition, or reproduce the
deployed container. It proves this reporter-format repair loop, not every role.

The existing Docker e2e entry point still cannot resolve its sibling ecosystem
checkouts from this nested worktree; it stopped before compilation or cognition.
No change was made inside the ecosystem repositories to bypass that boundary.

## Packaging and deployment prerequisite

The private tool source is committed as `de00483ffaca80a8868b6ce0d809d3ae03c4f0b8`.
The public descriptor pins its two-file runtime archive; all six reporter
declarations mount that archive read-only. The shared format implementation stays
in the public source bundle. The new automation stays in the private repository.
Both archives were unpacked into isolated mounts and the packaged MCP server
successfully validated the unchanged historical article against the packaged
public contract and topic catalog.

The installed Daimon bridge strips upstream read-only annotations. Codex needs
the private `approval.mjs` grant for exactly `mcp_validation_validate_article`.
Its real config/read test detects deletion of the grant and preserves the caller's
other policies. Provision it in a fresh home or merge existing TOML tables with a
proper parser. Do not overwrite production defaults or blindly append duplicates.

Before deployment, load matching public and tool bundles and provision the six
grants, then repeat the isolated checks against the deployed runtime version.
This work does not implement per-artifact Git commits, refresh research snapshots,
resolve scheduling/release policy, enforce network restrictions, or prove a full
autonomous edition.
