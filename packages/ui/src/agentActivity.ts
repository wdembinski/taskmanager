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
 *
 * `activityLabel` serves a narrower need (quiet mode, `settings.features.quietAgentProgress`):
 * once the chat stops showing the tool-work turns at all, the footer's "Running…" line is
 * the only place the agent's current move is visible, and it only has room for one phrase.
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

/** Flatten whitespace and cap length, the same shape `labelOf` already trims to. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The last path segment, for a phrase like "Reading foo.ts" instead of the full path. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Known imperative verbs a Bash `description` opens with, turned into their -ing form. */
const GERUNDS: Record<string, string> = {
  run: 'Running',
  read: 'Reading',
  write: 'Writing',
  edit: 'Editing',
  search: 'Searching',
  find: 'Finding',
  fetch: 'Fetching',
  install: 'Installing',
  build: 'Building',
  test: 'Testing',
  check: 'Checking',
  list: 'Listing',
  create: 'Creating',
  delete: 'Deleting',
  remove: 'Removing',
  update: 'Updating',
  start: 'Starting',
  stop: 'Stopping',
  commit: 'Committing',
  push: 'Pushing',
  pull: 'Pulling',
};

/** "Run tests" → "Running tests"; an unknown opening verb just gets an "ing" stitched on. */
function gerundPhrase(description: string): string {
  const [verb, ...rest] = description.trim().split(/\s+/);
  if (!verb) return description;
  const gerund = GERUNDS[verb.toLowerCase()] ?? `${verb.replace(/e$/, '')}ing`;
  return [gerund, ...rest].join(' ');
}

/** What a Bash call is doing, in one phrase — the model's own `description`, reworded. */
function bashPhrase(input: Record<string, unknown> | undefined): string {
  const description = input?.description;
  if (typeof description === 'string' && description.trim()) {
    return gerundPhrase(truncate(description, 60));
  }
  const command = input?.command;
  return typeof command === 'string' && command.trim()
    ? `Running ${truncate(command, 50)}`
    : 'Running a command';
}

/**
 * A short human phrase for a `tool-use`/`thinking` event — "Reading foo.ts", "Running
 * tests" — for surfaces that show the agent's LATEST move rather than its whole transcript
 * (the quiet-mode footer). Returns null for any other kind of event, so a caller can use it
 * both to format an event and to test whether one is describable at all.
 */
export function activityLabel(event: SessionEvent): string | null {
  if (event.kind === 'thinking') return 'Thinking';
  if (event.kind !== 'tool-use') return null;

  const name = event.name.toLowerCase();
  const input = event.input;

  if (SUBAGENT_TOOLS.has(name)) {
    const label = labelOf(input);
    return label ? `Running: ${label}` : 'Running a sub-agent';
  }

  const path = typeof input?.file_path === 'string' ? baseName(input.file_path) : null;
  switch (name) {
    case 'read':
      return path ? `Reading ${path}` : 'Reading a file';
    case 'write':
      return path ? `Writing ${path}` : 'Writing a file';
    case 'edit':
    case 'notebookedit':
      return path ? `Editing ${path}` : 'Editing a file';
    case 'bash':
      return bashPhrase(input);
    case 'grep':
      return typeof input?.pattern === 'string'
        ? `Searching for "${truncate(input.pattern, 40)}"`
        : 'Searching the codebase';
    case 'glob':
      return typeof input?.pattern === 'string'
        ? `Finding files matching ${truncate(input.pattern, 40)}`
        : 'Finding files';
    case 'webfetch':
      return typeof input?.url === 'string'
        ? `Fetching ${truncate(input.url, 50)}`
        : 'Fetching a page';
    case 'websearch':
      return typeof input?.query === 'string'
        ? `Searching the web for "${truncate(input.query, 40)}"`
        : 'Searching the web';
    case 'todowrite':
      return 'Updating the plan';
    default:
      return `Using ${event.name}`;
  }
}
