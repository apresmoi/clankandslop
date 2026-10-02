// What the `bundle` stage is allowed to leave behind in the working tree, and
// nothing else.
//
// WHY A PATH ALLOWLIST WAS NOT ENOUGH
// -----------------------------------
// release-ledger.mjs refuses to release a tree that does not match its commit,
// because a release has to be reproducible from a commit. But `bundle`
// legitimately rewrites digest pins mid-run — the descriptor it measures and the
// twelve agent Spawnfiles whose source and public-asset pins it advances — so
// those paths were allowlisted WHOLESALE. That hole was found on 2026-10-01 and
// it is as wide as the files are important: an uncommitted edit to any agent
// Spawnfile — a changed prompt, a new tool grant, a widened Moltnet room, a
// raised token ceiling — passed the gate untouched and shipped. Those twelve
// files are the most security-relevant declarations in the repository, and they
// were the exempt ones.
//
// The fix is not a better list of files. It is to allowlist the SHAPE of the
// permitted change: for each allowlisted path, diff it against its committed
// version and accept only hunks that differ in a digest value (and, for the
// descriptor, in the two measurements that travel with a digest). One changed
// word of a prompt is a refusal that names the file and the line.
//
// WHY A DIFF AND NOT A RE-READ OF THE FILE
// ----------------------------------------
// Re-reading the whole file would mean modelling what the bundle build writes —
// predicting another program's output, which is a check that drifts away from
// it. The diff asks a smaller question with a definite answer: of the lines that
// CHANGED, is every one of them the same line with a different digest?
//
// Fail-closed throughout. Anything this module does not recognise — a mode
// change, a rename, a binary diff, a hunk header it cannot parse — is a finding,
// never a pass. An unrecognised change to one of these files is exactly the case
// the check exists for.

// `sha256:<64 hex>` wherever it appears: `sha256: sha256:...` in a Spawnfile
// resource line, `"sha256": "sha256:..."` in the descriptor.
//
// Two copies of each pattern, one global for `replace` and one not for `test`,
// because a `/g` regex carries `lastIndex` between calls and a shared one would
// answer "does this line carry a digest" differently depending on what it was
// asked about last.
const DIGEST = /sha256:[0-9a-f]{64}/u;
const DIGEST_ALL = /sha256:[0-9a-f]{64}/gu;
// The descriptor's two measurements. They are not security-relevant on their own
// — they describe the archive the digest already pins — but they move with it on
// every bundle build, so refusing them would refuse every release.
const MEASUREMENT = /"(file_count|content_bytes)":\s*\d+/u;
const MEASUREMENT_ALL = /"(file_count|content_bytes)":\s*\d+/gu;

// Diff lines that carry no content. Everything else that is not a `+`/`-` body
// line is a finding: `old mode`, `new file mode`, `deleted file mode`,
// `similarity index`, `rename from`, `Binary files ... differ`.
const METADATA = /^(diff --git |index |--- |\+\+\+ )/u;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export const DESCRIPTOR_FIELDS = Object.freeze(['sha256', 'file_count', 'content_bytes']);

// A changed line is permitted only if it CONTAINS a digest (or, in the
// descriptor, a digest or one of its measurements). A line with nothing pinnable
// on it cannot be a digest rewrite whatever else it looks like.
const carriesPermitted = (line, descriptor) => DIGEST.test(line) || (descriptor && MEASUREMENT.test(line));

// Blank the permitted values out. What is left is the line's MEANING: if the
// before and after lines are the same once the digests and measurements are
// blanked, the digest is all that moved.
const normalize = (line, descriptor) => {
  const withoutDigests = line.replace(DIGEST_ALL, 'sha256:<digest>');
  return descriptor ? withoutDigests.replace(MEASUREMENT_ALL, '"$1": <measured>') : withoutDigests;
};

const sorted = (lines) => [...lines].sort();

/**
 * Findings for one allowlisted path's `git diff HEAD -U0 -- <path>` output.
 * Empty means the change has the shape of a bundle rewrite and nothing else.
 *
 * @param {string} file the path as git names it, used in the findings
 * @param {string} diff the unified diff, zero context
 * @param {{ descriptor?: boolean }} [shape] descriptor fields are permitted too
 */
export function bundleRewriteFindings(file, diff, { descriptor = false } = {}) {
  const findings = [];
  // Hunks are accumulated and compared per hunk rather than across the whole
  // file: a prompt word deleted in one hunk and a digest changed in another must
  // not be able to balance each other out into a matching multiset.
  let hunk = null;
  const close = () => {
    if (!hunk) return;
    const removed = sorted(hunk.removed.map((line) => normalize(line, descriptor)));
    const added = sorted(hunk.added.map((line) => normalize(line, descriptor)));
    if (removed.length !== added.length || removed.some((line, index) => line !== added[index]))
      findings.push(`${file}:${hunk.line} changes more than a digest value — ${hunk.removed.length} line(s) removed and ${hunk.added.length} added do not match once digests are blanked, so this is not a bundle rewrite`);
    hunk = null;
  };
  for (const line of diff.split('\n')) {
    if (!line) continue;
    const header = HUNK.exec(line);
    if (header) { close(); hunk = { line: Number(header[2]), removed: [], added: [] }; continue; }
    if (METADATA.test(line)) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      if (!hunk) { findings.push(`${file} diff has a changed line outside any hunk, which this check cannot place: ${line.slice(0, 80)}`); continue; }
      const body = line.slice(1);
      if (!carriesPermitted(body, descriptor))
        findings.push(`${file}:${hunk.line} changes a line that carries no digest${descriptor ? ` or ${DESCRIPTOR_FIELDS.slice(1).join('/')} value` : ''}: ${line.slice(0, 120)}`);
      (line.startsWith('+') ? hunk.added : hunk.removed).push(body);
      continue;
    }
    if (line.startsWith(' ')) continue; // context, which -U0 should not produce
    findings.push(`${file} diff carries a change this check does not recognise and will not wave through: ${line.slice(0, 120)}`);
  }
  close();
  return findings;
}
