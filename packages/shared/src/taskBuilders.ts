/**
 * The object-construction half of creating a task (Phase 25 — cloud web independence).
 *
 * Pure — no DB, no transaction — because both the desktop store and, eventually, the
 * server's own write endpoints build the exact same {@link Task} shape and must never
 * drift apart on a default. The caller still owns everything DB-shaped: validating the
 * project, allocating `order` and (for a ticket) the next `ticketNumber`, and the insert
 * itself. This module only decides what the row looks like once those are known.
 */
import type { Task, TaskType, TicketInput } from './model';
import { formatTicketKey } from './ticketKey';
import { normalizeLabels } from './tickets';

/** The fields `createTask` (ad-hoc) accepts, minus the project id and title — the
 *  caller trims and validates the title before calling, same as before. */
export interface AdhocTaskFields {
  phase?: string;
  type?: TaskType | null;
  description?: string | null;
  projectTagId?: string | null;
}

/**
 * Build an ad-hoc task: appended after existing tasks, `source: 'adhoc'`.
 *
 * `title` must already be trimmed and non-empty — the caller (`createTask`) is the one
 * that refuses a blank title, since that refusal must cost nothing and this function
 * always returns a `Task`. `order` is the caller's `nextOrder` read for the project.
 */
export function buildAdhocTask(
  projectId: string,
  order: number,
  title: string,
  input: AdhocTaskFields,
): Task {
  return {
    id: crypto.randomUUID(),
    projectId,
    phase: input.phase?.trim() || '',
    title,
    status: 'pending',
    sessionId: null,
    order,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    type: input.type ?? null,
    // The card's own brief, in the field every other surface reads a card's
    // description from — see `TicketInput.description`.
    externalDescription: input.description?.trim() || null,
    projectTagId: input.projectTagId ?? null,
  };
}

/**
 * Build a native ticket: `source: 'ticket'`, keyed and typed.
 *
 * `title` must already be trimmed and non-empty, and `prefix`/`ticketNumber` must
 * already be allocated — both refusals and the allocation happen in the caller
 * (`createTicketTx`) BEFORE any of this runs, so a refused create never burns a ticket
 * number. `order` is the caller's `nextOrder` read for the project.
 */
export function buildTicketTask(
  projectId: string,
  order: number,
  prefix: string,
  ticketNumber: number,
  title: string,
  input: TicketInput,
): Task {
  return {
    id: crypto.randomUUID(),
    projectId,
    phase: input.phase?.trim() ?? '',
    title,
    status: 'pending',
    sessionId: null,
    order,
    source: 'ticket',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    // The card's brief goes where every other surface already reads one from
    // (`Task.description` is a step's brief, which a ticket is not).
    externalDescription: input.description?.trim() || null,
    // Native tickets reuse the priority column JIRA cards use — see `TicketInput.priority`.
    externalPriority: input.priority?.trim() || null,
    ticketKey: formatTicketKey(prefix, ticketNumber),
    ticketNumber,
    issueType: input.issueType ?? 'task',
    epicTaskId: input.epicTaskId ?? null,
    milestoneId: input.milestoneId ?? null,
    labels: normalizeLabels(input.labels),
    storyPoints: input.storyPoints ?? null,
    estimateDays: input.estimateDays ?? null,
    startAt: input.startAt ?? null,
    dueAt: input.dueAt ?? null,
    assigneeId: input.assigneeId ?? null,
    reporterId: input.reporterId ?? null,
  };
}
