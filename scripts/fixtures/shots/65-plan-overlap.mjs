/**
 * One Inbox `plan-approval` item whose plan overlaps a running card's files — see
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 */
import { INBOX_PLAN_ITEM } from './60-plan-check.mjs';

/**
 * The same item as `inbox-plan-check-light`, with `planCheck.overlaps` naming the one
 * running card its failing `critical-files` check already reports — the shape `checkPlan`
 * (`@tm/shared/planCheck`) produces for a real overlap. Built by hand for the same reason as
 * that row's verdict: the Inbox only reads the stored `AttentionItem.planCheck`.
 */
export const INBOX_PLAN_OVERLAP_ITEM = {
  ...INBOX_PLAN_ITEM,
  id: 'att-plan-overlap-1',
  runId: 'run-plan-overlap-1',
  planCheck: {
    ...INBOX_PLAN_ITEM.planCheck,
    overlaps: [
      {
        title: 'Fix the export dialog',
        key: 'FX-12',
        why: 'running',
        files: ['apps/client/src/main/scheduler.ts'],
      },
    ],
  },
};

export const CHANNELS = {};
