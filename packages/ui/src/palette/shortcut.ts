/**
 * A pure keyboard-shortcut matcher plus the `useGlobalShortcut` hook (F9.2) that wires it to
 * `window`'s `keydown` — the palette (F9.3) and anything else wanting a global chord sit on top
 * of this instead of each hand-rolling modifier logic.
 *
 * `spec` is `+`-joined and case-insensitive, e.g. `"mod+k"` or `"shift+mod+k"`: everything but
 * the last part is a modifier from `mod | ctrl | meta | shift | alt`, the last part is the key.
 * `mod` means "Ctrl or Meta" so the same spec works as Ctrl+K on Windows/Linux and ⌘K on macOS;
 * `ctrl`/`meta` name that exact key instead. Every modifier not named in `spec` must be absent —
 * so `"mod+k"` does not match Shift+Ctrl+K, and callers who want that write `"shift+mod+k"`.
 */
import { useEffect, useRef } from 'react';

/** A structural subset of `KeyboardEvent` so tests can pass plain objects without jsdom. */
export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

/** Whether `evt` is the chord described by `spec`. See the header comment for `spec`'s syntax. */
export function shortcutMatches(evt: ShortcutEventLike, spec: string): boolean {
  if (evt.isComposing || evt.repeat) return false;

  const parts = spec.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));

  if (modifiers.has('mod')) {
    if (!evt.ctrlKey && !evt.metaKey) return false;
  } else {
    if (evt.ctrlKey !== modifiers.has('ctrl')) return false;
    if (evt.metaKey !== modifiers.has('meta')) return false;
  }
  if (evt.shiftKey !== modifiers.has('shift')) return false;
  if (evt.altKey !== modifiers.has('alt')) return false;

  return evt.key.toLowerCase() === key;
}

/**
 * Registers a single `window` `keydown` listener that calls `handler` whenever the event
 * matches `spec`, calling `preventDefault` first — browsers bind Ctrl+K to the address/search
 * bar, so the palette must claim the chord before that fires. Deliberately no "not while
 * focused in an input" guard: firing inside text fields is the point of a ⌘K-style palette.
 *
 * `handler` is read through a ref updated every render, so the listener itself is only
 * re-registered when `spec` changes.
 */
export function useGlobalShortcut(spec: string, handler: (evt: KeyboardEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const onKeyDown = (evt: KeyboardEvent): void => {
      if (!shortcutMatches(evt, spec)) return;
      evt.preventDefault();
      handlerRef.current(evt);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [spec]);
}
