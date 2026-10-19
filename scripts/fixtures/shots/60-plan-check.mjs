/**
 * One Inbox `plan-approval` item carrying a failing plan-check verdict — see
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 */
import { PROJECT_ID } from '../boardShotsFixture.mjs';
import { now } from '../shotsFixtureHelpers.mjs';

const PLAN_MARKDOWN = `Add command palette actions for every issue field.

## Critical files

- apps/client/src/main/scheduler.ts
- packages/ui/src/CommandPalette.tsx

## Open questions

None

## Acceptance

- Verified by: palette.render.test.tsx covers the new command
`;

/**
 * Four of the five checks pass; `critical-files` fails because this plan's own Critical
 * files section (above) names `apps/client/src/main/scheduler.ts`, which the fixture's
 * detail string reports as already claimed by a sibling card — `checkPlan`
 * (`@tm/shared/planCheck`) would produce this exact shape for a real overlap, but this row
 * builds the verdict by hand rather than running the function, since the Inbox only ever
 * reads the stored `AttentionItem.planCheck`, never recomputes it.
 */
const PLAN_VERDICT = {
  pass: false,
  checks: [
    { id: 'open-questions', label: 'No open question', pass: true, detail: 'no open questions' },
    {
      id: 'critical-files',
      label: 'Critical files listed, no overlap',
      pass: false,
      detail: 'overlaps "Fix the export dialog" (running): apps/client/src/main/scheduler.ts',
    },
    { id: 'step-count', label: 'At most 6 steps', pass: true, detail: '3 steps' },
    { id: 'spec-read', label: 'Spec read', pass: true, detail: 'the ticket names no spec' },
    {
      id: 'acceptance',
      label: 'Every step has agent-checkable acceptance',
      pass: true,
      detail: '3 steps checked',
    },
  ],
};

/**
 * Parked on fixture task `'1'` (`plainBacklog`, "Command palette actions for every issue
 * field") — an existing `TASKS` row, so this item's `taskTitle` is the real card's own
 * title rather than one invented just for this shot.
 */
export const INBOX_PLAN_ITEM = {
  id: 'att-plan-1',
  runId: 'run-plan-1',
  taskId: '1',
  projectId: PROJECT_ID,
  taskTitle: 'Command palette actions for every issue field',
  kind: 'plan-approval',
  prompt:
    'The agent finished planning and proposes 3 step(s). Approving runs them one at a time, ' +
    "each in its own session, on this card's branch.",
  options: [],
  toolName: null,
  reason: null,
  plan: PLAN_MARKDOWN,
  steps: [
    'Add the palette command for issue fields',
    'Wire the command to the issue list',
    'Add a render test for the new command',
  ],
  planCheck: PLAN_VERDICT,
  createdAt: now - 90_000,
};

export const CHANNELS = {};
