/**
 * What the task detail pane shows *while an agent works* — pure, unit-tested.
 *
 * The Board's Transcript is a debugging view: every thinking snippet, every tool
 * call, every tool result. In the My Tasks detail pane that reads as noise —
 * `·thinking· …` / `⚙ Glob` / `⚙ result` lines scrolling past tell a human nothing
 * about their ticket. So the detail pane keeps what a human actually reads (the
 * agent's prose, the session/limit/result markers, errors) and collapses the rest
 * into one live "Agent running" indicator.
 *
 * Sub-agents get the same treatment: the CLI spawns one via the `Task` tool, so an
 * unmatched `tool-use`/`tool-result` pair for that tool IS a sub-agent currently
 * working, and each open one becomes its own "Agent running" row.
 */
import type { SessionEvent } from '@tm/shared/session';

/** Tool names the CLI uses to spawn a sub-agent. Matched case-insensitively. */
const SUBAGENT_TOOLS = new Set(['task', 'agent']);

/**
 * True for events that exist for debugging rather than for the human reading their
 * ticket. Filtered out of the detail timeline; the spinner covers the fact that work
 * is happening. A FAILED tool result is deliberately kept — silently swallowing an
 * error is how a stuck run looks like a working one.
 */
export function isTranscriptNoise(event: SessionEvent): boolean {
  if (event.kind === 'thinking' || event.kind === 'tool-use') return true;
  return event.kind === 'tool-result' && !event.isError;
}

/** One sub-agent the main agent has spawned and is still waiting on. */
export interface RunningSubAgent {
  /** The spawning tool call's id — stable for as long as the sub-agent runs. */
  toolId: string;
  /** The sub-agent's task description, when the call carried one. */
  label: string | null;
}

/** Read a sub-agent's description out of the `Task` tool's input, if present. */
function labelOf(input: Record<string, unknown> | undefined): string | null {
  for (const key of ['description', 'subagent_type', 'prompt']) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
  }
  return null;
}

/**
 * The sub-agents still running, in the order they were spawned: every sub-agent
 * `tool-use` that has no matching `tool-result` yet. Pass the run's events oldest
 * first (the detail pane's timeline order).
 */
export function runningSubAgents(events: readonly SessionEvent[]): RunningSubAgent[] {
  const open = new Map<string, RunningSubAgent>();
  for (const event of events) {
    if (event.kind === 'tool-use' && SUBAGENT_TOOLS.has(event.name.toLowerCase())) {
      open.set(event.toolId, { toolId: event.toolId, label: labelOf(event.input) });
    } else if (event.kind === 'tool-result') {
      open.delete(event.toolId);
    } else if (event.kind === 'result' || event.kind === 'exited') {
      // The run ended: nothing it spawned can still be running, whatever we saw.
      open.clear();
    }
  }
  return [...open.values()];
}
