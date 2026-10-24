/**
 * The full-screen issue's property column, as data — the rows `IssueProperties` draws, in
 * the order `v9-2-issue-detail-light.svg` prints them: Status, Assignee, Runner, Model,
 * Milestone, Estimate, Due, Blocked by.
 *
 * Each row is a label, the value as it reads at rest, and — when the field can be changed
 * from here — which editor a click on the value swaps in. **A row with no value and no
 * editor is left out**: the column never prints a placeholder for data this card does not
 * have (Runner until F20.12 supplies one; Estimate and Due, which are only ever read here
 * until F21.10 makes them editable, while they are unset). A row with an editor stays even
 * when empty, reading "None"/"Unassigned", because that empty value is the thing to click.
 *
 * Pure and DOM-free so the order, the omission rules and the Blocked-by derivation are
 * asserted without mounting anything (`issuePropertyRows.test.ts`).
 */
import type { Milestone, Person, Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { restingStatus } from '@tm/shared/board';
import { isNativeTicket } from '@tm/shared/tickets';
import { STATUS_LABEL } from '../taskStatus';

/** The fields a click can edit in place — each names an editor the column already has. */
export type PropertyEditor = 'status' | 'assignee' | 'model' | 'milestone';

export type PropertyKey =
  'status' | 'assignee' | 'runner' | 'model' | 'milestone' | 'estimate' | 'due' | 'blockedBy';

/** One card a Blocked-by row names — drawn as `KEY title`, opening that card. */
export interface BlockingCard {
  taskId: string;
  key: string | null;
  title: string;
}

export interface PropertyRow {
  key: PropertyKey;
  label: string;
  /** How the value reads at rest; `null` only for Blocked by, whose value is `blockedBy`. */
  value: string | null;
  /** Set when a click on the value swaps in an editor; absent for a read-only row. */
  editor?: PropertyEditor;
  /** Blocked by's cards, in link order. */
  blockedBy?: BlockingCard[];
}

export interface IssuePropertiesInput {
  task: Task;
  /** App-wide roster — the assignee's name. */
  people: readonly Person[];
  /** This project's milestones — the milestone's name. */
  milestones: readonly Milestone[];
  /** The delegated agent project's name, when the ticket is delegated to one. */
  agentName?: string;
  /** How the card's model reads (`cardModelCaption`), already composed by the caller. */
  modelCaption: string;
  /** The board's chain links and task index — Blocked by is read from them. */
  chainLinks: readonly TaskLink[];
  chainTasksById: ReadonlyMap<string, Task>;
  /** The machine running the card — F20.12; absent until then, so the row is never drawn. */
  runner?: string | null;
  /** The host is unreachable: every row reads, none edits. */
  readOnly?: boolean;
}

/** `Oct 17, 2026` — the mockup's due date. Local time: a due date is stored as local midnight. */
export function formatDue(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The cards this one waits on to MERGE — the `after-merge` links pointing INTO it. A stacked
 * link is not a block (the card starts on its parent's branch at once), and a link to a card
 * the index no longer holds is dropped rather than printed as a bare id.
 */
export function blockingCards(
  taskId: string,
  chainLinks: readonly TaskLink[],
  chainTasksById: ReadonlyMap<string, Task>,
): BlockingCard[] {
  const out: BlockingCard[] = [];
  for (const link of chainLinks) {
    if (link.toTaskId !== taskId || link.gate !== 'after-merge') continue;
    const from = chainTasksById.get(link.fromTaskId);
    if (!from) continue;
    out.push({
      taskId: from.id,
      key: from.ticketKey ?? from.externalKey ?? null,
      title: from.title,
    });
  }
  return out;
}

export function issuePropertyRows(input: IssuePropertiesInput): PropertyRow[] {
  const { task, readOnly = false } = input;
  // A ticket field is edited only on a native ticket — the same rule the Ticket fold has
  // always followed; a mirrored issue's fields belong to its tracker.
  const ticketEditable = !readOnly && isNativeTicket(task);
  const editable = !readOnly;

  const person = input.people.find((p) => p.id === task.assigneeId)?.name;
  const assignee =
    [person, input.agentName].filter(Boolean).join(' / ') || (ticketEditable ? 'Unassigned' : null);
  const milestone =
    input.milestones.find((m) => m.id === task.milestoneId)?.name ??
    (ticketEditable ? 'None' : null);
  const blockedBy = blockingCards(task.id, input.chainLinks, input.chainTasksById);

  const rows: (PropertyRow | null)[] = [
    {
      key: 'status',
      label: 'Status',
      value: STATUS_LABEL[restingStatus(task)],
      editor: editable ? 'status' : undefined,
    },
    {
      key: 'assignee',
      label: 'Assignee',
      value: assignee,
      editor: ticketEditable ? 'assignee' : undefined,
    },
    { key: 'runner', label: 'Runner', value: input.runner ?? null },
    {
      key: 'model',
      label: 'Model',
      value: input.modelCaption,
      editor: editable ? 'model' : undefined,
    },
    {
      key: 'milestone',
      label: 'Milestone',
      value: milestone,
      editor: ticketEditable ? 'milestone' : undefined,
    },
    {
      key: 'estimate',
      label: 'Estimate',
      value:
        task.estimateDays == null
          ? null
          : `${task.estimateDays} day${task.estimateDays === 1 ? '' : 's'}`,
    },
    { key: 'due', label: 'Due', value: task.dueAt == null ? null : formatDue(task.dueAt) },
    blockedBy.length > 0 ? { key: 'blockedBy', label: 'Blocked by', value: null, blockedBy } : null,
  ];

  return rows.filter(
    (row): row is PropertyRow =>
      row !== null &&
      (row.value !== null || row.editor !== undefined || row.blockedBy !== undefined),
  );
}

/** What can happen to the row being edited. */
export type PropertyEditEvent =
  | { type: 'open'; editor: PropertyEditor }
  /** Saved, Esc, blur, or the editor's list closed — back to the read-only look. */
  | { type: 'close' };

/**
 * Which row is showing its editor: at most one, so opening a second closes the first. A
 * read-only column never opens one, whatever is clicked.
 */
export function nextEditing(
  current: PropertyEditor | null,
  event: PropertyEditEvent,
  readOnly = false,
): PropertyEditor | null {
  if (event.type === 'close') return null;
  return readOnly ? current : event.editor;
}
