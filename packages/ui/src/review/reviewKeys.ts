/**
 * The review workspace's own bare-letter keyboard shortcuts — `n`/`p`/`j`/`k`/`v`/`s`/`e`/`c`/`a`/
 * `?` plus `Escape` — kept as a pure function the same reason `reviewState.ts`'s own transitions are:
 * no DOM test harness here, so a key map worth trusting has to be provable as a plain function
 * from an event-like object to an action, not a `keydown` handler buried in a component.
 *
 * `reviewKeyAction`'s guard order is deliberate, not incidental. `isComposing`/`repeat` are
 * checked first and always return `null`, matching `shortcutMatches`'s own guard. Then, while
 * `ctx.editorOpen`, only `Escape` does anything — checked *before* `isEditableTarget`, not after,
 * because the comment editor's own textarea (`CommentThread.tsx`) already lets Escape close it
 * from inside, and Escape must still close it when focus has moved to some other, non-editable
 * element while the editor is logically still open. Only once the editor is closed does
 * `isEditableTarget` gate everything else, so typing `v` into some other field never fires
 * `toggleViewed`. Letters go through `shortcutMatches`, which already requires Shift to be
 * absent for a bare letter spec — deliberately not given `?`'s own exception, since `evt.key`
 * is already the shifted character by the time it reaches here.
 *
 * `applyReviewKey` only handles the five actions a pure state machine can: `'toggleLayout'`,
 * `'expandContext'`, `'comment'`, `'askAi'` and `'showKeys'` each need something only the host
 * component has (a per-viewer layout setting, a specific gap/anchor, a focused textarea, the
 * transport, a dialog) — F15.14 reads `reviewKeyAction`'s result directly for those instead of
 * calling this.
 */
import {
  isEditableTarget,
  shortcutMatches,
  type EditableTargetLike,
  type ShortcutEventLike,
} from '../palette/shortcut';
import type { KeyboardShortcutItem } from '../palette/KeyboardShortcutsList';
import {
  closeEditor,
  nextFile,
  nextHunk,
  prevFile,
  prevHunk,
  toggleViewedAndAdvance,
  type ReviewState,
} from './reviewState';

/** A structural subset of `KeyboardEvent` with the one extra field `reviewKeyAction` needs that
 *  `ShortcutEventLike` does not: the target, to apply `isEditableTarget` to. */
export interface ReviewKeyEventLike extends ShortcutEventLike {
  target?: EditableTargetLike | null;
}

export interface ReviewKeyContext {
  /** Whether the comment editor is currently open — see the header comment for why this gates
   *  everything before `isEditableTarget` even gets a look. */
  editorOpen: boolean;
}

export type ReviewKeyAction =
  | 'nextFile'
  | 'prevFile'
  | 'nextHunk'
  | 'prevHunk'
  | 'toggleViewed'
  | 'toggleLayout'
  | 'expandContext'
  | 'comment'
  | 'askAi'
  | 'showKeys'
  | 'escape';

const LETTER_ACTIONS: ReadonlyArray<readonly [string, ReviewKeyAction]> = [
  ['n', 'nextFile'],
  ['p', 'prevFile'],
  ['j', 'nextHunk'],
  ['k', 'prevHunk'],
  ['v', 'toggleViewed'],
  ['s', 'toggleLayout'],
  ['e', 'expandContext'],
  ['c', 'comment'],
  ['a', 'askAi'],
];

/** The action `evt` names under `ctx`, or `null` when it names none. See the header comment for
 *  the guard order — it is the point of this function, not an implementation detail. */
export function reviewKeyAction(
  evt: ReviewKeyEventLike,
  ctx: ReviewKeyContext,
): ReviewKeyAction | null {
  if (evt.isComposing || evt.repeat) return null;
  if (ctx.editorOpen) return evt.key === 'Escape' ? 'escape' : null;
  if (isEditableTarget(evt.target)) return null;
  if (evt.ctrlKey || evt.metaKey || evt.altKey) return null;
  if (evt.key === '?') return 'showKeys';
  for (const [letter, action] of LETTER_ACTIONS) {
    if (shortcutMatches(evt, letter)) return action;
  }
  if (evt.key === 'Escape') return 'escape';
  return null;
}

/**
 * Applies `action` to `s`. `'toggleLayout'`, `'expandContext'`, `'comment'`, `'askAi'` and
 * `'showKeys'` always return `s` unchanged — see the header comment for why this function has no business
 * handling them.
 */
export function applyReviewKey(s: ReviewState, action: ReviewKeyAction, now: number): ReviewState {
  switch (action) {
    case 'nextFile':
      return nextFile(s);
    case 'prevFile':
      return prevFile(s);
    case 'nextHunk':
      return nextHunk(s);
    case 'prevHunk':
      return prevHunk(s);
    case 'toggleViewed':
      return toggleViewedAndAdvance(s, now);
    case 'escape':
      return s.editor !== null ? closeEditor(s) : s;
    case 'toggleLayout':
    case 'expandContext':
    case 'comment':
    case 'askAi':
    case 'showKeys':
      return s;
  }
}

/**
 * One row per discoverable action, for F15.14's `?` dialog (`<KeyboardShortcutsList items=
 * {REVIEW_KEYS} />`, F9.6's own shape) and for mapping over the command palette's list
 * separately. Deliberately no row for `escape` — the universal close/cancel key, which no other
 * `?`-list or palette table in this codebase lists either.
 */
export const REVIEW_KEYS: readonly KeyboardShortcutItem[] = [
  { id: 'nextFile', label: 'Next file', spec: 'n' },
  { id: 'prevFile', label: 'Previous file', spec: 'p' },
  { id: 'nextHunk', label: 'Next hunk', spec: 'j' },
  { id: 'prevHunk', label: 'Previous hunk', spec: 'k' },
  { id: 'toggleViewed', label: 'Mark viewed', spec: 'v' },
  { id: 'toggleLayout', label: 'Toggle layout', spec: 's' },
  { id: 'expandContext', label: 'Expand context', spec: 'e' },
  { id: 'comment', label: 'Comment', spec: 'c' },
  { id: 'askAi', label: 'Ask AI to review', spec: 'a' },
  { id: 'showKeys', label: 'Show keyboard shortcuts', spec: '?' },
];
