/**
 * **Half-written text survives switching cards.**
 *
 * Every editable field in the detail pane used to be wired the same way: a piece of local
 * state, and an effect that reset it whenever the pane changed task. So glancing at another
 * card — which is most of what a board is for — threw away whatever you were partway
 * through typing, with no warning and no way back. The composer was fixed on its own with a
 * map of drafts kept in a ref; this is that mechanism, made shared, so there is one answer
 * to the question rather than one per field.
 *
 * **Module-level, deliberately.** A ref lives and dies with the component that holds it, and
 * the detail pane is *unmounted* when it is folded away (`MyTasks`), so a ref would lose
 * every draft the moment someone collapsed the pane. The map outlives any component and is
 * scoped to the window: nothing here is written to the database, and a reload starts empty.
 * Drafts are working memory, not saved work.
 *
 * Keys are `${taskId}:${field}` — see {@link draftKey}. A draft belongs to the card it was
 * written for, and to the one field it was written in.
 *
 * The two rules that keep the map honest:
 *  - Only a field the human actually **touched** is parked. Otherwise a background JIRA
 *    sync — which rewrites a card's description under an open pane — would be parked as if
 *    it were something you had typed, and would then be restored *over* the newer text.
 *  - A draft that matches what is already saved is deleted rather than stored: "nothing
 *    typed" and "typed and then undone" are the same state, and keeping the second would
 *    grow the map for ever.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Session-scoped, window-scoped, and never persisted. See the note above. */
const drafts = new Map<string, unknown>();

/** The key a field's draft is parked under: the card it belongs to, then the field. */
export function draftKey(taskId: string, field: string): string {
  return `${taskId}:${field}`;
}

/** Whether a draft is parked for `key` — `has`, not `get`, so a falsy draft still counts. */
export function hasDraft(key: string): boolean {
  return drafts.has(key);
}

/** The parked draft for `key`, or `undefined` if there is none. */
export function readDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}

/**
 * Park `value` under `key`, or drop whatever was parked there when `keep` is false.
 *
 * One function rather than a set and a delete because it is always one decision: a field
 * being left behind either has something worth coming back to or it has not, and the
 * "not" case must actively clear an older draft that has since been saved or abandoned.
 */
export function parkDraft<T>(key: string, value: T, keep: boolean): void {
  if (keep) drafts.set(key, value);
  else drafts.delete(key);
}

/** Forget the draft for `key`, if any. */
export function forgetDraft(key: string): void {
  drafts.delete(key);
}

/** Forget every draft. For tests — nothing in the app clears the whole map. */
export function clearDrafts(): void {
  drafts.clear();
}

/** What {@link useDraft} hands back: the value, a setter, and the two ways an edit ends. */
export interface Draft<T> {
  /** The current text — the draft if there was one, else what is saved. */
  value: T;
  /** Type into it. The first call marks the field touched, which is what makes it a draft. */
  set: (value: T) => void;
  /**
   * The edit was **saved**. Forget the parked copy but leave the field showing what was
   * typed — it is what the card now says, and resetting here would flash the pre-save text
   * back in (the new one has not reached this component as a prop yet).
   */
  commit: () => void;
  /** The edit was **abandoned**: forget the parked copy and put the saved text back. */
  reset: () => void;
}

/**
 * A field whose half-written text survives the pane changing card.
 *
 * Used exactly like `useState`, but keyed: when `key` changes, the outgoing value is parked
 * under the outgoing key and the incoming one is restored (or `initial`, when that card's
 * field has no draft). Pass `null` as the key for "no card" — the field then just tracks
 * `initial` and nothing is parked.
 *
 * `initial` is what is *saved* — the card's description, an empty string for a new step.
 * It is read fresh on every render, so it is also what `reset` puts back and what a draft
 * is compared against to decide whether it is worth keeping.
 *
 * `isUnchanged` decides that comparison for values that are not strings: the composer's
 * value is an object, so identity says nothing and "empty" means no text *and* no files.
 */
export function useDraft<T>(
  key: string | null,
  initial: T,
  isUnchanged: (value: T, initial: T) => boolean = Object.is,
): Draft<T> {
  // Seeded from the map rather than from `initial` so a restored draft is on screen in the
  // first paint, instead of the saved text appearing and being replaced a frame later.
  const [value, setValue] = useState<T>(() =>
    key !== null && drafts.has(key) ? (drafts.get(key) as T) : initial,
  );
  /** Has the human typed into this field since it was last saved, reset, or restored? */
  const touched = useRef(key !== null && drafts.has(key));

  // Mirrors this render's values so the cleanup below can read the LATEST of each. The
  // cleanup closes over the OLD `key` by construction, which is exactly the field the
  // parked draft belongs to.
  const latest = useRef({ value, initial, isUnchanged });
  latest.current = { value, initial, isUnchanged };

  useEffect(() => {
    const restored = key !== null && drafts.has(key);
    touched.current = restored;
    setValue(restored ? (drafts.get(key) as T) : latest.current.initial);
    if (key === null) return;
    return () => {
      const current = latest.current;
      parkDraft(
        key,
        current.value,
        touched.current && !current.isUnchanged(current.value, current.initial),
      );
    };
  }, [key]);

  const set = useCallback((next: T) => {
    touched.current = true;
    setValue(next);
  }, []);

  const commit = useCallback(() => {
    touched.current = false;
    if (key !== null) forgetDraft(key);
  }, [key]);

  const reset = useCallback(() => {
    touched.current = false;
    if (key !== null) forgetDraft(key);
    setValue(latest.current.initial);
  }, [key]);

  return { value, set, commit, reset };
}
