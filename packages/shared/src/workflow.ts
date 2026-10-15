/**
 * Workflow documents — a reusable, ordered recipe of steps a card can run, as data
 * rather than as a one-off prompt. Two step kinds: an `agent` step hands a brief to
 * Claude; a `gate` step runs a command and, on failure, can send the run back to an
 * earlier agent step for another attempt.
 *
 * `validateWorkflow` is the single gate between "JSON someone typed or imported" and
 * a `WorkflowDoc` the engine is willing to run. It never throws — a bad document comes
 * back as a list of every problem found, not just the first, so an editor can show them
 * all at once.
 */
import { isUsableModel } from './model';
import type { Task } from './model';
import { PERMISSION_MODE_LABELS, type ClaudeModel, type PermissionMode } from './session';
import { parseSkillRef } from './skills';

/** How many steps a single workflow may hold. Generous for any real recipe, small
 *  enough that a malformed or runaway import can't produce an unbounded document. */
export const MAX_WORKFLOW_STEPS = 50;

/** How many times a gate may retry before giving up. */
const MIN_RETRY_ATTEMPTS = 1;
const MAX_RETRY_ATTEMPTS = 5;

/** A step that hands a brief to Claude. */
export interface AgentStep {
  id: string;
  kind: 'agent';
  title: string;
  /** The instructions this step's run receives. */
  brief: string;
  /** Overrides the project's default model for this step alone. */
  model?: ClaudeModel;
  /** Overrides the project's default permission mode for this step alone. */
  mode?: PermissionMode;
  /** Serialised {@link SkillRef}s (see `@shared/skills`) this step's run carries, in
   *  addition to the card's own. */
  skillRefs?: string[];
}

/** What a gate does when its command exits non-zero. */
export interface GateOnFail {
  /** The id of the agent step to resume from. Must name an agent step that comes
   *  before this gate in the workflow's own step order. */
  retryFrom: string;
  /** How many times to retry before giving up. */
  maxAttempts: number;
  /** Exit codes worth retrying on; absent means "any non-zero exit". */
  retryOn?: number[];
}

/** A step that runs a command and checks its exit code. */
export interface GateStep {
  id: string;
  kind: 'gate';
  title: string;
  /** The shell command this gate runs. */
  command: string;
  /** What to do on a non-zero exit; absent means "stop the workflow". */
  onFail?: GateOnFail;
}

export type WorkflowStep = AgentStep | GateStep;

export function isAgentStep(step: WorkflowStep): step is AgentStep {
  return step.kind === 'agent';
}

export function isGateStep(step: WorkflowStep): step is GateStep {
  return step.kind === 'gate';
}

/** A workflow document, as stored and as imported/exported. `version` is the one
 *  field a future, incompatible format would bump; nothing here reads past 1 yet. */
export interface WorkflowDoc {
  version: 1;
  id: string;
  name: string;
  steps: WorkflowStep[];
}

