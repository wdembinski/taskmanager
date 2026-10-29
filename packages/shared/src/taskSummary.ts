/**
 * The card summary (F29.2) — the light half of a {@link Task}, which is all a list ever draws.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A `Task` carries its plan, its ticket text and its step briefs. The board, the issue list,
 * the sidebar, the timeline and the graph read none of them, yet every action used to move
 * the whole board's worth of full rows twice — 27 MB on the 5,000-card fixture
 * (`docs/plan/feature-roadmap/F29-performance-at-scale.md`). A list now holds summaries; the
 * heavy text loads through `task:get` when a card opens.
 *
 * THE SIZE WIN IS THE MAPPER'S, NOT THE TYPE'S
 * --------------------------------------------
 * {@link TaskSummary} is a `Pick` of `Task`, so a full `Task` is still assignable to it — that
 * keeps the web's mirror rows and every test that passes a full task compiling. It also means
 * structural typing will never catch a full row sent where a summary is declared. Whatever
 * sends summaries must build them with {@link toTaskSummary}.
 *
 * Every `Task` key is in exactly one of the two lists below; the checks at the bottom fail the
 * typecheck when a new field is added to `Task` without being sorted into one of them. A list
 * component that needs a light field adds it to the summary; a heavy field is never added.
 */
import type { Task } from './model';

/** The fields a list draws or decides with — what a card summary carries. */
export const TASK_SUMMARY_KEYS = [
  // Identity and ordering.
  'id',
  'projectId',
  'title',
  'status',
  'phase',
  'type',
  'source',
  'order',
  'dependsOn',
  'parentTaskId',
  'isContract',
  'isScaffold',
  'planRound',
  // Variants.
  'variantOf',
  'variantLabel',
  'pickedVariantId',
  // Run state.
  'sessionId',
  'workedAt',
  'stoppedAt',
  'originAutomationId',
  'decisionQuestion',
  'decisionAskedAt',
  'workflowId',
  'gateAttempts',
  'statusNoteAt',
  'preBlockStatus',
  'preRunStatus',
  'landedAt',
  'chainLandedAt',
  // External tracker linkage.
  'externalSource',
  'externalKey',
  'externalId',
  'externalUrl',
  'externalStatus',
  'externalStatusCategory',
  'externalPriority',
  'externalType',
  'externalLabel',
  'externalSprint',
  'externalParentKey',
  'externalEpicName',
  'retainedSince',
  'pinnedImport',
  'archivedAt',
  'archivedReason',
  'trackerArchivedAt',
  'lastReadCommentAt',
  'latestCommentAt',
  // Filing and delegation.
  'projectTagId',
  'agentProjectId',
  'agentMode',
  'agentModel',
  'agentPlanningModel',
  'agentLeadModel',
  'agentReviewModel',
  'agentLeadEffort',
  'agentPlanningEffort',
  'agentEffort',
  'agentReviewEffort',
  'agentBranch',
  'autoRelease',
  'autoCreatePr',
  'autoIntegrate',
  // Native tickets.
  'ticketKey',
  'ticketNumber',
  'issueType',
  'epicTaskId',
  'milestoneId',
  'labels',
  'storyPoints',
  'estimateDays',
  'startAt',
  'dueAt',
  'assigneeId',
  'reporterId',
] as const satisfies ReadonlyArray<keyof Task>;

/** The heavy fields only an open card reads — loaded through `task:get`, never in a list. */
export const TASK_DETAIL_KEYS = [
  'agentPlan',
  'description',
  'externalDescription',
  'stepSpec',
  'plannedFiles',
  'skillRefs',
  'statusNote',
] as const satisfies ReadonlyArray<keyof Task>;

type SummaryKey = (typeof TASK_SUMMARY_KEYS)[number];
type DetailKey = (typeof TASK_DETAIL_KEYS)[number];

/** A card as a list holds it. See the file comment for why this is a `Pick`. */
export type TaskSummary = Pick<Task, SummaryKey>;

/**
 * What changed on one board since the last delta: the cards to insert or replace, and the
 * ids that left it. Carries summaries only — the open card re-reads its heavy half itself.
 */
export type TaskDelta = { projectId: string; upserted: TaskSummary[]; removed: string[] };

/** One card in full, as `task:get` returns it: the card, its parent (for a step) and its steps. */
export type TaskBundle = { task: Task; parent: Task | null; steps: Task[] };

// Compile-time checks: every `Task` key is sorted, and none is sorted twice.
type Assert<T extends true> = T;
export type _EveryTaskKeySorted = Assert<
  Exclude<keyof Task, SummaryKey | DetailKey> extends never ? true : false
>;
export type _SummaryAndDetailDisjoint = Assert<
  Extract<SummaryKey, DetailKey> extends never ? true : false
>;

/**
 * A card's summary: a copy of its summary keys only. A key the row leaves `undefined` is
 * omitted rather than written as `undefined`, so a summary is the same object whether it
 * went through JSON or not. Takes a summary too (a full `Task` is one), so re-summarising
 * a row that might be either is always safe.
 */
export function toTaskSummary(task: TaskSummary): TaskSummary {
  const out: Record<string, unknown> = {};
  for (const key of TASK_SUMMARY_KEYS) {
    const value = task[key];
    if (value !== undefined) out[key] = value;
  }
  return out as TaskSummary;
}

/**
 * Whether two summaries draw the same card: shallow equality over the summary keys, with the
 * array fields (`dependsOn`, `labels`) compared by element. Every summary field is a primitive
 * or an array of them, so this is exact.
 */
export function sameTaskSummary(a: TaskSummary, b: TaskSummary): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = (a as Record<string, unknown>)[key];
    const y = (b as Record<string, unknown>)[key];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
      continue;
    }
    return false;
  }
  return true;
}
