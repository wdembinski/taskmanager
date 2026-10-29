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
 * `priorityColor` (`@tm/shared/priority`) and `statusNoteColor` (`@tm/shared/statusKeywords`).
 * Those map a *value* to a colour — they are behaviour, they are shared with the main
 * process, and they are tested. Moving them here would trade a tested mapping for a
 * bag of hex.
 */
import {
  createDarkTheme,
  createLightTheme,
  makeStaticStyles,
  tokens,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components';
import { UNREAD_ORANGE } from '@tm/shared/accent';
import {
  FLUO_VAR,
  SCROLL_THUMB_BY_SCHEME,
  SEMANTIC,
  SYNTAX_BY_SCHEME,
  type ColorScheme,
  type SyntaxTokens,
  type WashTokens,
} from './tokens';

export type { ColorScheme };

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
 * The card's ring width. There is only one ring now — "this card wants you". Selection
 * stopped being a second, blue ring and became a lift in the card's own fill instead (see
 * `TaskCard.cardSelected`), which is why `selected` is gone from here.
 */
export const RING = { attention: 3 } as const;

/**
 * Body text. Fluent's dark theme sets `colorNeutralForeground1` to pure white, which is
 * what a code editor deliberately avoids: at this text density white-on-near-black glares
 * and every word reads as emphasis. The editor grey is the reference the user asked for —
 * headings and semibold text still read as brighter because they gain weight, not
 * luminance.
 */
export const EDITOR_FOREGROUND = '#CCCCCC';

/**
 * Fluent's own 16-step web brand ramp around the app's one brand blue — step 80 is
 * `#0F6CBD` (`SEMANTIC.light.brand`), step 160 is `#EBF3FC` (`SEMANTIC.light.selectedTint`).
 * `createLightTheme`/`createDarkTheme` derive every brand-coloured Fluent token
 * (`colorBrandBackground`, `colorCompoundBrandStroke`, …) from this one ramp.
 */
export const BRAND_RAMP: BrandVariants = {
  10: '#061724',
  20: '#082338',
  30: '#0A2E4A',
  40: '#0C3B5E',
  50: '#0E4775',
  60: '#0F548C',
  70: '#115EA3',
  80: '#0F6CBD',
  90: '#2886DE',
  100: '#479EF5',
  110: '#62ABF5',
  120: '#77B7F7',
  130: '#96C6FA',
  140: '#B4D6FA',
  150: '#CFE4FA',
  160: '#EBF3FC',
};

/**
 * **The light theme** — Fluent's generated light theme, with the neutral background and
 * foreground tokens pulled from `SEMANTIC.light` so a Fluent `Button` and a bare
 * `makeStyles` div agree about what "canvas" and "text" mean. Everything else (brand,
 * danger, success surfaces) stays stock Fluent, generated from {@link BRAND_RAMP}.
 */
export const appLightTheme: Theme = {
  ...createLightTheme(BRAND_RAMP),
  colorNeutralBackground1: SEMANTIC.light.paneOpaque,
  colorNeutralBackground2: SEMANTIC.light.canvas,
  colorNeutralForeground1: SEMANTIC.light.text,
  colorNeutralForeground1Hover: SEMANTIC.light.text,
  colorNeutralForeground1Pressed: SEMANTIC.light.text,
  colorNeutralForeground1Selected: SEMANTIC.light.text,
  colorNeutralForeground2: SEMANTIC.light.textMuted,
  colorNeutralForeground4: SEMANTIC.light.textFaint,
  // Fluent's generated value already lands on ramp step 80 (= SEMANTIC.light.brand), so this
  // is a no-op in light — pinned explicitly anyway so a selected `Tab`'s indicator (NavRail,
  // F13.8) never drifts from `--tm-brand` if the ramp changes.
  colorCompoundBrandStroke: SEMANTIC.light.brand,
};

