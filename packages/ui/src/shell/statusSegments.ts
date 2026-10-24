/**
 * What the status bar's agent, branch and quota segments say — decided here, once, so the
 * desktop and the browser cannot drift apart on it. Pure: each host feeds its own tasks,
 * selection and quotas, and renders the answer with `StatusBar.tsx`'s atoms. `null` means
 * the segment is not shown at all.
 *
 * The web shows only what it can know. A mirror with no live desktop behind it cannot tell
 * whether a `running` status is still true, and the relay cannot answer `usage:quotas`, so
 * both go dark while the desktop is offline. A card's branch is a stored fact, so it stays.
 */
import type { Task } from '@tm/shared/model';
import type { UsageQuota, UsageQuotas } from '@tm/shared/usage';

export interface StatusSegmentsInput {
  host: 'desktop' | 'web';
  tasks: readonly Task[];
  /** The selected (desktop) or open (web) card or step, if any. */
  selectedTaskId: string | null;
  quotas: UsageQuotas | null;
  /** The web's desktop presence; `undefined` reads as offline there. Ignored by the desktop. */
  desktopOnline?: boolean;
}

export interface StatusSegments {
  /** Running cards and steps; `null` when there are none or the host cannot know. */
  agentsRunning: number | null;
  /** The current card's branch; `null` when there is no card with one. */
  branch: string | null;
  /** The quotas to draw; `null` when the host cannot know them. */
  quotas: UsageQuotas | null;
}

/** Walks `parentTaskId` up to the card a step belongs to. Guarded against a cycle. */
function rootOf(task: Task, byId: ReadonlyMap<string, Task>): Task {
  let current = task;
  const seen = new Set<string>();
  while (current.parentTaskId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentTaskId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * A card's branch, the way the engine names it: `agentBranch`, or the legacy
 * `orch/<id>` when that is null on a card that has run. A card that never ran has none.
 */
function branchOfRoot(root: Task): string | null {
  if (root.agentBranch) return root.agentBranch;
  return root.workedAt != null ? `orch/${root.id}` : null;
}

export function statusSegments(input: StatusSegmentsInput): StatusSegments {
  const { host, tasks, selectedTaskId, quotas } = input;
  const live = host === 'desktop' || input.desktopOnline === true;

  const running = tasks.filter((t) => t.status === 'running' && t.archivedAt == null);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));

  let current: Task | undefined;
  if (selectedTaskId !== null) {
    current = byId.get(selectedTaskId);
  } else {
    for (const t of running) {
      if (!current || (t.workedAt ?? 0) > (current.workedAt ?? 0)) current = t;
    }
  }

  return {
    agentsRunning: live && running.length > 0 ? running.length : null,
    branch: current ? branchOfRoot(rootOf(current, byId)) : null,
    quotas: live ? quotas : null,
  };
}

export function agentsRunningLabel(n: number): string {
  return n === 1 ? '1 agent running' : `${n} agents running`;
}

/** A quota's word in the status bar: the window's width, as v9 draws it. The full name
 *  and the percentage live in the segment's tooltip. */
export function quotaSegmentLabel(id: UsageQuota['id']): '5h' | '7d' {
  return id === 'session' ? '5h' : '7d';
}
