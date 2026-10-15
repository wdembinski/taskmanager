/**
 * Variants (F10) — the pure half: what rows a ×N start creates, whether a card may start
 * one, and what the leader shows while its rows run.
 *
 * The human's card stays the **leader** and never runs itself. A ×2/×3 start creates N
 * hidden rows, one per variant, each with its own id — so its own worktree, branch and
 * session, and `RunRefusal 'already-running'` keeps meaning exactly what it means today:
 * one agent per worktree, per row. Nothing here touches a DB, a worktree or the scheduler;
 * the engine (`task:startVariants`) turns the drafts into rows and enqueues them through
 * the normal path, so concurrency and both gates apply unchanged.
 *
 * The leader's `status` is the human's (memory *card-state-is-the-humans*) and is never an
 * input to, nor an output of, anything in this file. The group's run state is *derived*
 * from its rows, for display only.
 */
import type { TaskAttachment } from './attachments';
import { isBoardCard, isRunStatus } from './board';
import type { AssignAgentInput, Task, TaskStatus } from './model';
import { RUN_REFUSAL_MESSAGE, type RunRefusal } from './scheduler';
import type { SessionEvent } from './session';

/** How many variants one start may create. ×1 is not a variant group — it is Assign agent. */
export type VariantCount = 2 | 3;

/** A variant row's letter — the column it gets in the compare view. */
export type VariantLabel = 'A' | 'B' | 'C';

/** Labels in the order rows are created and shown. */
export const VARIANT_LABELS: readonly VariantLabel[] = ['A', 'B', 'C'];

/**
 * The variant fields a task may carry. Structural rather than read off `Task` so this
 * module compiles on its own; the same names and types are what the store persists.
 */
export interface VariantFields {
  /** The leader's id on a variant row; null/absent on every other task. */
  variantOf?: string | null;
  /** The row's letter; null/absent on every other task. */
  variantLabel?: VariantLabel | null;
}

/**
 * The fixed diversification hint appended to a row's brief. A gets none — it is the plain
 * card — and B and C are nudged apart, because identical prompts on the same model tend to
 * converge on the same answer (F10 open question 2; revisit after the live check in F10.7).
 */
export const VARIANT_HINTS: Readonly<Record<VariantLabel, string | null>> = {
  A: null,
  B:
    'You are one of several independent attempts at this task. Deliberately take a ' +
    'different approach from the most obvious one, and prefer the simplest change that ' +
    'fully solves it.',
  C:
    'You are one of several independent attempts at this task. Deliberately take a ' +
    'different approach from the most obvious one, and favour a more thorough solution ' +
    'with stronger tests.',
};

/**
 * Why a card cannot start variants. The four run-start refusals it shares with
 * {@link RunRefusal} keep their names and their sentences; the other two are about what a
 * variant group is allowed to hang off.
 */
export type VariantRefusal =
  | Extract<RunRefusal, 'unknown-task' | 'already-running' | 'no-project'>
  /** A step of a chain runs in its parent's worktree, in sequence — variants are out of scope. */
  | 'is-step'
  /** A plan-project task, or a row that is itself a variant: only a board card leads a group. */
  | 'not-a-card';

/** One sentence per refusal, in the voice of {@link RUN_REFUSAL_MESSAGE}. */
export const VARIANT_REFUSAL_MESSAGE: Record<VariantRefusal, string> = {
  'unknown-task': RUN_REFUSAL_MESSAGE['unknown-task'],
  'already-running': RUN_REFUSAL_MESSAGE['already-running'],
  'no-project': RUN_REFUSAL_MESSAGE['no-project'],
  'is-step': 'Variants run a whole card, not a step of one — start them on the parent card.',
  'not-a-card': 'Only a card on your board can run variants.',
};

/** The leader shape the checks read. */
export type VariantLeader = Pick<
  Task,
  | 'id'
  | 'projectId'
  | 'source'
  | 'status'
  | 'parentTaskId'
  | 'archivedAt'
  | 'agentProjectId'
  | 'title'
  | 'description'
  | 'agentMode'
  | 'agentModel'
  | 'agentPlanningModel'
> &
  VariantFields;

/**
 * Whether `leader` may start a variant group, or the refusal saying why not.
 *
 * `input` is the Assign agent dialog's choice: a card not yet delegated passes when the
 * dialog names an agent project, exactly as Assign agent itself would.
 */
export function canStartVariants(
  leader: VariantLeader | null | undefined,
  input?: Pick<AssignAgentInput, 'agentProjectId'>,
): { ok: true } | { refused: VariantRefusal } {
  if (!leader || leader.archivedAt) return { refused: 'unknown-task' };
  if (leader.parentTaskId) return { refused: 'is-step' };
  if (leader.variantOf || !isBoardCard(leader as Task)) return { refused: 'not-a-card' };
  if (isRunStatus(leader.status)) return { refused: 'already-running' };
  if (!(input?.agentProjectId || leader.agentProjectId)) return { refused: 'no-project' };
  return { ok: true };
}