/**
 * **The dark theme** — Fluent's generated dark theme (from the same {@link BRAND_RAMP}),
 * with the neutral background and foreground tokens pulled from `SEMANTIC.dark`, except
 * `colorNeutralForeground1` (+ Hover/Pressed/Selected): it stays {@link EDITOR_FOREGROUND}
 * rather than `SEMANTIC.dark.text`. Fluent's generated dark theme sets body text to pure
 * white, which is what a code editor deliberately avoids: at this text density
 * white-on-near-black glares and every word reads as emphasis. The editor grey is the
 * reference the user asked for, and it predates the token table — so it wins here on
 * purpose, not by oversight (`tokens.test.ts` asserts it).
 */
export const appDarkTheme: Theme = {
  ...createDarkTheme(BRAND_RAMP),
  colorNeutralBackground1: SEMANTIC.dark.paneOpaque,
  colorNeutralBackground2: SEMANTIC.dark.canvas,
  colorNeutralForeground1: EDITOR_FOREGROUND,
  colorNeutralForeground1Hover: EDITOR_FOREGROUND,
  colorNeutralForeground1Pressed: EDITOR_FOREGROUND,
  colorNeutralForeground1Selected: EDITOR_FOREGROUND,
  colorNeutralForeground2: SEMANTIC.dark.textMuted,
  colorNeutralForeground4: SEMANTIC.dark.textFaint,
  // Unlike light, Fluent's generated dark value does NOT land on SEMANTIC.dark.brand — pinned
  // so a selected `Tab`'s indicator (NavRail, F13.8) reads the one documented brand blue.
  colorCompoundBrandStroke: SEMANTIC.dark.brand,
};

/** The theme for a resolved scheme — the one seam F13.4 mounts through. */
export function themeFor(scheme: ColorScheme): Theme {
  return scheme === 'light' ? appLightTheme : appDarkTheme;
}

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

/**
 * The document's backdrop for a given scheme — what a consumer that cannot read the
 * `--tm-page-bg` custom property {@link useGlobalStyles} stamps on `:root` should paint
 * instead. Matches `SEMANTIC[scheme].canvas` — the same canvas `tokenCssVars` and
 * `useGlobalStyles` paint from.
 *
 * Neither of the two consumers this was written for calls it any more, and both for the
 * same reason — a package built on `@fluentui/react-components` has no business in either.
 * The Electron window's own `backgroundColor` (`main/index.ts`) reads `WINDOW_CANVAS`
 * (`@shared/canvas`) directly, since the main process has no Fluent and no DOM; `apps/web`'s
 * manifest/`index.html` (`manifest.test.ts`) read `SEMANTIC` directly for the same reason a
 * static JSON file and a static `<meta>` always could have. Kept as the named value for
 * `SEMANTIC[scheme].canvas` on the renderer side of that line, where `@tm/ui` is already in
 * scope.
 */
export function pageBackground(scheme: ColorScheme): string {
  return SEMANTIC[scheme].canvas;
}

/**
 * The static two-haze backdrop behind every pane — top-left and bottom-right, same shape in
 * both schemes, never animated. A CSS approximation of the mockups' blurred circles
 * (`filter="url(#soft)"`, a 90px Gaussian blur): a wide, soft-edged radial fade reads the same
 * as a blurred circle at the sizes either ever appears at, without asking every document that
 * mounts this hook to carry an SVG filter.
 */
function washGradient(wash: WashTokens): string {
  return (
    `radial-gradient(60% 60% at 8% 10%, ${wash.a}, transparent 70%), ` +
    `radial-gradient(60% 60% at 95% 92%, ${wash.b}, transparent 70%)`
  );
}

/** The custom properties `useGlobalStyles` stamps on `:root` for one scheme. */
function schemeVars(scheme: ColorScheme): Record<string, string> {
  const semantic = SEMANTIC[scheme];
  const thumb = SCROLL_THUMB_BY_SCHEME[scheme];
  const syntax = SYNTAX_BY_SCHEME[scheme];
  return {
    '--tm-page-bg': semantic.canvas,
    '--tm-scrim': semantic.scrim,
    '--tm-page-wash': washGradient(semantic.wash),
    '--tm-thumb': thumb.visible,
    '--tm-thumb-hover': thumb.hover,
    '--tm-thumb-active': thumb.active,
    '--tm-syntax-keyword': syntax.keyword,
    '--tm-syntax-string': syntax.string,
    '--tm-syntax-comment': syntax.comment,
    '--tm-syntax-number': syntax.number,
    '--tm-syntax-title': syntax.title,
  };
}

