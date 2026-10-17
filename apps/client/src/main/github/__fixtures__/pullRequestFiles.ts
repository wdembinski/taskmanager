/**
 * Trimmed, real-shaped `GET /repos/{owner}/{repo}/pulls/{number}/files` rows: a modified file
 * with a patch, a renamed file carrying `previous_filename`, a binary image with no `patch`,
 * and a removed file.
 */
import type { GitHubPullRequestFile } from '../githubClient';

export const pullRequestFilesPage1: GitHubPullRequestFile[] = [
  {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    filename: 'src/app.ts',
    status: 'modified',
    additions: 4,
    deletions: 1,
    changes: 5,
    patch:
      '@@ -10,7 +10,10 @@ export function start() {\n-  return legacyBoot();\n+  return boot();\n',
  },
  {
    sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567a1',
    filename: 'src/utils/format.ts',
    status: 'renamed',
    additions: 0,
    deletions: 0,
    changes: 0,
    previous_filename: 'src/format.ts',
  },
];

export const pullRequestFilesPage2: GitHubPullRequestFile[] = [
  {
    sha: 'c3d4e5f60718293a4b5c6d7e8f901234567a1b2',
    filename: 'assets/logo.png',
    status: 'modified',
    additions: 0,
    deletions: 0,
    changes: 0,
  },
  {
    sha: 'd4e5f60718293a4b5c6d7e8f901234567a1b2c3',
    filename: 'docs/old-notes.md',
    status: 'removed',
    additions: 0,
    deletions: 42,
    changes: 42,
    patch: '@@ -1,3 +0,0 @@\n-old notes\n',
  },
];
