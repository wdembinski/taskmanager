/**
 * Turning a folder's git state into something the add/edit form can say.
 *
 * Split out of the dialogs (and out of main) because it is the part with the judgement in it:
 * WHICH states are worth interrupting someone over depends on whether the project runs in
 * isolated worktrees, and that rule should be stated once and testable rather than duplicated
 * in the plan dialog and the agent-project drawer with two slightly different wordings.
 *
 * The bar for `warning` is deliberately high — a form that cries wolf about every folder that
 * isn't a git repo teaches people to ignore it, and plenty of projects legitimately aren't
 * repos. Only a state that will actually break the FIRST RUN gets one.
 */
import type { GitPreflight } from './model';

/** How loudly the form should say it. Maps 1:1 onto Fluent's `Field.validationState`. */
export type GitNoteSeverity = 'warning' | 'success' | 'none';

export interface GitNote {
  severity: GitNoteSeverity;
  message?: string;
}

const QUIET: GitNote = { severity: 'none' };

/**
 * What the folder field should say about `pre`.
 *
 * `useWorktrees` is the whole hinge. With worktrees OFF, git state is simply not this
 * project's business — every state is quiet, because the task will run in the folder either
 * way. With worktrees ON:
 *   - `no-commits` is the one that used to produce `fatal: not a valid object name: ''` at run
 *     time. It is now auto-healed by an empty root commit, so this is a heads-up about a write
 *     we are about to make in their repo, not a blocker.
 *   - `not-a-repo` silently degrades to the shared folder — no isolation, no auto-merge —
 *     which is worth saying out loud, since the switch is on and will do nothing.
 *   - `missing` breaks the run whatever the switch says, so it is the one state that speaks up
 *     regardless.
 *   - `unknown` stays silent: git being unreachable from here says nothing reliable about the
 *     folder, and guessing would be the cry-wolf case.
 */
export function describeGitPreflight(pre: GitPreflight | null, useWorktrees: boolean): GitNote {
  if (!pre) return QUIET;
  if (pre.state === 'missing') {
    return {
      severity: 'warning',
      message: "That folder doesn't exist on the selected machine.",
    };
  }
  if (!useWorktrees) return QUIET;

  switch (pre.state) {
    case 'ready':
      return {
        severity: 'success',
        message: `Git repo on ${pre.branch ?? 'a detached HEAD'} — tasks will branch from it.`,
      };
    case 'no-commits':
      return {
        severity: 'warning',
        message:
          `This repo has no commits yet, so there is nothing for a task's branch to start ` +
          `from. The first run will add an empty "Initial commit" on ` +
          `${pre.branch ?? 'the current branch'} to start the history — no files of yours go ` +
          `into it. Commit something yourself first if you'd rather it didn't.`,
      };
    case 'not-a-repo':
      return {
        severity: 'warning',
        message:
          'Not a git repository, so "Isolated worktrees" will not engage — tasks will run ' +
          'directly in this folder and share it. Run `git init` there to get isolation.',
      };
    default:
      return QUIET;
  }
}
