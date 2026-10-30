/**
 * When a board card must redraw (F29.3) — `sameCardRow`, the comparator `KanbanColumn`'s
 * memoised `BoardCardRow` is wrapped in.
 *
 * Without it every card on a 5,000-card board redrew on every change, because the column
 * hands each card the board-wide sets (`liveRunTaskIds`, `attentionTaskIds`, …) and those are
 * new objects the moment ANY card's run starts. A card only reads its own id and its steps'
 * ids out of them, so that is all this compares:
 *
 * - the board-wide sets and maps, by membership or value for this card and its steps only;
 * - `subtasks` and `mergeRequests` element by element by identity — F29.2's
 *   `applyTaskDelta` keeps an unchanged summary the same object;
 * - `variants`, `chain` and `linkChips`, which are rebuilt on every pass, by shallow content;
 * - everything else shallowly.
 */
import type { Person } from '@tm/shared/model';
import type { TaskSummary } from '@tm/shared/taskSummary';
import type { RunPurpose } from '@tm/shared/scheduler';
import type { AutomationOrigin } from './automationOrigin';
import type { BoardCard } from './boardColumns';
import type { LinkDropState } from './chainDrag';
import type { ChainState } from './chainStates';
import type { LinkChips } from './linkChips';

/** One card as its column draws it: the card, what the board resolved for it, and the
 *  column's stable, id-taking handlers. */
export interface BoardCardRowProps {
  card: BoardCard;
  epicName?: string;
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  agentName?: string;
  originAutomation?: AutomationOrigin;
  /** Where the card stands in its chain — `chainStateOf`'s answer. */
  chain?: ChainState;
  linkChips?: LinkChips;
  attentionTaskIds?: ReadonlySet<string>;
  liveRunTaskIds?: ReadonlySet<string>;
  runPurposes?: ReadonlyMap<string, RunPurpose>;
  runStartedAt?: ReadonlyMap<string, number>;
  mergingTaskIds?: ReadonlySet<string>;
  dimmedTaskIds?: ReadonlySet<string>;
  /** The link gesture's per-card answers (`LinkDragState.states`), when one is in the air. */
  linkStates?: ReadonlyMap<string, LinkDropState>;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  anchorRef?: (taskId: string) => (el: HTMLDivElement | null) => void;
  onLinkStart?: (taskId: string) => void;
  onLinkEnd?: () => void;
  onLinkTo?: (fromTaskId: string, toTaskId: string) => void;
  onLinkArm?: (taskId: string) => void;
  onMakeArrow?: (fromTaskId: string, toTaskId: string) => void;
  onStop?: (taskId: string) => void;
  onResume?: (taskId: string) => void;
  onToggleShelved?: (taskId: string) => void;
  onMoveTo?: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
}

/** Read for this card AND its steps: a step's run is what makes a card spin. */
const SETS_BY_CARD_AND_STEPS = ['attentionTaskIds', 'liveRunTaskIds', 'mergingTaskIds'] as const;
const MAPS_BY_CARD_AND_STEPS = ['runPurposes', 'runStartedAt'] as const;

/** Every prop compared by a rule of its own rather than shallowly. */
const SPECIAL: ReadonlySet<string> = new Set<string>([
  'card',
  'chain',
  'linkChips',
  'dimmedTaskIds',
  'linkStates',
  ...SETS_BY_CARD_AND_STEPS,
  ...MAPS_BY_CARD_AND_STEPS,
]);

function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Equal by content `depth` levels down — arrays element by element, objects key by key — and
 * by identity below that. Exported for its test.
 */
export function sameShallow(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => sameShallow(v, b[i], depth - 1));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => k in b && sameShallow(a[k], b[k], depth - 1));
  }
  return false;
}

function sameCard(a: BoardCard, b: BoardCard): boolean {
  if (a === b) return true;
  return (
    a.task === b.task &&
    sameElements(a.subtasks, b.subtasks) &&
    sameElements(a.mergeRequests, b.mergeRequests) &&
    // `{state, rows: [{id, label, status}]}`, rebuilt for every card on every pass.
    sameShallow(a.variants, b.variants, 3)
  );
}

function idsOf(card: BoardCard): string[] {
  return [card.task.id, ...card.subtasks.map((s: TaskSummary) => s.id)];
}

function sameMembership(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
  ids: readonly string[],
): boolean {
  if (a === b) return true;
  return ids.every((id) => (a?.has(id) ?? false) === (b?.has(id) ?? false));
}

function sameValues<V>(
  a: ReadonlyMap<string, V> | undefined,
  b: ReadonlyMap<string, V> | undefined,
  ids: readonly string[],
): boolean {
  if (a === b) return true;
  return ids.every((id) => Object.is(a?.get(id), b?.get(id)));
}

/** Whether a card would draw the same for `next` as it did for `prev` — `React.memo`'s
 *  comparator for `BoardCardRow`. */
export function sameCardRow(prev: BoardCardRowProps, next: BoardCardRowProps): boolean {
  if (!sameCard(prev.card, next.card)) return false;
  const ids = idsOf(next.card);
  const own = [next.card.task.id];
  for (const key of SETS_BY_CARD_AND_STEPS) {
    if (!sameMembership(prev[key], next[key], ids)) return false;
  }
  for (const key of MAPS_BY_CARD_AND_STEPS) {
    if (!sameValues<unknown>(prev[key], next[key], ids)) return false;
  }
  if (!sameMembership(prev.dimmedTaskIds, next.dimmedTaskIds, own)) return false;
  if (!sameValues<unknown>(prev.linkStates, next.linkStates, own)) return false;
  // `ChainState` holds arrays of tasks and a `fileHold` with a file list; `LinkChips` holds
  // arrays of `{key, tone}` — three levels covers both.
  if (!sameShallow(prev.chain, next.chain, 3)) return false;
  if (!sameShallow(prev.linkChips, next.linkChips, 3)) return false;

  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (SPECIAL.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}
