/**
 * Semantic design tokens — the light and dark value for every role the shell paints,
 * from the v9 mockups (`docs/plan/feature-roadmap/F13-design-system-and-shell.md`'s token
 * table). Components ask for a role (`SEMANTIC[scheme].text`), never a hex; `theme.ts`
 * builds the two Fluent themes from the same table, so a Fluent `Button` and a bare
 * `makeStyles` div never disagree about what "text" means.
 *
 * Deliberately has no import from `theme.ts` — `theme.ts` imports this instead — so there
 * is no cycle between the two.
 */
import { tokens } from '@fluentui/react-components';
import { UNREAD_ORANGE } from '@tm/shared/accent';
import type { PipelineStatus } from '@tm/shared/mergeRequest';
import type { TaskStatus } from '@tm/shared/model';

export type ColorScheme = 'light' | 'dark';

export interface WashTokens {
  /** The top-left haze. */
  a: string;
  /** The bottom-right haze. */
  b: string;
}

export interface PaneRimTokens {
  /** The 1px inset highlight that stands in for a pane's border. */
  rim: string;
  /** The top sheen's start colour, fading to {@link PaneRimTokens.sheenTo}. */
  sheenFrom: string;
  sheenTo: string;
}

export interface RunTokens {
  /** Text/glyph colour for "a step is running right now". */
  ink: string;
  /** The pill behind {@link RunTokens.ink}. */
  pill: string;
}

export interface SemanticTokens {
  /** The window behind everything. */
  canvas: string;
  /** Two static hazes under a 90px blur; never animated. */
  wash: WashTokens;
  /** Every pane, with `backdrop-filter: blur(24px)` — near-opaque, a hint of frost only. */
  paneGlass: string;
  /** The same pane when glass is off (no `backdrop-filter` support, or reduced transparency). */
  paneOpaque: string;
  paneRim: PaneRimTokens;
  /** A full `box-shadow` value, taken straight from the mockups' `feDropShadow`s. */
  paneShadow: string;
  text: string;
  textMuted: string;
  textFaint: string;
  /** The one brand blue. */
  brand: string;
  /** The selected row's fill. */
  selectedTint: string;
  /** The selected row's left bar. */
  accentBar: string;
  /** `linear-gradient(90deg, …)` across {@link SemanticTokens.statusGradientStops}. */
  statusGradient: string;
  /** The three stops behind {@link SemanticTokens.statusGradient}, for F13.2's contrast pairs. */
  statusGradientStops: readonly [string, string, string];
  /** The status bar's fill when anything waits on a human; see open question 1. */
  attention: string;
  /** Text/glyph colour on {@link SemanticTokens.attention}. */
  attentionInk: string;
  run: RunTokens;
  mono: string;
  sans: string;
}