/**
 * Everything the engine needs to create one variant row. Agent settings are resolved
 * here (the dialog's choice over the leader's own), so every row of a group runs on the
 * same project, mode and models — only the hint differs.
 */
export interface VariantRowDraft {
  variantOf: string;
  variantLabel: VariantLabel;
  title: string;
  /** The leader's description, with the row's hint appended for B and C. */
  description: string | null;
  /** The hint appended, or null for A — kept separately so the UI can show it plainly. */
  hint: string | null;
  agentProjectId: string;
  agentMode: Task['agentMode'];
  agentModel: Task['agentModel'];
  agentPlanningModel: Task['agentPlanningModel'];
  /** The dialog's brief, recorded on each row's timeline as Assign agent does. */
  notes: string | null;
  /** The leader's attachments to copy onto this row (by name — the bytes are the engine's). */
  attachmentNames: string[];
}

/** Joins the leader's description and a hint, without leaving a dangling blank paragraph. */
function withHint(description: string | null | undefined, hint: string | null): string | null {
  const base = description?.trim() ? description : null;
  if (!hint) return base ?? null;
  return base ? `${base}\n\n${hint}` : hint;
}

/**
 * The N row drafts for a ×N start: labelled A…, copying the leader's title, description,
 * attachments and agent settings, with the fixed hint for B and C.
 *
 * Pure — it does not decide whether the start is allowed; call {@link canStartVariants}
 * first. Throws on a count outside 2–3 or with no agent project anywhere, since either
 * means a caller skipped that check.
 */
export function planVariants(
  leader: VariantLeader,
  count: VariantCount,
  input: AssignAgentInput,
  attachments: readonly Pick<TaskAttachment, 'name'>[] = [],
): VariantRowDraft[] {
  if (count !== 2 && count !== 3) throw new Error(`variant count must be 2 or 3, got ${count}`);
  const agentProjectId = input.agentProjectId || leader.agentProjectId;
  if (!agentProjectId) throw new Error(VARIANT_REFUSAL_MESSAGE['no-project']);
  const notes = input.notes?.trim() ? input.notes : null;
  return VARIANT_LABELS.slice(0, count).map((label) => {
    const hint = VARIANT_HINTS[label];
    return {
      variantOf: leader.id,
      variantLabel: label,
      title: leader.title,
      description: withHint(leader.description, hint),
      hint,
      agentProjectId,
      agentMode: input.mode ?? leader.agentMode ?? null,
      agentModel: input.model ?? leader.agentModel ?? null,
      agentPlanningModel: input.planningModel ?? leader.agentPlanningModel ?? null,
      notes,
      attachmentNames: attachments.map((a) => a.name),
    };
  });
}

/**
 * The leader's derived run state, in priority order:
 *
 * - `none` — no live rows: not a variant group (or every row was discarded).
 * - `waiting` — some row waits for the human (input, a permission, a plan approval).
 * - `running` — some row has a run in flight, including one parked behind a limit.
 * - `queued` — nothing in flight, but some row has not run yet.
 * - `done` — every row settled and at least one finished.
 * - `failed` — every row settled, none finished, at least one failed.
 * - `stopped` — every row settled by a human stopping or cancelling it.
 */
export type VariantGroupRunState =
  'none' | 'waiting' | 'running' | 'queued' | 'done' | 'failed' | 'stopped';

export interface VariantGroupState {
  state: VariantGroupRunState;
  /** The group's live rows in label order — what the leader tile's status strip draws. */
  rows: { id: string; label: VariantLabel | null; status: TaskStatus }[];
}

const SETTLED: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'stopped', 'cancelled']);

/**
 * What the leader shows while its variants run, derived from the rows alone.
 *
 * Takes the leader only for its id. Its `status` is never read and never returned: the
 * leader's column is the human's, and this is a display of the rows, not a write to the
 * card. Rows of other leaders and archived (discarded) rows are ignored.
 */
export function variantGroupState(
  leader: Pick<Task, 'id'>,
  rows: readonly (Pick<Task, 'id' | 'status' | 'archivedAt'> & VariantFields)[],
): VariantGroupState {
  const mine = rows
    .filter((r) => r.variantOf === leader.id && !r.archivedAt)
    .map((r) => ({ id: r.id, label: r.variantLabel ?? null, status: r.status }))
    .sort((a, b) => (a.label ?? '~').localeCompare(b.label ?? '~'));
  const has = (s: TaskStatus) => mine.some((r) => r.status === s);
  let state: VariantGroupRunState;
  if (mine.length === 0) state = 'none';
  else if (has('waiting-input')) state = 'waiting';
  else if (mine.some((r) => isRunStatus(r.status))) state = 'running';
  else if (mine.some((r) => !SETTLED.has(r.status))) state = 'queued';
  else if (has('done')) state = 'done';
  else if (has('failed')) state = 'failed';
  else state = 'stopped';
  return { state, rows: mine };
}

