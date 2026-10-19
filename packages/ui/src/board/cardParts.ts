/**
 * The pure half of the v9 board card: which optional rows it draws, decided once so the
 * component itself only draws them. The same split `issueRowParts.ts` already keeps beside
 * `IssueRow`, and this module reuses that one's `runLabel`/`pickMergeRequest`/`dueParts`
 * rather than copying them — a card and a list row pick their one MR and their due date the
 * same way.
 *
 * Deliberately knows nothing about WHICH task's subtasks, merge requests, chain or live-run
 * ids these are — `CardPartsContext` carries exactly the slices this module needs, already
 * scoped to this card's task by the caller. No store, no IPC channel, no other card's data.
 */
import type { Person, Task, TaskStatus } from '@tm/shared/model';
import {
  cardRunLabel,
  isAgentAssigned,
  needsAgentInput,
  parkedStep,
  runPhase,
  type RunState,
} from '@tm/shared/board';
import {
  mrRef,
  mrVerdict,
  verdictSummary,
  type MergeRequest,
  type MrVerdict,
} from '@tm/shared/mergeRequest';
import { RUN_PURPOSE_LABEL, runPurposeOf, type RunPurpose } from '@tm/shared/scheduler';
import { assigneeDisplayParts, type AssigneeDisplayParts } from '../projects/assigneeParts';
import { dueParts, pickMergeRequest, runLabel } from '../issues/issueRowParts';
import { cardBadgeStatus, subtaskProgress } from './boardColumns';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import type { ChainPosition } from './chainPosition';

/** The short label a chip earns above the title; never a literal colour (see `CardStatusLine`). */
export type CardInk = 'cyan' | 'attention' | 'danger' | 'success' | 'faint';

export interface CardPartsContext {
  /** Epoch ms "now" — injected rather than read from `Date.now()`, for the same reason
   *  `IssueRowContext.now` is (testable due-date flagging). */
  now: number;
  /** This card's own steps (Phase 11), already scoped to it by the caller. See `runPhase`. */
  subtasks?: Task[];
  /** `scheduler:activeRuns`, already scoped. See `runPhase`. */
  liveRunTaskIds?: ReadonlySet<string>;
  /** `scheduler:integrating`, already scoped. See `runPhase`. */
  mergingTaskIds?: ReadonlySet<string>;
  /** This card's own merge requests, already scoped — `cardParts` does not re-run the
   *  key/branch matching a forge reconciler does. */
  mergeRequests?: MergeRequest[];
  /** The ticket's resolved human assignee, or undefined for none. */
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  /** The delegated agent's name, already decided meaningful by the caller (see
   *  `delegatedAgentName`) — this module does not re-derive that. */
  agentName?: string;
  /** Why the engine has an agent working this card, when it is a remediation rather than the
   *  card's own work (`ActiveRun.purpose`) — see `runPurposeOf`. */
  runPurposes?: ReadonlyMap<string, RunPurpose>;
  /** The epic/feature's resolved name, for the footer — see the render site in `TaskCard`'s
   *  own `epicName` prop for why this is a caller-resolved string rather than a lookup. */
  epicName?: string;
  /** Where this card sits in its chain (`chainPosition`), already scoped to it by the
   *  caller. The chain CHIP (named predecessors) moved to the F12 peek (F13.24); this is
   *  only the quiet "n of m" a card with nothing else to say can still carry. */
  chainPosition?: ChainPosition;
}

/**
 * The card's one status line, in the priority order the Board bullet's anatomy implies: a
 * live run outranks everything (it is the one thing actually moving), then whatever
 * `cardRunLabel` has to say about a non-moving run phase (waiting, paused, queued), then a
 * terminal status the column doesn't already say (`cardBadgeStatus`), then the one MR verdict
 * worth a line, and last the chain position a card with nothing else to show can still carry.
 */
export type CardStatusLine =
  | { kind: 'running'; label: string; ink: 'cyan' }
  | { kind: 'status'; label: string; ink: CardInk }
  | { kind: 'verdict'; label: string; ink: CardInk }
  | { kind: 'chain'; label: string; ink: 'faint' };

