export const DISCLOSURE = 'Sources reverified; original host landing record unavailable.';
export const EDITION = '2026-10-27';
export const COMMIT = 'a1b2c3d4'.repeat(5), REVISION = 'e'.repeat(64);
export function proofFor(staged) {
  return {
    version: 'clank.reverified-corpus-publication.v1', edition: EDITION, disclosure: DISCLOSURE,
    composition_digest: staged.receipt.composition_digest, artifact_digest: staged.receipt.artifact_digest,
    audit: {
      latest_stage: { edition: EDITION, receipt: { ...staged.receipt, state: 'staged', edition: EDITION }, claim: { commit: COMMIT, tree: `trees/${REVISION}` } },
      kind: 'read-only-historical-corpus-content-audit', success: true, content_match: true, all_metadata_equal: true, trusted_manifest_unchanged: true,
      started_at: '2026-10-28T00:00:00Z', finished_at: '2026-10-28T00:00:01Z',
      compiler: { version: '0.1.31', module_sha256: { 'feedSource.js': '1'.repeat(64), 'feedLayout.js': '2'.repeat(64), 'feedManifest.js': '3'.repeat(64) } },
      input: { requested_commit: COMMIT, resolved_commit: COMMIT, paths: [EDITION], selected_git_tree: '4'.repeat(40), resolved_revision: REVISION, expected_retained_revision: REVISION },
      trusted_manifest: { uid: 0, mode: '600', regular: true, directory: false, symlink: false, tree: REVISION, sha256: '5'.repeat(64), declared_files: 2, entries: 3, entry_counts: { d: 1, f: 2 } },
      archive_comparison: { changed: [], extra: [], missing: [], touched: [], drift: [], checked_entries: 3 },
      retained_tree_comparison: { changed: [], extra: [], missing: [], touched: [], drift: [], checked_entries: 3 },
      original_fetch_ref: null, original_landing_timestamp: null,
    },
  };
}