/**
 * The variant summary channel (F10.4) — one row per variant for the compare view: its
 * cost, diff stat and a one-line gist of what it did. Pure helpers only; `variants:summary`
 * assembles them with the task store and `DiffService` (`apps/client/src/main/variantSummary.ts`).
 */

/** One variant's diff against base: files touched and total lines added/removed. */
export interface VariantDiffStat {
  files: number;
  added: number;
  removed: number;
}

/** One row of the compare view. */
export interface VariantSummaryRow {
  id: string;
  label: VariantLabel | null;
  status: TaskStatus;
  /** Sum of the row's runs' costs; null when none ever reported one — never a fake 0. */
  costUsd: number | null;
  diffStat: VariantDiffStat;
  /** First non-empty line of the row's last result, capped at `VARIANT_SUMMARY_MAX_CHARS`. */
  summary: string;
}

/** Caps `variantSummaryLine` so the payload stays bounded no matter what the agent wrote. */
export const VARIANT_SUMMARY_MAX_CHARS = 200;

/**
 * The compare view's one-line gist of a result: its first non-empty line, whitespace
 * collapsed, a leading markdown heading/bullet/numbered-list marker stripped, and capped
 * at `VARIANT_SUMMARY_MAX_CHARS` with a trailing `…`. `''` when there is no non-empty line.
 */
export function variantSummaryLine(resultText: string): string {
  const line = resultText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  const collapsed = line
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .trim()
    .replace(/\s+/g, ' ');
  return collapsed.length > VARIANT_SUMMARY_MAX_CHARS
    ? `${collapsed.slice(0, VARIANT_SUMMARY_MAX_CHARS)}…`
    : collapsed;
}

/**
 * Sum of non-null `costUsd` across a row's `result` events — a retried row has several
 * runs, each its own session, so its cost is the total of every one. `null` when none
 * carried a cost, never a fake 0.
 */
export function variantCost(history: readonly SessionEvent[]): number | null {
  const costs = history
    .filter((e): e is Extract<SessionEvent, { kind: 'result' }> => e.kind === 'result')
    .map((e) => e.costUsd)
    .filter((c): c is number => c != null);
  return costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null;
}

/**
 * A row's diff stat from its diff entries: file count and the sum of additions/deletions.
 * Structural over the entry shape (not `NameStatusEntry` itself) so this stays a pure
 * function of plain numbers — a binary entry already reports 0/0, same as everywhere else.
 */
export function diffStatOf(
  entries: readonly { additions: number; deletions: number }[],
): VariantDiffStat {
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    added += entry.additions;
    removed += entry.deletions;
  }
  return { files: entries.length, added, removed };
}

/**
 * Sorts variant rows by label (A, B, C), unlabelled last — the compare view's column order.
 * Ranked by position in {@link VARIANT_LABELS} rather than `localeCompare`: locale collation
 * treats a punctuation placeholder as sorting BEFORE letters, not after, which would put
 * unlabelled rows first instead of last.
 */
export function sortVariantRows<T extends { label: VariantLabel | null }>(rows: readonly T[]): T[] {
  const rank = (label: VariantLabel | null) =>
    label === null ? VARIANT_LABELS.length : VARIANT_LABELS.indexOf(label);
  return [...rows].sort((a, b) => rank(a.label) - rank(b.label));
}

/**
 * The pick (F10.6) — once a leader keeps one variant, that row's branch and worktree ARE
 * the card's own work from then on. Pure rules only: `variantWorkOwner` resolves "whose
 * work is this card's" (including through a step's chain); `planVariantPick` decides what
 * a `variants:pick` call does, before the engine (`task:pickVariant`, under
 * `apps/client/src/main`) ever stops a run, removes a worktree or writes anything.
 */

/** Shown wherever a leader's own work is asked for before anything has been picked. */
export const PICK_VARIANT_FIRST =
  "Pick a variant first — this card's work lives in its variants until you keep one.";

/**
 * Why a `variants:pick` call did nothing. The leader or the named row is gone or not a
 * variant of this leader, or the leader already picked — once, which `planVariantPick`
 * tells apart from a same-id re-pick (a no-op, not a refusal).
 */
export type VariantPickRefusal =
  'unknown-task' | 'not-a-variant' | 'already-picked' | 'already-merged';

