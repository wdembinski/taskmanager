/**
 * What a **gate** step's row on the steps list says (F8.10) — pure, so every state can be
 * pinned by a test the way `taskTimeline.ts` is, and `TaskSteps` only has to draw it.
 *
 * A gate is not an agent step with a different icon: it never has a session, it can loop an
 * earlier step back, and its one interesting artefact is the command's output. So its row
 * reads its own facts — `stepSpec`, `gateAttempts`, the inbox item parked on it, and the
 * notes the engine filed on its timeline — rather than an agent's.
 */
import type { AttentionItem } from '@tm/shared/attention';
import type { TaskActivityEntry, Task, TaskStatus } from '@tm/shared/model';
import { GATE_TRUST_ACTION, isGateStep, type GateStep } from '@tm/shared/workflow';

/** The five things a gate can be, plus `stopped` — Stop on the card terminates a gate. */
export type GateStepState =
  'pending' | 'running' | 'passed' | 'failed' | 'awaiting-trust' | 'stopped';

export interface GateStepView {
  state: GateStepState;
  /** The status word on the row. */
  label: string;
  /**
   * Which `TaskStatus` colour the status badge borrows — the ONLY colour on the row. The
   * icon, the command and the attempt chip stay monochrome: colour is for what moves.
   */
  tone: TaskStatus;
  command: string;
  /** "attempt 2/3" once the gate has looped back at least once; null before that, and on a
   *  gate with no retry configured (there is no budget to count against). */
  attempt: string | null;
  /** The newest output tail the engine recorded for this gate, or null when none exists yet. */
  output: string | null;
  /**
   * `awaiting-trust` on a host that cannot itself trust the command (F8.13) — the web, which
   * has no desktop to run Trust on — carries the sentence to show in place of the Trust
   * button. Null everywhere else, including `awaiting-trust` on a host that CAN trust it.
   */
  waiting: string | null;
}

const LABEL: Record<GateStepState, string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  'awaiting-trust': 'Awaiting trust',
  stopped: 'Stopped',
};

const TONE: Record<GateStepState, TaskStatus> = {
  pending: 'pending',
  running: 'running',
  passed: 'done',
  failed: 'failed',
  'awaiting-trust': 'waiting-input',
  stopped: 'stopped',
};

/** The step's gate spec, or undefined when it is an agent step (or a hand-written one). */
export function gateSpecOf(step: Task): GateStep | undefined {
  const spec = step.stepSpec;
  return spec && isGateStep(spec) ? spec : undefined;
}

/** True when an inbox item is the trust prompt for an untrusted gate command (F8.8). */
export function isGateTrustItem(item: AttentionItem): boolean {
  return item.options.includes(GATE_TRUST_ACTION.trust);
}

/** True when `options` is exactly the trust/decline pair a parked gate offers (F8.8). */
function isTrustPair(options: readonly string[]): boolean {
  return (
    options.length === 2 &&
    options[0] === GATE_TRUST_ACTION.trust &&
    options[1] === GATE_TRUST_ACTION.decline
  );
}

/**
 * What to say in place of the Trust button when THIS host cannot press it (F8.13) — the web,
 * which has no desktop app of its own to run the command on.
 */
export function gateTrustWaitingText(hostName: string | null): string {
  return hostName
    ? `Waiting for ${hostName} to trust this command`
    : 'Waiting for the desktop app to trust this command';
}

/**
 * The buttons an inbox item's `options` should actually offer. Unchanged except for the one
 * case this host cannot act on: a trust prompt with `canTrust` false drops Trust and keeps
 * Decline, which still relays fine via `attention:answer` — it is only "run it on this
 * machine" that a browser can't promise.
 */
export function gateTrustChoices(options: readonly string[], canTrust: boolean): string[] {
  if (!canTrust && isTrustPair(options)) return [GATE_TRUST_ACTION.decline];
  return [...options];
}

function stateOf(step: Task, items: readonly AttentionItem[]): GateStepState {
  // Checked first: a trust prompt parks the step in whatever status it was handed, and it
  // must not read as a failure — nothing has run yet.
  if (items.some(isGateTrustItem)) return 'awaiting-trust';
  switch (step.status) {
    case 'running':
      return 'running';
    case 'done':
      return 'passed';
    // A failed gate is parked as an inbox item, which moves it to `waiting-input`. A gate
    // never asks a question, so that status on one only ever means "failed, your move".
    case 'failed':
    case 'waiting-input':
      return 'failed';
    case 'stopped':
    case 'cancelled':
      return 'stopped';
    default:
      return 'pending';
  }
}

/**
 * The newest note the engine filed on a gate's own timeline. A gate step has no Claude
 * session, so every assistant-text event on it is one of the engine's own notes — the
 * retry's "failed — sending step N back" or the park's "Task parked after failure" — each
 * of which carries the output tail.
 */
export function latestGateNote(activity: readonly TaskActivityEntry[]): string | null {
  let latest: { text: string; at: number } | null = null;
  for (const entry of activity) {
    if (entry.kind !== 'event' || entry.event.kind !== 'assistant') continue;
    if (!latest || entry.createdAt >= latest.at) {
      latest = { text: entry.event.text, at: entry.createdAt };
    }
  }
  return latest?.text ?? null;
}

export interface GateStepViewInput {
  step: Task;
  /** Inbox items parked on THIS step (not the card's). */
  attention?: readonly AttentionItem[];
  /** This step's own timeline, once loaded — the expander fetches it on demand. */
  activity?: readonly TaskActivityEntry[];
  /** Whether THIS host can trust a gate command, and what to call it when it can't (F8.13). */
  trustHost?: { canTrust: boolean; name: string | null };
}

/** The row for a gate step, or null when `step` is not a gate. */
export function gateStepView({
  step,
  attention = [],
  activity = [],
  trustHost,
}: GateStepViewInput): GateStepView | null {
  const spec = gateSpecOf(step);
  if (!spec) return null;
  const state = stateOf(step, attention);
  const used = step.gateAttempts ?? 0;
  const max = spec.onFail?.maxAttempts;
  // An open failure's prompt is the newest word on the gate — reason, then output — so it
  // wins over the timeline, which may not have been read since.
  const failure = attention.find((i) => i.kind === 'task-failed');
  return {
    state,
    label: LABEL[state],
    tone: TONE[state],
    command: spec.command,
    attempt: max !== undefined && used > 0 ? `attempt ${used}/${max}` : null,
    output: failure?.prompt || latestGateNote(activity),
    waiting:
      state === 'awaiting-trust' && trustHost?.canTrust === false
        ? gateTrustWaitingText(trustHost.name)
        : null,
  };
}
