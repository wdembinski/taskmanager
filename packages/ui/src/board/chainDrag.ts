/**
 * Drawing a link by dragging — the part of it that is not React.
 *
 * The board already drags cards between columns with native HTML5 DnD, and this reuses
 * that same mechanism rather than adding a second one: no library, no pointer capture, no
 * `mousemove` handler racing the browser's own. What separates the two gestures is the
 * **type** on the `DataTransfer` — {@link CHAIN_LINK_MIME} for a link, `text/plain` for a
 * column move — and that distinction has to be respected in BOTH directions:
 *
 *   - a column must ignore a link drag, or drawing an arrow across a column would also
 *     move the card into it (see `KanbanColumn`);
 *   - a card must ignore a card drag, or dropping a card ON another card would silently
 *     draw a link nobody asked for.
 *
 * `types` rather than `getData` because a `dragover` handler is not allowed to read the
 * payload — the protected mode exists exactly so a page cannot snoop what is being dragged
 * over it — but it CAN see the type list. That is the whole reason the source id travels
 * as its own MIME type instead of as a prefix on `text/plain`.
 *
 * Kept free of React and the DOM so the one thing genuinely worth testing here — which
 * cards accept the drop and which refuse it, over a graph with cycles in it — can be
 * checked without a browser.
 */
import { canLink, type LinkEnd, type TaskLink } from '@tm/shared/taskChain';

/**
 * The `DataTransfer` type a link drag carries, holding the SOURCE card's id.
 *
 * A custom `application/x-…` type, not `text/plain`: a column's existing drop handler
 * reads `text/plain` and would happily move whatever it found there.
 */
export const CHAIN_LINK_MIME = 'application/x-chain-link';

/** Whether the drag currently in the air is a link being drawn rather than a card moving. */
export function isChainLinkDrag(types: readonly string[] | DOMStringList): boolean {
  // `DataTransfer.types` is a real array in Chromium and a `DOMStringList` in the DOM spec;
  // `Array.from` covers both and costs nothing at these lengths.
  return Array.from(types).includes(CHAIN_LINK_MIME);
}

/**
 * What one card would do with the link being dragged.
 *
 * Four states rather than a boolean, because they are four different sentences and the
 * point of showing them DURING the drag is that the answer arrives before you commit:
 *
 *   - `source` — the card the drag started from. Not dimmed: it is not refusing anything,
 *     it is the thing in your hand.
 *   - `valid` — the drop would draw an arrow.
 *   - `linked` — these two are already joined. A different mark from a refusal, because
 *     nothing is wrong: the thing you are trying to say is already said.
 *   - `refused` — a step, or a loop. Dimmed, and the drop bounces.
 */
export type LinkDropState = 'source' | 'valid' | 'linked' | 'refused';

/** The live state of a link being drawn — by drag, or armed from the keyboard. */
export interface LinkDragState {
  /** The card the arrow leaves. */
  fromTaskId: string;
  /** Every card's answer, computed once at the start of the gesture. */
  states: ReadonlyMap<string, LinkDropState>;
  /**
   * Where the pointer is, in board content space — the far end of the rubber band. Null
   * for a keyboard-armed link, which has no pointer, and until the first `dragover`.
   */
  at: { x: number; y: number } | null;
  /**
   * The card the pointer is over, so the band can wear the same verdict that card's own
   * outline does. Read from the DOM by {@link taskIdUnder} rather than reported by each
   * card, which would be one more state update per card per frame for a fact the event
   * already carries.
   */
  overTaskId: string | null;
}

/** The attribute a card's root carries so a drag event can name the card it is over. */
export const TASK_ID_ATTR = 'data-task-id';

/**
 * Which card an event happened over, or null for the gaps between them.
 *
 * `closest` rather than the event's own target: a `dragover` lands on whatever leaf is
 * under the pointer — a title, a step row, a pipeline dot — and the question is always
 * about the card those sit inside.
 */
export function taskIdUnder(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest(`[${TASK_ID_ATTR}]`)?.getAttribute(TASK_ID_ATTR) ?? null;
}

/**
 * Every card's answer to the drop, in one pass.
 *
 * Computed once when the gesture starts rather than per card per `dragover`: `wouldCycle`
 * walks the graph, and asking it thirty times a second for thirty cards would be work done
 * over and over for an answer that cannot change while the pointer is moving.
 *
 * Asked of the shared {@link canLink}, never re-derived — the refusal the main process will
 * give and the one drawn under the pointer have to be the same refusal, or the board
 * promises a link it then refuses to make.
 */
export function linkDropStates(
  links: readonly TaskLink[],
  tasks: readonly LinkEnd[],
  fromTaskId: string,
): Map<string, LinkDropState> {
  const states = new Map<string, LinkDropState>();
  const from = tasks.find((t) => t.id === fromTaskId);
  for (const task of tasks) {
    if (task.id === fromTaskId) {
      states.set(task.id, 'source');
      continue;
    }
    const refusal = canLink(links, from, task);
    states.set(
      task.id,
      refusal === null ? 'valid' : refusal === 'duplicate' ? 'linked' : 'refused',
    );
  }
  return states;
}

/**
 * The `dropEffect` for one state — what the CURSOR says before you let go.
 *
 * `'none'` is not merely cosmetic: a `dragover` that ends with `dropEffect = 'none'`
 * cancels the drop outright, so an invalid target refuses the drag in the browser itself
 * rather than by accepting it and then explaining. It is what makes the refusal visible
 * before you commit, which is the whole reason the states are computed up front.
 */
export function dropEffectFor(state: LinkDropState | undefined): 'link' | 'none' {
  return state === 'valid' ? 'link' : 'none';
}
