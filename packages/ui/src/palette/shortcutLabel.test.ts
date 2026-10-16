/**
 * `shortcutLabel`'s cases: a `win` whose `navigator.userAgent` names macOS renders symbols
 * (`⌘`, `⇧`, `⌥`, `⌃`) with no separator, matching the platform's own menu convention; any
 * other `win` (including `undefined`, the Electron main-world case) renders words
 * (`Ctrl`, `Shift`, `Alt`) space-joined; a single-character key renders uppercase; a
 * punctuation key like `/` renders as itself; and `mod` resolves per-platform rather than
 * naming Ctrl or ⌘ outright, since it is the same spec `shortcutMatches` accepts.
 */
import { describe, expect, it } from 'vitest';
import { shortcutLabel } from './shortcutLabel';

const macWin = { navigator: { userAgent: 'Macintosh; Intel Mac OS X 10_15_7' } };
const winWin = { navigator: { userAgent: 'Windows NT 10.0; Win64; x64' } };

describe('shortcutLabel', () => {
  it('renders mod+k as Ctrl K off macOS', () => {
    expect(shortcutLabel('mod+k', winWin)).toBe('Ctrl K');
  });

  it('renders mod+k as ⌘K on macOS', () => {
    expect(shortcutLabel('mod+k', macWin)).toBe('⌘K');
  });

  it('treats an undefined win as not macOS', () => {
    expect(shortcutLabel('mod+k', undefined)).toBe('Ctrl K');
  });

  it('renders a bare punctuation key as itself, on every platform', () => {
    expect(shortcutLabel('/', winWin)).toBe('/');
    expect(shortcutLabel('/', macWin)).toBe('/');
  });

  it('renders shift+mod+k as Shift Ctrl K off macOS', () => {
    expect(shortcutLabel('shift+mod+k', winWin)).toBe('Shift Ctrl K');
  });

  it('renders shift+mod+k as ⇧⌘K on macOS', () => {
    expect(shortcutLabel('shift+mod+k', macWin)).toBe('⇧⌘K');
  });

  it('uppercases a single-character key', () => {
    expect(shortcutLabel('mod+j', winWin)).toBe('Ctrl J');
  });
});
