/**
 * `shortcutMatches`'s cases: `mod` matches either Ctrl or Meta; the key compares
 * case-insensitively; an unnamed modifier (Shift, Alt, or an un-requested Ctrl/Meta) must be
 * absent, so Shift+Ctrl+K does not match `"mod+k"` and a bare `k` does not match Ctrl+K either;
 * `isComposing`/`repeat` always suppress a match regardless of the chord; a different key never
 * matches; and `"shift+mod+k"` matches Shift+Ctrl+K, proving exactness runs both directions.
 *
 * `useGlobalShortcut` itself is pure wiring over `window.addEventListener` and is not
 * unit-tested here — this package's vitest config has no jsdom.
 */
import { describe, expect, it } from 'vitest';
import { isEditableTarget, shortcutMatches, type ShortcutEventLike } from './shortcut';

const ev = (partial: Partial<ShortcutEventLike> & { key: string }): ShortcutEventLike => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...partial,
});

describe('shortcutMatches', () => {
  it('matches Ctrl+K against mod+k', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
  });

  it('matches Meta+K against mod+k', () => {
    expect(shortcutMatches(ev({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
  });

  it('matches the key case-insensitively', () => {
    expect(shortcutMatches(ev({ key: 'K', ctrlKey: true }), 'mod+k')).toBe(true);
  });

  it('does not match when Shift is also held', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true, shiftKey: true }), 'mod+k')).toBe(false);
  });

  it('does not match when Alt is also held', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true, altKey: true }), 'mod+k')).toBe(false);
  });

  it('does not match a plain key press with no modifiers', () => {
    expect(shortcutMatches(ev({ key: 'k' }), 'mod+k')).toBe(false);
  });

  it('does not match while composing', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true, isComposing: true }), 'mod+k')).toBe(
      false,
    );
  });

  it('does not match a repeat event', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true, repeat: true }), 'mod+k')).toBe(false);
  });

  it('does not match a different key', () => {
    expect(shortcutMatches(ev({ key: 'j', ctrlKey: true }), 'mod+k')).toBe(false);
  });

  it('matches shift+mod+k against Shift+Ctrl+K, exactly', () => {
    expect(shortcutMatches(ev({ key: 'k', ctrlKey: true, shiftKey: true }), 'shift+mod+k')).toBe(
      true,
    );
  });

  it('matches a bare slash against "/"', () => {
    expect(shortcutMatches(ev({ key: '/' }), '/')).toBe(true);
  });
});

describe('isEditableTarget', () => {
  it('is false for null and undefined', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });

  it('is false for a plain element like a DIV', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('is true for a %s', (tagName) => {
    expect(isEditableTarget({ tagName })).toBe(true);
  });

  it('is true for a contentEditable element regardless of tag name', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
});