export const SEMANTIC: Record<ColorScheme, SemanticTokens> = {
  light: {
    canvas: '#F7F8FA',
    wash: {
      a: 'rgba(212, 228, 245, 0.45)',
      b: 'rgba(226, 224, 244, 0.35)',
    },
    paneGlass: 'rgba(255, 255, 255, 0.86)',
    paneOpaque: '#FFFFFF',
    paneRim: {
      rim: 'rgba(17, 24, 39, 0.08)',
      sheenFrom: 'rgba(255, 255, 255, 0.7)',
      sheenTo: 'rgba(255, 255, 255, 0)',
    },
    paneShadow: '0 1px 2px rgba(17, 24, 39, 0.05), 0 6px 20px rgba(17, 24, 39, 0.07)',
    text: '#1B1D21',
    textMuted: '#454B54',
    textFaint: '#646B74',
    brand: '#0F6CBD',
    selectedTint: '#EBF3FC',
    accentBar: '#0F6CBD',
    statusGradient: 'linear-gradient(90deg, #0F6CBD, #2A72CA, #5260D3)',
    statusGradientStops: ['#0F6CBD', '#2A72CA', '#5260D3'],
    attention: UNREAD_ORANGE,
    attentionInk: '#1b1b1b',
    run: {
      ink: '#07748C',
      pill: '#E6FAFE',
    },
    mono: 'Cascadia Code, JetBrains Mono, Consolas',
    sans: 'Segoe UI Variable Text, Segoe UI, Inter, system-ui',
  },
  dark: {
    canvas: '#202326',
    wash: {
      a: 'rgba(18, 58, 99, 0.45)',
      b: 'rgba(43, 37, 89, 0.4)',
    },
    paneGlass: 'rgba(26, 28, 32, 0.86)',
    paneOpaque: '#1A1C1F',
    paneRim: {
      rim: 'rgba(255, 255, 255, 0.08)',
      sheenFrom: 'rgba(255, 255, 255, 0.08)',
      sheenTo: 'rgba(255, 255, 255, 0)',
    },
    paneShadow: '0 1px 2px rgba(0, 0, 0, 0.30), 0 6px 20px rgba(0, 0, 0, 0.45)',
    text: '#E8EAED',
    textMuted: '#BAC0C7',
    textFaint: '#8A929B',
    brand: '#4FA3E8',
    selectedTint: '#1D2B38',
    accentBar: '#4FA3E8',
    statusGradient: 'linear-gradient(90deg, #0F6CBD, #2A72CA, #5260D3)',
    statusGradientStops: ['#0F6CBD', '#2A72CA', '#5260D3'],
    attention: UNREAD_ORANGE,
    attentionInk: '#1b1b1b',
    run: {
      ink: '#22E4FF',
      pill: 'rgba(34, 228, 255, 0.12)',
    },
    mono: 'Cascadia Code, JetBrains Mono, Consolas',
    sans: 'Segoe UI Variable Text, Segoe UI, Inter, system-ui',
  },
};

export interface FluoPalette {
  /** Moving: running, starting, in progress. Also every spinner in the app. */
  cyan: string;
  /** The spinner's track — the ring behind the moving arc. */
  cyanDim: string;
  /** The spinner's dark half, opaque. */
  cyanDeep: string;
  /** Finished well: done, a passed stage. */
  green: string;
  /** Finished badly: failed. */
  red: string;
  /** Stopped and wants a human: waiting, blocked, a cancelled pipeline. */
  amber: string;
  /** In review — the one column that is neither in flight nor finished. */
  violet: string;
}

/**
 * The high-key indicator palette, per scheme. Dark is today's `FLUO` from `theme.ts`,
 * moved here unchanged.
 */
export const FLUO_BY_SCHEME: Record<ColorScheme, FluoPalette> = {
  light: {
    cyan: '#07748C',
    cyanDim: 'rgba(7, 116, 140, 0.20)',
    cyanDeep: '#8FD3E0',
    green: '#1A7F37',
    red: '#CF222E',
    amber: '#B7791F',
    violet: '#8250DF',
  },
  dark: {
    cyan: '#22E4FF',
    cyanDim: 'rgba(34, 228, 255, 0.22)',
    cyanDeep: '#285258',
    green: '#2BFF88',
    red: '#FF4D6A',
    amber: '#FFC53D',
    violet: '#C77DFF',
  },
};

export interface CodeSurfaceTokens {
  bg: string;
  inlineBg: string;
  border: string;
}

export const CODE_BY_SCHEME: Record<ColorScheme, CodeSurfaceTokens> = {
  light: {
    bg: '#F3F6FA',
    inlineBg: '#EAF0F7',
    border: '#D6DEE8',
  },
  dark: {
    bg: '#16202e',
    inlineBg: '#1d2a3a',
    border: '#26364a',
  },
};

export const ATTENTION_TINT_BY_SCHEME: Record<ColorScheme, string> = {
  light: 'rgba(242, 169, 0, 0.16)',
  dark: 'rgba(242, 169, 0, 0.13)',
};

export interface ScrollThumbTokens {
  /** The thumb while the scrolling element itself is hovered. */
  visible: string;
  /** The thumb while the thumb itself is hovered. */
  hover: string;
  /** The thumb while being dragged. */
  active: string;
}

