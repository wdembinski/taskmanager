/**
 * What an auto-release run is told.
 *
 * The orchestrator does not know how this repo releases — deliberately. The recipe lives
 * in the repo's own `RELEASE.md`, which is the file the agent is pointed at here; every
 * project answers "run the tests, bump, tag, publish" differently and the app has no
 * business having an opinion about it.
 *
 * So the prompt's whole job is the CONTEXT the file cannot carry: which card's work just
 * landed, which branch it landed on, and whether the directory the agent is standing in is
 * actually showing that branch. The last one matters more than it looks — a project that
 * names an integration branch it does not keep checked out is merged by moving the ref, so
 * the working tree in `project.path` can be sitting on something else entirely, and a
 * release cut from there would ship the wrong code.
 *
 * Pure — the caller reads the store, git and the disk, and passes plain values.
 */

/** What the release run needs to know about the merge that triggered it. */
export interface ReleaseContext {
  /** The card whose work landed, for the agent to name in its summary. */
  cardTitle: string;
  /** The branch that was merged (already deleted by integration — named for the record). */
  branch: string;
  /** The branch the work landed ON: what is being released. */
  base: string;
  /** The release instructions' path, relative to the project directory (`RELEASE.md`). */
  releaseDoc: string;
  /**
   * True when the merge only moved the `base` ref, so the checkout the agent is standing
   * in is NOT on `base`. The agent is told to fix that before doing anything else.
   */
  refMoveOnly?: boolean;
  /** The project's standing instructions, if it has any. */
  instructions?: string;
}

/**
 * The prompt for a release run, seeded onto the card's own session.
 *
 * It opens by saying the work is merged and this turn is the release, for the same reason
 * the chain hand-back does: an agent handed a summary of finished work will otherwise read
 * it as a brief and start building the thing again.
 */
export function buildReleasePrompt(ctx: ReleaseContext): string {
  const lines: string[] = [
    `The branch \`${ctx.branch}\` for “${ctx.cardTitle}” has just been merged into ` +
      `\`${ctx.base}\`. The code is written and landed — this turn is the RELEASE, nothing else.`,
    '',
    `Read \`${ctx.releaseDoc}\` in this repository and follow it exactly. It is the`,
    'authority on how this project is released; these instructions only tell you when and',
    'from what. Do not invent steps it does not name, and do not skip ones it does.',
    '',
  ];

  if (ctx.refMoveOnly) {
    lines.push(
      `**Before anything else:** this merge only moved the \`${ctx.base}\` ref — the working`,
      `tree you are in is checked out on a different branch, so what you can see is NOT what`,
      `landed. Check out \`${ctx.base}\` first. If that is not possible because the tree is`,
      `dirty, stop and ask rather than committing or stashing someone else's work.`,
      '',
    );
  } else {
    lines.push(
      `You are in the project's main checkout, which is on \`${ctx.base}\` with the merge`,
      'already in it. Confirm that with `git status`/`git log` before you release.',
      '',
    );
  }

  if (ctx.instructions?.trim()) {
    lines.push('Standing instructions for this project:', ctx.instructions.trim(), '');
  }

  lines.push(
    'Two rules that outrank anything convenience suggests:',
    '',
    `- If ${ctx.releaseDoc} has a verification gate (tests, typecheck, a build), a failing`,
    '  gate ENDS the release. Report what failed; do not tag or publish around it.',
    '- If a step needs a decision, a credential, or an approval you do not have, stop and',
    '  ask instead of guessing. A half-published release is worse than one that waited.',
    '',
    'When you are done, reply with what you released (the version, the tag, where it was',
    'published) or — if you stopped — exactly which step you stopped at and why.',
  );

  return lines.join('\n');
}
