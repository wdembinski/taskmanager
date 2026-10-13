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
import { PERMISSION_MODE_LABELS, type ClaudeModel, type PermissionMode } from './session';

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