/** The footer's one trailing fact — the MR ref, else the due date, never both. */
export type CardTrailing =
  { kind: 'mr'; ref: string; url: string } | { kind: 'due'; label: string; flagged: boolean };

export interface CardParts {
  /** `ticketKey` for a native ticket, `externalKey` for a mirrored issue, else `''`. */
  key: string;
  /** The header's assignee glyph — absent for neither an assignee nor a delegated agent. */
  owner?: { avatar: AssigneeDisplayParts; running: boolean };
  statusLine?: CardStatusLine;
  /** Done/total steps — present only once the card actually has steps (`subtaskProgress`). */
  progress?: { done: number; total: number };
  /** A short epic/feature label, truncated — see `truncateLabel`. */
  epic?: string;
  trailing?: CardTrailing;
  /** The card's open owner decision (`Task.decisionQuestion`) — present only while one is
   *  open, so the "Needs decision" chip appears for exactly the cards Start refuses. A blank
   *  question never reaches the store (`task:setDecision` stores it as `null`). */
  decision?: { question: string };
}

/** `cardRunLabel`'s ink, once it has something to say: `needsAgentInput`/`parkedStep` decide
 *  whether it is a question (attention) or a failure (danger); a usage-limit pause is the
 *  harder stop `STATUS_COLOR['blocked-by-limit']` already calls `severe`, so it shares that
 *  ink; everything left (queued, "assigned — not started") is a resting fact, not a shout. */
function waitingInk(task: Task, subtasks: Task[], run: RunState): CardInk {
  if (needsAgentInput(task)) return 'attention';
  const parked = parkedStep(subtasks);
  if (parked) return parked.status === 'failed' ? 'danger' : 'attention';
  return run.phase === 'blocked' ? 'danger' : 'faint';
}

/** `cardBadgeStatus`'s ink, read off the same `STATUS_COLOR` vocabulary every other status
 *  badge in the app already uses, collapsed onto this module's five-token palette. */
function inkForStatus(status: TaskStatus): CardInk {
  switch (STATUS_COLOR[status]) {
    case 'danger':
    case 'severe':
      return 'danger';
    case 'warning':
      return 'attention';
    case 'success':
      return 'success';
    default:
      return 'faint';
  }
}

/**
 * `blocked` (conflicts, a needed rebase, another MR in the way) is the harder stop; `changes
 * requested` asks a question rather than reporting a failure, hence attention rather than
 * danger — the same split the mockup's own orange "Changes requested" draws. `approved` and
 * `unopposed` are both "ready to merge", which is worth a line precisely because it is
 * actionable. `closed` is history worth noting once, quietly.
 */
function verdictInk(verdict: MrVerdict): CardInk {
  switch (verdict) {
    case 'blocked':
      return 'danger';
    case 'changes-requested':
      return 'attention';
    case 'approved':
    case 'unopposed':
      return 'success';
    default:
      return 'faint';
  }
}

/**
 * The verdicts that say nothing new: `awaiting` is every open MR's resting state (nobody has
 * looked yet, which is not itself news), and `merged` is the footer's own MR ref saying
 * "this landed" already — the v9 mockup draws neither with a verdict row (`!124`/`!114` sit
 * quietly in Done with no line above them, unlike `!190`'s "Changes requested").
 */
const VERDICT_WORTH_A_LINE: ReadonlySet<MrVerdict> = new Set([
  'changes-requested',
  'blocked',
  'approved',
  'unopposed',
  'closed',
]);