/** One sentence per {@link VariantPickRefusal}, in the voice of {@link VARIANT_REFUSAL_MESSAGE}. */
export const VARIANT_PICK_REFUSAL_MESSAGE: Record<VariantPickRefusal, string> = {
  'unknown-task': RUN_REFUSAL_MESSAGE['unknown-task'],
  'not-a-variant':
    "That isn't one of this card's current variants — it may already be discarded, or belong " +
    'to a different card.',
  'already-picked':
    'This card already picked a variant and discarded the others — there is nothing left to ' +
    'switch to.',
  'already-merged':
    "This card's picked variant already merged — picking a different one now would abandon " +
    'that work.',
};

/** The leader fields {@link planVariantPick} reads. */
export type VariantPickLeader = Pick<Task, 'id' | 'archivedAt' | 'pickedVariantId' | 'landedAt'>;

/**
 * What a `variants:pick(leader, variantId)` call does, before the engine touches a
 * worktree: a no-op, a refusal, or the winning row plus the live rows it beats.
 *
 * `rows` is the leader's LIVE rows (not archived, `variantOf === leader.id`) — the same
 * shape `variantGroupState` reads. The same-id check runs before the rows lookup, so
 * re-picking the current winner is a no-op even once that row has dropped out of `rows`
 * (e.g. the caller only queries unsettled rows by then, well after the merge) — "same-id
 * re-pick is a noop even after merge".
 */
export function planVariantPick<T extends Pick<Task, 'id'> & VariantFields>(
  leader: VariantPickLeader | null | undefined,
  rows: readonly T[],
  variantId: string,
): { noop: true } | { refused: VariantPickRefusal } | { winner: T; losers: T[] } {
  if (!leader || leader.archivedAt) return { refused: 'unknown-task' };
  if (leader.pickedVariantId === variantId) return { noop: true };
  if (leader.pickedVariantId) {
    return { refused: leader.landedAt != null ? 'already-merged' : 'already-picked' };
  }
  const winner = rows.find((r) => r.id === variantId && r.variantOf === leader.id);
  if (!winner) return { refused: 'not-a-variant' };
  const losers = rows.filter((r) => r.variantOf === leader.id && r.id !== variantId);
  return { winner, losers };
}

/**
 * "Picked B of 3 — discarded A, C." for the pick's one timeline note — derived from the
 * winner's label and the group's size alone, since the discarded labels are exactly
 * {@link VARIANT_LABELS} up to `total`, minus the winner's own.
 */
export function pickNote(winner: Pick<VariantFields, 'variantLabel'>, total: number): string {
  const label = winner.variantLabel ?? '?';
  const discarded = VARIANT_LABELS.slice(0, total).filter((l) => l !== winner.variantLabel);
  return discarded.length > 0
    ? `Picked ${label} of ${total} — discarded ${discarded.join(', ')}.`
    : `Picked ${label} of ${total}.`;
}

/** The task fields {@link variantWorkOwner} reads, on both the task itself and its ancestors. */
export type VariantWorkOwnerTask = Pick<
  Task,
  'id' | 'parentTaskId' | 'variantOf' | 'pickedVariantId'
>;

/**
 * Where a card's own work actually lives: the id whose worktree/branch/project a merge, a
 * PR or auto-release should resolve through. `task` is whatever was asked about — the
 * card, or one of its steps; `rows` is every live variant row the caller knows of, since a
 * step's chain can run under a picked leader exactly as it runs under an ordinary card.
 *
 * In priority order:
 * - a step (`parentTaskId` set) resolves through its parent, recursively — the chain's
 *   worktree is the parent's, picked leader or not, same as a step's chain today;
 * - a leader that has picked resolves to the picked row's id, merged or not;
 * - a leader with live rows and no pick yet refuses with {@link PICK_VARIANT_FIRST} — there
 *   is no card work to point at until a human keeps one;
 * - anything else (an ordinary card, a variant row itself, a leader whose rows are all
 *   gone) owns its own work.
 *
 * Leaders are recognised by `pickedVariantId` or by having live rows in `rows` — never by
 * `source` or `status` — so a plain board card with neither reaches the last branch and
 * resolves to itself, exactly like today.
 */
export function variantWorkOwner(
  task: VariantWorkOwnerTask,
  rows: readonly (Pick<Task, 'id'> & VariantFields)[],
  getTask: (id: string) => VariantWorkOwnerTask | undefined,
): { ownerId: string } | { refused: string } {
  if (task.parentTaskId) {
    const parent = getTask(task.parentTaskId);
    return parent ? variantWorkOwner(parent, rows, getTask) : { ownerId: task.id };
  }
  if (task.pickedVariantId) return { ownerId: task.pickedVariantId };
  if (rows.some((r) => r.variantOf === task.id)) return { refused: PICK_VARIANT_FIRST };
  return { ownerId: task.id };
}