/**
 * Everything about the app looking like *this app*, at the document level.
 *
 * Here rather than in either host's `index.css` because both hosts want the identical thing
 * and neither may change it alone: the desktop renderer and the browser tab are the same
 * product, and a scrollbar or a page background that drifts between them is the drift this
 * package exists to stop. Both entry points already call this hook — see
 * `apps/client/src/renderer/src/main.tsx` and `apps/web/src/main.tsx` — so the rules land
 * wherever the shell is mounted.
 *
 * Keyed on `data-scheme` rather than a media query: the scheme here is the user's *resolved*
 * appearance setting, not a raw OS preference, and `applyDocumentAppearance` (`appearance.ts`)
 * is the one place that gets written. No attribute at all — a pre-hydration frame, or a host
 * that forgot to call it — defaults to dark, so an existing install never flashes white before
 * its own script runs.
 *
 * The one thing that stays behind is `.app-drag`/`.app-no-drag` in the client's `index.css`:
 * `-webkit-app-region` is a frameless-Electron-window mechanism, and meaningless in a tab.
 */
export const useGlobalStyles = makeStaticStyles([
  {
    ':root': {
      colorScheme: 'dark',
      ...schemeVars('dark'),
    },
    ':root[data-scheme="light"]': {
      colorScheme: 'light',
      ...schemeVars('light'),
    },
    'html, body, #root': {
      margin: 0,
      padding: 0,
      height: '100%',
      /* The wash is a background-IMAGE layer; if the custom property it reads is ever unset
       this whole declaration is dropped as invalid, which is exactly why backgroundColor is
       stated again below rather than folded into this one shorthand — the canvas still has
       to paint even when the wash does not. */
      background: 'var(--tm-page-wash), var(--tm-page-bg)',
      backgroundColor: 'var(--tm-page-bg)',
    },

    /**
     * `glass: 'native'` (F13.7): the OS material — Mica or Acrylic — paints the canvas
     * (`main/index.ts`'s transparent `backgroundColor` is what lets it through), so no canvas
     * COLOUR is painted anywhere: `html` and `body` go fully transparent. The wash still
     * belongs on top of it — the v9/v10 mockups draw the haze over Mica too — and it is
     * already translucent, so it is laid over the material exactly once, as an image only, on
     * `#root`. Painting it on all three (as the rule above does for the other modes, where
     * the opaque canvas underneath hides the stacking) would triple it over the material.
     */
    ':root[data-glass="native"], :root[data-glass="native"] body': {
      background: 'transparent',
      backgroundColor: 'transparent',
    },
    ':root[data-glass="native"] #root': {
      background: 'var(--tm-page-wash)',
      backgroundColor: 'transparent',
    },
    /**
     * The provider root, in EVERY mode. Fluent's own `useFluentProviderStyles` paints
     * `colorNeutralBackground1` as an opaque fill on it, right on top of `#root` — under
     * `native` that hid the OS material, and under `css`/`opaque` it hid the wash just as
     * completely, which is why every screen read as a flat canvas. The canvas and the wash
     * live on `#root` underneath (above), so the provider has nothing of its own to paint.
     * Panes keep painting `paneGlass`/`paneOpaque` over this unchanged (`GlassPane.tsx`).
     *
     * `:root` is load-bearing, not decoration: this sheet is inserted before the provider's
     * atomic class, in the same Griffel bucket, so at equal specificity Fluent's later rule
     * would win (`canvasWash.render.test.tsx`).
     */
    ':root .fui-FluentProvider': {
      backgroundColor: 'transparent',
    },

    /* The shell never scrolls; inner panes manage their own overflow. */
    body: {
      overflow: 'hidden',
    },

    /**
     * Every spinner in the app, recoloured to {@link FLUO_VAR.cyan}.
     *
     * Global rather than per-component because a spinner means one thing wherever it appears —
     * "this is moving right now" — and there are a dozen of them; a per-component version would
     * have to be remembered at each new one. Fluent's own is `colorBrandStroke1`, a mid blue that
     * at `extra-tiny` (16px, the size the board uses) is hard to pick out of the grey it spins
     * against.
     *
     * Written here rather than in `index.css` so the colour has ONE definition: the agent glyph
     * animates in the same two values, and a third hardcoded copy of a hex is a colour that
     * drifts — the thing `accent.ts` exists to prevent.
     *
     * Both properties are needed and it is not obvious why: Fluent paints the moving arc as a
     * conic-gradient off `currentcolor` on the tail's pseudo-elements, so `color` is the arc,
     * and `background-color` is the track behind it.
     */
    '.fui-Spinner__spinnerTail': {
      color: FLUO_VAR.cyan,
      backgroundColor: FLUO_VAR.cyanDim,
    },

    /*
     * Scrollbars: thin, rounded, no track, no arrows — and invisible until you are actually
     * over the thing that scrolls.
     *
     * Done globally rather than per-pane because every scrolling surface in the app wants the
     * same treatment, and a `makeStyles` version would have to be remembered at each new one.
     *
     * The thumb fades on hover of the SCROLLING ELEMENT, not of the scrollbar: a 8px target
     * you must already be touching to make visible is not a target. `:hover` on the element
     * and a transition on the thumb is the whole mechanism — Chromium animates
     * `::-webkit-scrollbar-thumb` background like any other property.
     *
     * `scrollbar-gutter: stable` keeps the fade from reflowing text: without it the content
     * would shift by the scrollbar's width every time the pointer entered a pane.
     */
    '*': {
      scrollbarWidth: 'thin',
      scrollbarColor: 'transparent transparent',
    },
    '*::-webkit-scrollbar': {
      width: '8px',
      height: '8px',
    },
    '*::-webkit-scrollbar-track, *::-webkit-scrollbar-corner': {
      background: 'transparent',
    },
    '*::-webkit-scrollbar-thumb': {
      backgroundColor: 'transparent',
      borderRadius: '4px',
      /* Inset by a transparent border so the visible thumb is 6px inside an 8px lane. */
      border: '1px solid transparent',
      backgroundClip: 'padding-box',
      transition: 'background-color 160ms ease-in-out',
    },
    /* Chromium has no arrow buttons by default, but a stray platform theme can add them. */
    '*::-webkit-scrollbar-button': {
      display: 'none',
      width: 0,
      height: 0,
    },
    ':hover::-webkit-scrollbar-thumb': {
      backgroundColor: 'var(--tm-thumb)',
    },
    ':hover::-webkit-scrollbar-thumb:hover': {
      backgroundColor: 'var(--tm-thumb-hover)',
    },
    ':hover::-webkit-scrollbar-thumb:active': {
      backgroundColor: 'var(--tm-thumb-active)',
    },
  },
  /* High contrast paints the system canvas only: drop the wash outright rather than trust
     the UA to discard a gradient image. (A string because Griffel's object form for static
     styles cannot nest a selector inside an at-rule.) The native `#root` selector is repeated
     so this rule matches the native wash rule's specificity and, coming later, beats it. */
  '@media (forced-colors: active) { html, body, #root, :root[data-glass="native"] #root { background-image: none; } }',
]);

/** The single `<Toaster>`'s id. Shared so any screen can dispatch into the same surface. */
export const TOASTER_ID = 'app-toaster';

/** A subtle hairline between a card's sections. Re-exported so the value is stated once. */
export const sectionRule = (): string => `1px solid ${tokens.colorNeutralStroke2}`;

/**
 * {@link SyntaxTokens}, but every value is a `var(--tm-syntax-*)` reference into whichever
 * scheme's `schemeVars` is currently stamped on `:root`, rather than a literal resolved once
 * in JS for one scheme — the same `FLUO_VAR` (`tokens.ts`) already does for the status dots.
 * `DiffView` reads `SYNTAX.keyword` etc. so a highlighted span tracks an appearance change
 * for free, and the component itself never imports a hex.
 */
export const SYNTAX: SyntaxTokens = {
  keyword: 'var(--tm-syntax-keyword)',
  string: 'var(--tm-syntax-string)',
  comment: 'var(--tm-syntax-comment)',
  number: 'var(--tm-syntax-number)',
  title: 'var(--tm-syntax-title)',
};
