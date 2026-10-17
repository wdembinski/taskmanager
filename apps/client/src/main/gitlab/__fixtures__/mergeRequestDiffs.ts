/**
 * Trimmed, real-shaped bodies for the two endpoints `listMergeRequestDiffs` can read from: a
 * `/diffs` page (15.7+, a modified file plus a renamed one with an empty `diff`), and a
 * `/changes` body (the legacy endpoint it falls back to), carrying `diff_refs`, an
 * `overflow` flag, and a `too_large` entry with no diff.
 */
import type { GitLabMergeRequestDiff } from '../gitlabClient';

export const mergeRequestDiffsPage1: GitLabMergeRequestDiff[] = [
  {
    old_path: 'src/app.ts',
    new_path: 'src/app.ts',
    diff: '@@ -10,7 +10,10 @@ export function start() {\n-  return legacyBoot();\n+  return boot();\n',
    a_mode: '100644',
    b_mode: '100644',
  },
  {
    old_path: 'src/format.ts',
    new_path: 'src/utils/format.ts',
    diff: '',
    renamed_file: true,
    a_mode: '100644',
    b_mode: '100644',
  },
];

export const mergeRequestChangesBody: {
  diff_refs: { base_sha: string; head_sha: string; start_sha: string };
  overflow: boolean;
  changes: GitLabMergeRequestDiff[];
} = {
  diff_refs: {
    base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    start_sha: 'cccccccccccccccccccccccccccccccccccccccc',
  },
  overflow: true,
  changes: [
    {
      old_path: 'assets/logo.png',
      new_path: 'assets/logo.png',
      diff: '',
      too_large: true,
    },
    {
      old_path: 'docs/old-notes.md',
      new_path: 'docs/old-notes.md',
      diff: '@@ -1,3 +0,0 @@\n-old notes\n',
      deleted_file: true,
      a_mode: '100644',
      b_mode: '0',
    },
  ],
};
