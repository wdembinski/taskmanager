/**
 * Renderer-only presentation constants: the colours, the mono stack, and the font-size
 * scale. Everything here is about how the app *looks*, never about what anything means.
 *
 * It exists because the palette had spread across eight files — the card owned four issue
 * colours and a chip green, the shell owned the status blue, `main.tsx` owned the body
 * grey — so "make the green dot readable" meant finding which of them was lying. One
 * import site, one place to change.
 *
 * What deliberately stays OUT: `STATUS_COLOR`/`STATUS_LABEL` (`taskStatus.ts`),
 * `priorityColor` (`@shared/priority`) and `statusNoteColor` (`@shared/statusKeywords`).
 * Those map a *value* to a colour — they are behaviour, they are shared with the main
 * process, and they are tested. Moving them here would trade a tested mapping for a
 * bag of hex.
 */
import { tokens, type Theme } from '@fluentui/react-components';
import { UNREAD_ORANGE } from '@shared/accent';

/**
 * The mono stack, written out in a dozen `makeStyles` blocks before this existed.
 * Not `tokens.fontFamilyMonospace`: Fluent's stack leads with Consolas on every platform,
 * and `ui-monospace` is what picks up the OS's own UI mono first.
 */
export const MONO = 'ui-monospace, Consolas, monospace';

export const ACCENT = {
  /** "This wants you." The one warm colour on a cool board. */
  unread: UNREAD_ORANGE,
  /** Text laid on {@link ACCENT.unread} — near-black, ~8.6:1 against it. */
  unreadInk: '#1b1b1b',
  /** The status bar's resting fill, borrowed from the editor's own. */
  statusBlue: '#007ACC',
  /** JIRA label chips. */
  chipGreen: '#12836b',

  bugRed: '#E5484D',
  featureBlue: '#0091FF',
  storyGreen: '#30A46C',
  epicPurple: '#8E4EC6',

  /**
   * The live/dead dot in the status bar.
   *
   * NOT `tokens.colorPaletteGreenBackground3` (#0e700e), which was the bug: at ~1.6:1
   * against the status bar's blue and ~3.2:1 against its orange, the dot was invisible on
   * both of the only two backgrounds it is ever drawn on. These are picked to read on
   * either, and the dot carries a dark ring so it separates from both regardless.
   */
  liveGreen: '#3FB950',
  liveRed: '#F85149',
} as const;

/**
 * Code surfaces in agent output — inline spans and fenced blocks.
 *
 * A dark BLUE rather than `colorNeutralBackground4`'s near-black: against the pane's own
 * dark grey a neutral code background is almost invisible, so inline code read as
 * ordinary prose and a fenced block had no edge of its own. A slight hue shift separates
 * "this is code" from "this is text" without adding a border to every span.
 */
export const CODE_BG = '#16202e';
export const CODE_INLINE_BG = '#1d2a3a';
export const CODE_BORDER = '#26364a';

/** Ring widths, so the card's two states can't drift apart. */
export const RING = { attention: 3, selected: 2 } as const;

/**
 * A px size that follows the user's font-size setting.
 *
 * The app hardcodes sizes in `makeStyles` in about a dozen places, and Fluent's tokens
 * can't reach those. `--app-font-scale` is stamped on the provider root next to the
 * scaled theme, so `fontPx(12)` and a `Caption1` grow together.
 *
 * This works only because there is NO Griffel build-time plugin in this repo
 * (`electron.vite.config.ts` renderer plugins are `[react()]`), so `makeStyles` runs at
 * runtime and accepts a computed value. Adding the plugin later would break every call.
 */
export const fontPx = (px: number): string => `calc(${px}px * var(--app-font-scale, 1))`;

/** Fluent's own base size; a setting of 14 must be a no-op. */
export const BASE_FONT_PX = 14;

/** The sizes offered in Settings. Discrete, so the setting saves once rather than per pixel. */
export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18] as const;

/**
 * Every Fluent typography token, and the line height that belongs to each.
 *
 * Listed explicitly rather than filtered by name because line heights and font sizes must
 * scale by the same factor to stay legible — pairing them here makes that impossible to
 * get half-right.
 */
const TYPE_RAMP: ReadonlyArray<[fontSize: keyof Theme, lineHeight: keyof Theme]> = [
  ['fontSizeBase100', 'lineHeightBase100'],
  ['fontSizeBase200', 'lineHeightBase200'],
  ['fontSizeBase300', 'lineHeightBase300'],
  ['fontSizeBase400', 'lineHeightBase400'],
  ['fontSizeBase500', 'lineHeightBase500'],
  ['fontSizeBase600', 'lineHeightBase600'],
  ['fontSizeHero700', 'lineHeightHero700'],
  ['fontSizeHero800', 'lineHeightHero800'],
  ['fontSizeHero900', 'lineHeightHero900'],
  ['fontSizeHero1000', 'lineHeightHero1000'],
];

/** `"14px"` → `14`; anything unparseable returns null so the token is left alone. */
function pxValue(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The theme with its whole type ramp multiplied by `basePx / 14`.
 *
 * Fluent emits these tokens as CSS custom properties on the provider root, so scaling
 * them here reaches every `Text`, `Button`, `Field`, `Dropdown` and `Badge` in the app
 * without touching a single component. It does NOT reach sizes written as literal px in
 * `makeStyles` — those need {@link fontPx}, and there is a list of them in the Phase 17
 * plan because missing one makes the setting look broken rather than partial.
 */
export function scaleTheme(base: Theme, basePx: number): Theme {
  const factor = basePx / BASE_FONT_PX;
  if (factor === 1) return base;
  // Written through a string-keyed view: assigning to `theme[k]` where `k` is a UNION of
  // keys narrows the write type to their intersection, which for `Theme` is `never`.
  const scaled = { ...base } as unknown as Record<string, string>;
  for (const key of TYPE_RAMP.flat()) {
    const px = pxValue(base[key]);
    if (px !== null) scaled[key] = `${Math.round(px * factor)}px`;
  }
  return scaled as unknown as Theme;
}

/** The single `<Toaster>`'s id. Shared so any screen can dispatch into the same surface. */
export const TOASTER_ID = 'app-toaster';

/**
 * The tint an "attention" row takes instead of a border.
 *
 * A literal rather than a computed alpha because {@link ACCENT.unread} is a hex string
 * and Griffel does no colour maths. Used by both the card's merge-request rows and the
 * detail pane's — the two must match or the same MR looks like two different states.
 */
export const ATTENTION_TINT = 'rgba(242, 169, 0, 0.13)';

/** A subtle hairline between a card's sections. Re-exported so the value is stated once. */
export const sectionRule = (): string => `1px solid ${tokens.colorNeutralStroke2}`;
