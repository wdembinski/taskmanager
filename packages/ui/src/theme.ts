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
import { makeStaticStyles, tokens, webDarkTheme, type Theme } from '@fluentui/react-components';
import { UNREAD_ORANGE } from '@tm/shared/accent';
import type { PipelineStatus } from '@tm/shared/mergeRequest';
import type { TaskStatus } from '@tm/shared/model';

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
 * **The app's theme** — Fluent dark with softer body text, and the one both hosts mount.
 *
 * It lives here rather than in each `main.tsx` because it was duplicated in both, four
 * tokens at a time, and a four-line copy is exactly the kind that drifts: the desktop
 * window and the browser tab would have gone on rendering the same board in two different
 * greys and nothing would have flagged it. Everything else stays stock Fluent, so contrast
 * ratios for brand/danger/success surfaces are untouched.
 */
export const appDarkTheme: Theme = {
  ...webDarkTheme,
  colorNeutralForeground1: EDITOR_FOREGROUND,
  colorNeutralForeground1Hover: EDITOR_FOREGROUND,
  colorNeutralForeground1Pressed: EDITOR_FOREGROUND,
  colorNeutralForeground1Selected: EDITOR_FOREGROUND,
};

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
 * The high-key palette every *state indicator* is drawn in — dots, glyphs, spinners.
 *
 * Fluent's palette backgrounds (`colorPaletteGreenBackground3` is #0e700e) are meant to sit
 * *behind* text, so as 6px dots on a near-black pane they were barely there: "done" and
 * "pending" differed by a shade of dark. These are picked to read at a glance at that size
 * against `#1f1f1f`, which is the only job they have.
 *
 * Deliberately NOT the issue-type colours in {@link ACCENT} (`bugRed`, `storyGreen`): those
 * say what a card *is*, and are drawn as larger glyphs where Fluent's weights are right.
 * These say what it is *doing*.
 *
 * `pending`, `skipped` and friends stay neutral grey on purpose — "nothing is happening" is
 * information too, and a fluo dot for it would make every idle row shout.
 */
export const FLUO = {
  /** Moving: running, starting, in progress. Also every spinner in the app. */
  cyan: '#22E4FF',
  /**
   * The spinner's *track* — the ring behind the moving arc. Translucent so it sits on
   * whatever surface the spinner lands on.
   */
  cyanDim: 'rgba(34, 228, 255, 0.22)',
  /**
   * The same dark half of the spinner, opaque: roughly {@link FLUO.cyanDim} composited over
   * a card. The trough of the agent glyph's pulse, so a pulsing glyph and a turning spinner
   * are visibly the same two colours rather than two different cyans.
   */
  cyanDeep: '#285258',
  /** Finished well: done, a passed stage. */
  green: '#2BFF88',
  /** Finished badly: failed. */
  red: '#FF4D6A',
  /** Stopped and wants a human: waiting, blocked, a cancelled pipeline. Warm, like the ring. */
  amber: '#FFC53D',
  /** In review — the one column that is neither in flight nor finished. */
  violet: '#C77DFF',
} as const;

/**
 * A task status as an indicator colour — the card's step dots and the step rows' badges.
 *
 * Shared rather than owned by the card, because the two surfaces show the same steps: a
 * step that is amber on the card and orange in the detail pane reads as two states.
 */
export const STATUS_INDICATOR_COLOR: Record<TaskStatus, string> = {
  // Not started, or over and not worth a colour: grey is the honest reading.
  pending: tokens.colorNeutralForeground4,
  stopped: tokens.colorNeutralForeground4,
  cancelled: tokens.colorNeutralForeground4,
  'in-progress': FLUO.cyan,
  running: FLUO.cyan,
  'in-review': FLUO.violet,
  'waiting-input': FLUO.amber,
  'blocked-by-limit': FLUO.amber,
  blocked: FLUO.amber,
  done: FLUO.green,
  failed: FLUO.red,
};

/**
 * A pipeline status as a dot colour.
 *
 * Stated once because three surfaces draw it — the card's MR row, the detail pane's, and
 * now the per-stage row — and a pipeline that is green on the card and grey in the pane
 * looks like two pipelines. Keyed by `PipelineStatus` so a new status cannot be forgotten.
 */
export const PIPELINE_COLOR: Record<PipelineStatus, string> = {
  // Nothing is happening yet, or ever will: grey says that better than a colour would.
  unknown: tokens.colorNeutralForeground4,
  created: tokens.colorNeutralForeground4,
  pending: tokens.colorNeutralForeground4,
  manual: tokens.colorNeutralForeground4,
  skipped: tokens.colorNeutralForeground4,
  running: FLUO.cyan,
  success: FLUO.green,
  failed: FLUO.red,
  canceled: FLUO.amber,
};

/**
 * The commit graph's ink (`GitGraphPane`), and the whole of its colour budget.
 *
 * The graph is a picture of the PAST, and the past does not move: a repository with forty
 * branches in it would, coloured per branch the way `gitk` colours them, put more ink on the
 * screen than the board it sits beside — and every stroke of it would be saying something
 * that had already finished happening. So the lanes, the dots, the refs and the base branch
 * are all monochrome, and exactly one thing on the drawing is allowed a colour: the branch of
 * a card whose agent is **running right now**.
 *
 * That is the same rule the rest of the app is kept to — colour is for things that MOVE (the
 * card's running band, the chain's travelling dash, every spinner) — and it is why this is
 * {@link FLUO.cyan} rather than the brand accent: cyan is already what this app means by
 * "working", so a live branch in the graph and a live card on the board read as one state.
 */
export const GRAPH_INK = {
  /** Every lane at rest, and the border of every dot. */
  line: tokens.colorNeutralStroke2,
  /**
   * The lines a MERGE pulled in — its second and later parents. A step fainter than
   * {@link GRAPH_INK.line}, because a merge's incoming lines are the ones you read past
   * when following a branch down its own lane.
   */
  merge: tokens.colorNeutralStroke3,
  /** A commit's dot. Neutral: every commit in the window is equally over and done with. */
  dot: tokens.colorNeutralForeground3,
  /** The one moving thing — the branch an agent is on this second, and its dot. */
  live: FLUO.cyan,
} as const;

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
 * The one thing that stays behind is `.app-drag`/`.app-no-drag` in the client's `index.css`:
 * `-webkit-app-region` is a frameless-Electron-window mechanism, and meaningless in a tab.
 */
export const useGlobalStyles = makeStaticStyles({
  /*
   * Tell the engine (and native scrollbars/form controls) this is a dark surface,
   * and paint the document background dark. Without a background here the DOM's
   * default is white, which flashes for a frame when the window is restored from the
   * taskbar before Fluent's dark UI repaints. #1f1f1f matches both the Electron
   * window `backgroundColor` and Fluent's colorNeutralBackground2, so restore is
   * seamless.
   */
  ':root': {
    colorScheme: 'dark',
  },
  'html, body, #root': {
    margin: 0,
    padding: 0,
    height: '100%',
    backgroundColor: '#1f1f1f',
  },

  /* The shell never scrolls; inner panes manage their own overflow. */
  body: {
    overflow: 'hidden',
  },

  /**
   * Every spinner in the app, recoloured to {@link FLUO.cyan}.
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
    color: FLUO.cyan,
    backgroundColor: FLUO.cyanDim,
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
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  ':hover::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'rgba(255, 255, 255, 0.42)',
  },
  ':hover::-webkit-scrollbar-thumb:active': {
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
});

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
