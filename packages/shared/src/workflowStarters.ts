/**
 * The two workflows a fresh install ships with, so a `WorkflowDoc` (`@shared/workflow`)
 * isn't something you only ever meet by building one from scratch. Both are plain data —
 * no `model`/`mode`/`skillRefs` on either agent step — so a step's run follows the
 * project's/card's own ladder (`@shared/model`) exactly as if a human had typed the brief
 * in by hand.
 *
 * `packages/shared` only *describes* the two starters; seeding them into a fresh desktop's
 * workflow store is a later step's job, keyed on these same ids so a reseed is a no-op.
 */
import type { WorkflowDoc } from './workflow';

/** "Implement the change" → "Run the tests", retrying the implementation on a red run. */
export const STARTER_IMPLEMENT_TEST_WORKFLOW_ID = 'starter-implement-test';

/** "Implement the change" → "Review the change" → "Run the tests", retrying from the
 *  implementation (not the review) on a red run — a reviewer that already saw a passing
 *  run has nothing left to add once the tests go red again. */
export const STARTER_IMPLEMENT_REVIEW_TEST_WORKFLOW_ID = 'starter-implement-review-test';

const IMPLEMENT_BRIEF =
  'Implement the change described in this card. Add or update the tests that cover ' +
  'it, then commit the result.';

/** Both starters end in this same gate — a fresh object per call, so the two
 *  `WorkflowDoc`s below never alias each other's step. */
function testGate(): WorkflowDoc['steps'][number] {
  return {
    id: 'test',
    kind: 'gate',
    title: 'Run the tests',
    command: 'npm test',
    onFail: { retryFrom: 'implement', maxAttempts: 3 },
  };
}

/** The two starters a fresh install ships with, in no particular order — `id` is what a
 *  seeder keys on, not array position. */
export const STARTER_WORKFLOWS: readonly WorkflowDoc[] = [
  {
    version: 1,
    id: STARTER_IMPLEMENT_TEST_WORKFLOW_ID,
    name: 'Implement + test gate',
    steps: [
      {
        id: 'implement',
        kind: 'agent',
        title: 'Implement the change',
        brief: IMPLEMENT_BRIEF,
      },
      testGate(),
    ],
  },
  {
    version: 1,
    id: STARTER_IMPLEMENT_REVIEW_TEST_WORKFLOW_ID,
    name: 'Implement → review → test gate',
    steps: [
      {
        id: 'implement',
        kind: 'agent',
        title: 'Implement the change',
        brief: IMPLEMENT_BRIEF,
      },
      {
        id: 'review',
        kind: 'agent',
        title: 'Review the change',
        brief:
          "Review the branch's diff against its base as a reviewer, not as the author. " +
          'Fix real defects you find, then commit the result. Do not restate an earlier ' +
          "step's work as done as if it were your own.",
      },
      testGate(),
    ],
  },
];
