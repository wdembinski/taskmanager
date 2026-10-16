/**
 * Renders a `shortcutMatches`/`useGlobalShortcut` spec (see `shortcut.ts`'s header comment for
 * its `+`-joined syntax) as the text the nav rail's palette hint and the Settings shortcuts
 * list show a human. Platform-aware the same way `dictationModel.ts`'s `dictationAvailable`
 * is: sniffed off `win.navigator.userAgent` rather than a build-time flag, since the same
 * bundle runs on whichever OS the browser or packaged Electron renderer is on.
 *
 * macOS renders its own modifier glyphs concatenated with no separator (`⌘K`, `⇧⌘K`) — that
 * platform's own menu convention; everywhere else renders words space-joined (`Ctrl K`,
 * `Shift Ctrl K`), since there is no glyph convention to match.
 */

const MAC_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  shift: '⇧',
  alt: '⌥',
};

const OTHER_WORDS: Record<string, string> = {
  mod: 'Ctrl',
  meta: 'Win',
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
};

function isMac(win: object | undefined): boolean {
  const userAgent = (win as { navigator?: { userAgent?: string } } | undefined)?.navigator
    ?.userAgent;
  return userAgent !== undefined && /Mac OS X|Macintosh/.test(userAgent);
}

/** `spec`'s display form for `win`'s platform — e.g. `shortcutLabel('mod+k', window)`. */
export function shortcutLabel(spec: string, win: object | undefined): string {
  const parts = spec.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;

  if (isMac(win)) {
    return modifiers.map((m) => MAC_SYMBOLS[m] ?? m).join('') + keyLabel;
  }
  return [...modifiers.map((m) => OTHER_WORDS[m] ?? m), keyLabel].join(' ');
}