export type ValidateWorkflowResult =
  { ok: true; doc: WorkflowDoc } | { ok: false; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkTitle(step: { id: string; title: unknown }, issues: string[]): void {
  if (typeof step.title !== 'string' || step.title.trim().length === 0) {
    issues.push(`Step "${step.id}"'s title must be a non-empty string.`);
  }
}

function checkAgentStep(step: AgentStep, issues: string[]): void {
  checkTitle(step, issues);
  if (typeof step.brief !== 'string' || step.brief.trim().length === 0) {
    issues.push(`Agent step "${step.id}"'s brief must be a non-empty string.`);
  }
  if (step.model !== undefined && !isUsableModel(step.model)) {
    issues.push(`Agent step "${step.id}"'s model ("${step.model}") is not a usable model id.`);
  }
  if (step.mode !== undefined && !(step.mode in PERMISSION_MODE_LABELS)) {
    issues.push(`Agent step "${step.id}"'s mode ("${step.mode}") is not a known permission mode.`);
  }
  if (step.skillRefs !== undefined) {
    if (!Array.isArray(step.skillRefs)) {
      issues.push(`Agent step "${step.id}"'s skillRefs must be an array.`);
    } else if (
      step.skillRefs.some((ref) => typeof ref !== 'string' || parseSkillRef(ref) === null)
    ) {
      issues.push(`Agent step "${step.id}"'s skillRefs contains an invalid skill reference.`);
    }
  }
}

function checkGateStep(
  step: GateStep,
  index: number,
  allSteps: WorkflowStep[],
  stepIndexById: Map<string, number>,
  issues: string[],
): void {
  checkTitle(step, issues);
  if (typeof step.command !== 'string' || step.command.trim().length === 0) {
    issues.push(`Gate step "${step.id}"'s command must be a non-empty string.`);
  }

  const onFail = step.onFail;
  if (!onFail) return;

  const targetIndex = stepIndexById.get(onFail.retryFrom);
  if (targetIndex === undefined) {
    issues.push(
      `Gate step "${step.id}"'s onFail.retryFrom ("${onFail.retryFrom}") does not refer to a known step.`,
    );
  } else if (onFail.retryFrom === step.id) {
    issues.push(`Gate step "${step.id}" cannot retry from itself.`);
  } else if (allSteps[targetIndex].kind === 'gate') {
    issues.push(
      `Gate step "${step.id}"'s onFail.retryFrom ("${onFail.retryFrom}") must name an agent step, not another gate.`,
    );
  } else if (targetIndex >= index) {
    issues.push(
      `Gate step "${step.id}"'s onFail.retryFrom ("${onFail.retryFrom}") must refer to a step before it, not after.`,
    );
  }

  if (
    typeof onFail.maxAttempts !== 'number' ||
    !Number.isInteger(onFail.maxAttempts) ||
    onFail.maxAttempts < MIN_RETRY_ATTEMPTS ||
    onFail.maxAttempts > MAX_RETRY_ATTEMPTS
  ) {
    issues.push(
      `Gate step "${step.id}"'s onFail.maxAttempts must be an integer between ${MIN_RETRY_ATTEMPTS} and ${MAX_RETRY_ATTEMPTS}.`,
    );
  }

  if (onFail.retryOn !== undefined) {
    const bad = onFail.retryOn.some((code) => !Number.isInteger(code) || code < 1);
    if (bad) {
      issues.push(`Gate step "${step.id}"'s onFail.retryOn must only contain positive integers.`);
    }
  }
}

/**
 * Check an unknown value against the `WorkflowDoc` shape, collecting every problem
 * rather than stopping at the first. Pure and total — no I/O, so a UI can validate on
 * every keystroke the same way an import pipeline validates a file off disk.
 */
export function validateWorkflow(input: unknown): ValidateWorkflowResult {
  if (!isRecord(input)) {
    return { ok: false, issues: ['A workflow must be an object.'] };
  }

  const issues: string[] = [];

  if (input.version !== 1) {
    issues.push('Version must be 1.');
  }
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    issues.push('A workflow must have a non-empty id.');
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    issues.push('A workflow must have a non-empty name.');
  }

  const steps = Array.isArray(input.steps) ? (input.steps as WorkflowStep[]) : [];
  if (!Array.isArray(input.steps)) {
    issues.push("A workflow's steps must be an array.");
  } else if (steps.length === 0) {
    issues.push('A workflow needs at least one step.');
  } else if (steps.length > MAX_WORKFLOW_STEPS) {
    issues.push(`A workflow may have at most ${MAX_WORKFLOW_STEPS} steps.`);
  }

  const seenIds = new Set<string>();
  const stepIndexById = new Map<string, number>();
  steps.forEach((step, index) => {
    if (isRecord(step) && typeof step.id === 'string' && !stepIndexById.has(step.id)) {
      stepIndexById.set(step.id, index);
    }
  });

  steps.forEach((step, index) => {
    if (!isRecord(step) || typeof step.id !== 'string') {
      issues.push(`Step at index ${index} must have an id.`);
      return;
    }
    if (seenIds.has(step.id)) {
      issues.push(`Step "${step.id}" is a duplicate id.`);
    } else {
      seenIds.add(step.id);
    }

    if (step.kind === 'agent') {
      checkAgentStep(step as AgentStep, issues);
    } else if (step.kind === 'gate') {
      checkGateStep(step as GateStep, index, steps, stepIndexById, issues);
    } else {
      issues.push(`Step "${step.id}" has an unknown kind ("${String(step.kind)}").`);
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, doc: input as unknown as WorkflowDoc };
}

/**
 * 64 KiB of `JSON.stringify(doc)`. Unlike a `Skill` (`@shared/skills`), a workflow
 * has no single "body" field to cap — the cap applies to the whole document, the shape
 * the server's `/v1/workflows` mirror (F8.12) actually stores and `PUT`/`GET` actually
 * send, so that is what is measured.
 */
export const WORKFLOW_DOC_MAX = 64 * 1024;

/**
 * `doc`'s size the way {@link WORKFLOW_DOC_MAX} actually bounds it — UTF-8 bytes of its
 * `JSON.stringify`, not `string.length` (UTF-16 code units). Same `TextEncoder`
 * convention as `skillBodyBytes` (`@shared/skills`) and for the same reason: a document
 * full of multi-byte characters is under budget by `.length` while already over it in
 * the bytes the server and the desktop pusher both count.
 *
 * `JSON.stringify(doc)` doubles as the mirror's change fingerprint (F8.12): `WorkflowDoc`
 * carries no `updatedAt` of its own, and this is exactly the string a `PUT` sends, so a
 * desktop that seeds its last-pushed fingerprint from a prior `GET` compares like for
 * like and a restart does not re-push an unchanged workflow.
 */
export function workflowDocBytes(doc: WorkflowDoc): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/**
 * The sentence a 413 earns, worded identically wherever it is shown — same convention as
 * `skillTooLargeMessage` (`@shared/skills`). `bytes` is rounded UP to whole KiB, so a
 * document one byte over {@link WORKFLOW_DOC_MAX} never reads as "64 KiB > 64 KiB" — a
 * contradiction a reader would reasonably doubt.
 */
export function workflowTooLargeMessage(bytes: number): string {
  const kib = Math.ceil(bytes / 1024);
  return `too large to sync (${kib} KiB > ${WORKFLOW_DOC_MAX / 1024} KiB)`;
}

/** The inbox option that runs a not-yet-trusted gate command (F8.8). Named here so the
 *  engine that raises the item and the steps list that reads "awaiting trust" off it
 *  agree on one string. */
export const GATE_TRUST_ACTION = 'Trust and run';

/** How many bytes of a gate's timeline output to keep — enough to show the failing
 *  tail without storing an unbounded log for a command that ran for hours. */
export const GATE_TIMELINE_TAIL_BYTES = 16 * 1024;

/** How many bytes of a gate's failure note to keep — the timeline keeps more context,
 *  but a note is a short summary and doesn't need as much room. */
export const GATE_FAILURE_NOTE_TAIL_BYTES = 8 * 1024;

/** What a gate's run produced, as input to `decideGateOutcome`. */
export interface GateRunResult {
  /** The command's exit code; `null` means it never got one — killed or a spawn error. */
  exitCode: number | null;
  timedOut: boolean;
  /** Retries already spent on this gate (`Task.gateAttempts`), before this run. */
  attemptsUsed: number;
  onFail?: GateOnFail;
}

/** Why a gate's outcome is `fail`, for a message that doesn't have to re-derive it. */
export type GateFailReason =
  'no-on-fail' | 'timeout' | 'no-exit-code' | 'non-retryable-code' | 'attempts-exhausted';

export type GateOutcome =
  | { kind: 'pass' }
  | { kind: 'retry'; retryFrom: string; attempt: number; maxAttempts: number }
  | { kind: 'fail'; reason: GateFailReason };

/**
 * Decide what a gate's run means for the workflow, as a pure function of the run's
 * result — the engine owns running the command and acting on the outcome, this just
 * names it. Checks are ordered: a timeout is non-retryable even on exit 0 (it's an
 * infrastructure fact, not a command result), then pass, then the ways a retry can be
 * refused.
 */
export function decideGateOutcome(r: GateRunResult): GateOutcome {
  if (r.timedOut) return { kind: 'fail', reason: 'timeout' };
  if (r.exitCode === 0) return { kind: 'pass' };
  if (r.exitCode === null) return { kind: 'fail', reason: 'no-exit-code' };

  const onFail = r.onFail;
  if (!onFail) return { kind: 'fail', reason: 'no-on-fail' };

  if (onFail.retryOn && onFail.retryOn.length > 0 && !onFail.retryOn.includes(r.exitCode)) {
    return { kind: 'fail', reason: 'non-retryable-code' };
  }

  if (r.attemptsUsed >= onFail.maxAttempts) {
    return { kind: 'fail', reason: 'attempts-exhausted' };
  }

  return {
    kind: 'retry',
    retryFrom: onFail.retryFrom,
    attempt: r.attemptsUsed + 1,
    maxAttempts: onFail.maxAttempts,
  };
}

/** A UTF-8 continuation byte — the top two bits are `10`. */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * Keep only the last `maxBytes` of `output`'s UTF-8 encoding, so a gate's stored
 * timeline or failure note can't grow without bound. Returns `output` unchanged if it
 * already fits. Otherwise prefixes a `…[N bytes truncated]\n` marker (counted against
 * `maxBytes` itself) and trims forward from the cut point past any split code point,
 * so the kept text always decodes cleanly.
 */
export function boundOutputTail(output: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  const encoded = new TextEncoder().encode(output);
  if (encoded.length <= maxBytes) return output;

  const markerFor = (truncatedBytes: number): string => `…[${truncatedBytes} bytes truncated]\n`;

  const estimatedMarkerBytes = new TextEncoder().encode(markerFor(encoded.length)).length;
  let cut = encoded.length - Math.max(0, maxBytes - estimatedMarkerBytes);
  while (cut < encoded.length && isUtf8ContinuationByte(encoded[cut])) {
    cut += 1;
  }

  return markerFor(cut) + new TextDecoder().decode(encoded.subarray(cut));
}

/** A gate's {@link GateOnFail} with `retryFrom` resolved to the target step's position
 *  (0-based) among {@link instantiateWorkflow}'s drafts. */
export interface ResolvedGateOnFail extends GateOnFail {
  retryFromIndex: number;
}

/** What a draft's `stepSpec` snapshots: an agent step verbatim, or a gate step with its
 *  `onFail` (if any) resolved to a {@link ResolvedGateOnFail}. */
export type StepSpec = AgentStep | (Omit<GateStep, 'onFail'> & { onFail?: ResolvedGateOnFail });

/** One row {@link instantiateWorkflow} produces per workflow step — not yet a `Task`,
 *  but everything a caller needs to build the step rows for a card's plan round. */
export interface WorkflowStepDraft {
  /** The card this round's steps belong to (`Task.id`). */
  parentTaskId: string;
  /** The plan round these steps join (`Task.planRound`). */
  planRound: number;
  /** The workflow document this draft was instantiated from (`WorkflowDoc.id`). */
  workflowId: string;
  title: string;
  /** An agent step's brief; null for a gate (its command lives in `stepSpec` instead). */
  description: string | null;
  /** `step.model` for an agent step, else null — the model ladder applies unchanged. */
  agentModel: ClaudeModel | null;
  /** `step.mode` for an agent step, else null. */
  agentMode: PermissionMode | null;
  /** A copy of the agent step's `skillRefs`, or null when absent or empty. */
  skillRefs: string[] | null;
  /** A deep snapshot of the `WorkflowStep` this draft came from. */
  stepSpec: StepSpec;
  /** 1-based position among all of this instantiation's steps. */
  stepNumber: number;
  /** Total number of steps in this instantiation. */
  stepCount: number;
  /** 1-based position among agent steps only; null on a gate. */
  agentStepNumber: number | null;
  /** Total number of agent steps in this instantiation. */
  agentStepCount: number;
}

/**
 * Turn a workflow document into the ordered drafts its steps become on `card`'s
 * `round`-th plan round.
 *
 * **Precondition:** `doc` has already passed {@link validateWorkflow} — every
 * `onFail.retryFrom` is known to resolve to an earlier agent step, so the only way
 * this function can throw is a caller skipping that check.
 *
 * Pure: snapshots `doc.steps` with `JSON.parse(JSON.stringify(...))` before touching it
 * (workflow docs are JSON by contract), so no draft's `stepSpec` ever aliases the
 * document, and mutating `doc` after the call cannot change a draft already returned.
 */
export function instantiateWorkflow(
  doc: WorkflowDoc,
  card: Pick<Task, 'id'>,
  round: number,
): WorkflowStepDraft[] {
  const steps: WorkflowStep[] = JSON.parse(JSON.stringify(doc.steps));

  const indexById = new Map<string, number>();
  steps.forEach((step, index) => indexById.set(step.id, index));

  const agentStepNumberByIndex = new Map<number, number>();
  let agentStepCount = 0;
  steps.forEach((step, index) => {
    if (isAgentStep(step)) {
      agentStepCount += 1;
      agentStepNumberByIndex.set(index, agentStepCount);
    }
  });

  return steps.map((step, index) => {
    const stepSpec = toStepSpec(step, index, steps, indexById);
    return {
      parentTaskId: card.id,
      planRound: round,
      workflowId: doc.id,
      title: step.title,
      description: isAgentStep(step) ? step.brief : null,
      agentModel: isAgentStep(step) ? (step.model ?? null) : null,
      agentMode: isAgentStep(step) ? (step.mode ?? null) : null,
      skillRefs:
        isAgentStep(step) && step.skillRefs && step.skillRefs.length > 0 ? step.skillRefs : null,
      stepSpec,
      stepNumber: index + 1,
      stepCount: steps.length,
      agentStepNumber: agentStepNumberByIndex.get(index) ?? null,
      agentStepCount,
    };
  });
}

/** Build a {@link StepSpec} for one (already-snapshotted) step: an agent step as is, or
 *  a gate step with its `onFail` resolved to a {@link ResolvedGateOnFail}. Throws if
 *  `onFail.retryFrom` does not resolve to an earlier agent step — a programmer error,
 *  since {@link instantiateWorkflow}'s precondition is that `doc` already passed
 *  {@link validateWorkflow}, which rules this out. */
function toStepSpec(
  step: WorkflowStep,
  index: number,
  steps: WorkflowStep[],
  indexById: Map<string, number>,
): StepSpec {
  if (isAgentStep(step)) return step;
  if (!step.onFail) {
    const { onFail: _onFail, ...rest } = step;
    return rest;
  }

  const retryFromIndex = indexById.get(step.onFail.retryFrom);
  if (
    retryFromIndex === undefined ||
    retryFromIndex >= index ||
    !isAgentStep(steps[retryFromIndex])
  ) {
    throw new Error(
      `Gate step "${step.id}"'s onFail.retryFrom ("${step.onFail.retryFrom}") does not resolve to an earlier agent step.`,
    );
  }

  return { ...step, onFail: { ...step.onFail, retryFromIndex } };
}