/** Today's three white alphas for dark, moved here unchanged; black alphas for light. */
export const SCROLL_THUMB_BY_SCHEME: Record<ColorScheme, ScrollThumbTokens> = {
  light: {
    visible: 'rgba(0, 0, 0, 0.25)',
    hover: 'rgba(0, 0, 0, 0.42)',
    active: 'rgba(0, 0, 0, 0.55)',
  },
  dark: {
    visible: 'rgba(255, 255, 255, 0.25)',
    hover: 'rgba(255, 255, 255, 0.42)',
    active: 'rgba(255, 255, 255, 0.55)',
  },
};

/**
 * A task status as an indicator colour, for the given scheme. See `theme.ts`'s
 * `STATUS_INDICATOR_COLOR` (the dark entries, kept under their current name for existing
 * callers).
 */
export function statusIndicatorColor(scheme: ColorScheme): Record<TaskStatus, string> {
  const fluo = FLUO_BY_SCHEME[scheme];
  return {
    pending: tokens.colorNeutralForeground4,
    stopped: tokens.colorNeutralForeground4,
    cancelled: tokens.colorNeutralForeground4,
    'in-progress': fluo.cyan,
    running: fluo.cyan,
    'in-review': fluo.violet,
    'waiting-input': fluo.amber,
    'blocked-by-limit': fluo.amber,
    blocked: fluo.amber,
    done: fluo.green,
    failed: fluo.red,
  };
}

/**
 * A pipeline status as a dot colour, for the given scheme. See `theme.ts`'s
 * `PIPELINE_COLOR`.
 */
export function pipelineColor(scheme: ColorScheme): Record<PipelineStatus, string> {
  const fluo = FLUO_BY_SCHEME[scheme];
  return {
    unknown: tokens.colorNeutralForeground4,
    none: tokens.colorNeutralForeground4,
    created: tokens.colorNeutralForeground4,
    pending: tokens.colorNeutralForeground4,
    manual: tokens.colorNeutralForeground4,
    skipped: tokens.colorNeutralForeground4,
    running: fluo.cyan,
    success: fluo.green,
    failed: fluo.red,
    canceled: fluo.amber,
  };
}

export interface GraphInkTokens {
  line: string;
  merge: string;
  dot: string;
  live: string;
}

/**
 * The commit graph's ink, for the given scheme. Fluent neutral tokens already resolve
 * per theme; only `live` (the one coloured thing in the graph) needs a scheme lookup.
 * See `theme.ts`'s `GRAPH_INK`.
 */
export function graphInk(scheme: ColorScheme): GraphInkTokens {
  return {
    line: tokens.colorNeutralStroke2,
    merge: tokens.colorNeutralStroke3,
    dot: tokens.colorNeutralForeground3,
    live: FLUO_BY_SCHEME[scheme].cyan,
  };
}

function kebabCase(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function flattenInto(value: unknown, path: string[], out: Record<string, string>): void {
  if (typeof value === 'string') {
    out[`--tm-${path.map(kebabCase).join('-')}`] = value;
    return;
  }
  // `statusGradientStops`: a tuple for F13.2's tests, not a single CSS value.
  if (Array.isArray(value)) return;
  if (value && typeof value === 'object') {
    for (const [key, sub] of Object.entries(value)) {
      flattenInto(sub, [...path, key], out);
    }
  }
}

/**
 * The semantic set flattened into CSS custom properties — `--tm-canvas`, `--tm-pane-glass`,
 * … one key per leaf. Stamped on the provider root beside `--app-font-scale`
 * (`apps/client/src/renderer/src/main.tsx`, `apps/web/src/main.tsx`) so a bare `makeStyles`
 * block can read a token without importing `tokens.ts` itself. Identical key sets across
 * schemes by construction — both walk the same `SemanticTokens` shape.
 */
export function tokenCssVars(scheme: ColorScheme): Record<`--tm-${string}`, string> {
  const out: Record<string, string> = {};
  flattenInto(SEMANTIC[scheme], [], out);
  return out as Record<`--tm-${string}`, string>;
}