function capitalize(text: string): string {
  return text.length ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The card's one status line — at most one, matching the mockup's "the card itself shows at
 * most the one live run and the one live verdict, matching the mockup's quieter column."
 *
 * A run already moving outranks everything, including a terminal status or an MR verdict:
 * it is the one thing on the card actually happening right now. Its label defers to the
 * run's **purpose** (`runPurposeOf`) when the engine sent the agent on an errand rather than
 * the card's own work — without this a step re-run to fix a pipeline after its chain had
 * already finished read as "Running step 4 of 4", which is indistinguishable from ordinary
 * progress and was exactly the complaint the old card's separate purpose chip existed to
 * answer. Folding it into the one status line here means a later-step rewrite can't forget
 * to ask for it a second time.
 *
 * Below that: whatever `cardRunLabel` says about a non-moving run phase — "Waiting for you",
 * "Paused — usage limit", "Stopped at step 2 of 4" — covers the case `cardBadgeStatus` alone
 * cannot see: a chain parked on a step that failed or asked a question leaves the PARENT
 * resting exactly where its column already says it is (`cardBadgeStatus` finds nothing to
 * badge), so without this branch a stopped chain showed nothing at all.
 *
 * Then a terminal status the column doesn't already imply (`cardBadgeStatus` — `failed`,
 * `stopped`, `cancelled`), then the MR verdict when it is worth a line, and last the chain
 * position for a card with nothing else to say.
 */
function statusLineFor(
  task: Task,
  subtasks: Task[],
  ctx: CardPartsContext,
  run: RunState,
): CardStatusLine | undefined {
  if (run.spinner) {
    const purpose = runPurposeOf(task, subtasks, ctx.runPurposes);
    return {
      kind: 'running',
      label: purpose ? RUN_PURPOSE_LABEL[purpose].label : runLabel(run),
      ink: 'cyan',
    };
  }

  const waiting = cardRunLabel(run, isAgentAssigned(task));
  if (waiting) return { kind: 'status', label: waiting, ink: waitingInk(task, subtasks, run) };

  const badge = cardBadgeStatus(task, run);
  if (badge) return { kind: 'status', label: STATUS_LABEL[badge], ink: inkForStatus(badge) };

  const mr = pickMergeRequest(ctx.mergeRequests);
  if (mr) {
    const verdict = mrVerdict(mr);
    if (VERDICT_WORTH_A_LINE.has(verdict)) {
      return { kind: 'verdict', label: capitalize(verdictSummary(mr)), ink: verdictInk(verdict) };
    }
  }

  if (ctx.chainPosition) {
    return {
      kind: 'chain',
      label: `${ctx.chainPosition.n} of ${ctx.chainPosition.m}`,
      ink: 'faint',
    };
  }

  return undefined;
}

function trailingFor(task: Task, ctx: CardPartsContext): CardTrailing | undefined {
  const mr = pickMergeRequest(ctx.mergeRequests);
  if (mr) return { kind: 'mr', ref: mrRef(mr), url: mr.webUrl };
  const due = dueParts(task, ctx.now);
  return due ? { kind: 'due', label: due.label, flagged: due.flagged } : undefined;
}

/** Long enough for a real epic title to still read as itself, short enough that the footer
 *  chip never pushes the MR ref or due date off the card. */
const EPIC_LABEL_MAX = 24;

function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function epicLabel(
  task: Pick<Task, 'externalEpicName' | 'externalParentKey'>,
  epicName: string | undefined,
): string | undefined {
  const label = epicName ?? task.externalEpicName ?? task.externalParentKey ?? undefined;
  return label ? truncateLabel(label, EPIC_LABEL_MAX) : undefined;
}

/**
 * Which optional rows the v9 card draws. See `CardParts` for the shape and `CardStatusLine`
 * for the priority order the one status line is picked in.
 */
export function cardParts(task: Task, ctx: CardPartsContext): CardParts {
  const subtasks = ctx.subtasks ?? [];
  const run = runPhase(task, subtasks, ctx.liveRunTaskIds, ctx.mergingTaskIds);
  const avatar = assigneeDisplayParts(ctx.assignee, ctx.agentName);
  const progress = subtaskProgress(subtasks);
  return {
    key: task.ticketKey ?? task.externalKey ?? '',
    owner: avatar ? { avatar, running: isAgentAssigned(task) && run.spinner } : undefined,
    statusLine: statusLineFor(task, subtasks, ctx, run),
    progress: progress.total > 0 ? progress : undefined,
    epic: epicLabel(task, ctx.epicName),
    trailing: trailingFor(task, ctx),
    decision: task.decisionQuestion != null ? { question: task.decisionQuestion } : undefined,
  };
}
