import { describe, expect, it } from 'vitest';
import { AA, contrastRatio } from './contrast';
import { EDITOR_FOREGROUND, appDarkTheme, appLightTheme, pageBackground } from './theme';
import {
  ATTENTION_TINT_BY_SCHEME,
  CODE_BY_SCHEME,
  CODE_VAR,
  FLUO_BY_SCHEME,
  FLUO_VAR,
  GRAPH_INK_VAR,
  PIPELINE_VAR,
  SCROLL_THUMB_BY_SCHEME,
  SEMANTIC,
  STATUS_INDICATOR_VAR,
  graphInk,
  pipelineColor,
  statusIndicatorColor,
  tokenCssVars,
} from './tokens';
import { WINDOW_CANVAS } from '@tm/shared/canvas';

/**
 * Every leaf's dotted path through an object, sorted. Arrays (`statusGradientStops`) are
 * leaves themselves — their own key sets are not what F13.1 pins, only that both schemes
 * have one.
 */
function leafPaths(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [path];
  }
  return Object.keys(value)
    .sort()
    .flatMap((key) =>
      leafPaths((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key),
    );
}

/** The number of string leaves `tokenCssVars` should emit — arrays are not CSS values. */
function countCssLeaves(value: unknown): number {
  if (Array.isArray(value)) return 0;
  if (value === null || typeof value !== 'object') return 1;
  return Object.values(value).reduce((sum: number, v) => sum + countCssLeaves(v), 0);
}

describe('SEMANTIC', () => {
  it('has identical leaf key sets for light and dark', () => {
    expect(leafPaths(SEMANTIC.light).sort()).toEqual(leafPaths(SEMANTIC.dark).sort());
  });

  it('takes its canvas from WINDOW_CANVAS, not a literal of its own', () => {
    expect(SEMANTIC.light.canvas).toBe(WINDOW_CANVAS.light);
    expect(SEMANTIC.dark.canvas).toBe(WINDOW_CANVAS.dark);
  });
});

describe('pageBackground', () => {
  it('matches the scheme canvas, for a consumer that cannot read the CSS variable', () => {
    expect(pageBackground('light')).toBe(SEMANTIC.light.canvas);
    expect(pageBackground('dark')).toBe(SEMANTIC.dark.canvas);
  });
});

describe('the per-scheme indicator palettes', () => {
  it('FLUO_BY_SCHEME has identical keys for light and dark', () => {
    expect(Object.keys(FLUO_BY_SCHEME.light).sort()).toEqual(
      Object.keys(FLUO_BY_SCHEME.dark).sort(),
    );
  });

  it('CODE_BY_SCHEME has identical keys for light and dark', () => {
    expect(Object.keys(CODE_BY_SCHEME.light).sort()).toEqual(
      Object.keys(CODE_BY_SCHEME.dark).sort(),
    );
  });

  it('SCROLL_THUMB_BY_SCHEME has identical keys for light and dark', () => {
    expect(Object.keys(SCROLL_THUMB_BY_SCHEME.light).sort()).toEqual(
      Object.keys(SCROLL_THUMB_BY_SCHEME.dark).sort(),
    );
  });
});

describe('tokenCssVars', () => {
  it('produces identical key sets for light and dark', () => {
    expect(Object.keys(tokenCssVars('light')).sort()).toEqual(
      Object.keys(tokenCssVars('dark')).sort(),
    );
  });

  it('has one key per SEMANTIC leaf (excluding array leaves)', () => {
    expect(Object.keys(tokenCssVars('dark'))).toHaveLength(countCssLeaves(SEMANTIC.dark));
  });

  it('emits --tm-lane from SEMANTIC.lane', () => {
    expect(tokenCssVars('light')['--tm-lane']).toBe(SEMANTIC.light.lane);
    expect(tokenCssVars('dark')['--tm-lane']).toBe(SEMANTIC.dark.lane);
  });

  it('emits --tm-label-chip-bg / --tm-label-chip-ink from SEMANTIC.labelChip', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const vars = tokenCssVars(scheme);
      expect(vars['--tm-label-chip-bg']).toBe(SEMANTIC[scheme].labelChip.bg);
      expect(vars['--tm-label-chip-ink']).toBe(SEMANTIC[scheme].labelChip.ink);
    }
  });

  it('emits --tm-attention-tint from SEMANTIC.attentionTint', () => {
    expect(tokenCssVars('light')['--tm-attention-tint']).toBe(ATTENTION_TINT_BY_SCHEME.light);
    expect(tokenCssVars('dark')['--tm-attention-tint']).toBe(ATTENTION_TINT_BY_SCHEME.dark);
  });

  it('emits --tm-code-* from SEMANTIC.code, matching CODE_BY_SCHEME', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const vars = tokenCssVars(scheme);
      expect(vars['--tm-code-bg']).toBe(CODE_BY_SCHEME[scheme].bg);
      expect(vars['--tm-code-inline-bg']).toBe(CODE_BY_SCHEME[scheme].inlineBg);
      expect(vars['--tm-code-border']).toBe(CODE_BY_SCHEME[scheme].border);
    }
  });

  it('emits --tm-status-bar-* from SEMANTIC.statusBar', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const vars = tokenCssVars(scheme);
      const statusBar = SEMANTIC[scheme].statusBar;
      expect(vars['--tm-status-bar-dot-ok']).toBe(statusBar.dotOk);
      expect(vars['--tm-status-bar-dot-bad']).toBe(statusBar.dotBad);
      expect(vars['--tm-status-bar-ink']).toBe(statusBar.ink);
      expect(vars['--tm-status-bar-quota-track']).toBe(statusBar.quotaTrack);
      expect(vars['--tm-status-bar-quota-ok']).toBe(statusBar.quotaOk);
      expect(vars['--tm-status-bar-quota-warning']).toBe(statusBar.quotaWarning);
      expect(vars['--tm-status-bar-quota-critical']).toBe(statusBar.quotaCritical);
    }
  });

  it('emits --tm-window-close-* from SEMANTIC.windowClose', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const vars = tokenCssVars(scheme);
      const windowClose = SEMANTIC[scheme].windowClose;
      expect(vars['--tm-window-close-hover']).toBe(windowClose.hover);
      expect(vars['--tm-window-close-active']).toBe(windowClose.active);
      expect(vars['--tm-window-close-ink']).toBe(windowClose.ink);
    }
  });

  it('emits --tm-fluo-* from SEMANTIC.fluo, matching FLUO_BY_SCHEME', () => {
    const fluoVarNames: Record<string, string> = {
      cyan: '--tm-fluo-cyan',
      cyanDim: '--tm-fluo-cyan-dim',
      cyanDeep: '--tm-fluo-cyan-deep',
      green: '--tm-fluo-green',
      red: '--tm-fluo-red',
      amber: '--tm-fluo-amber',
      violet: '--tm-fluo-violet',
    };
    for (const scheme of ['light', 'dark'] as const) {
      const vars: Record<string, string> = tokenCssVars(scheme);
      const fluo = FLUO_BY_SCHEME[scheme] as unknown as Record<string, string>;
      for (const [key, varName] of Object.entries(fluoVarNames)) {
        expect(vars[varName]).toBe(fluo[key]);
      }
    }
  });
});

describe('labelChip', () => {
  it('has identical bg/ink in both schemes — the chip carries its own contrast', () => {
    expect(SEMANTIC.light.labelChip).toEqual(SEMANTIC.dark.labelChip);
  });
});

describe('statusIndicatorColor / pipelineColor', () => {
  // The keys come from the scheme-free var exports, so the lists cannot drift from their
  // own `TaskStatus`/`PipelineStatus` coverage.
  const taskStatuses = Object.keys(STATUS_INDICATOR_VAR) as Array<
    keyof typeof STATUS_INDICATOR_VAR
  >;
  const pipelineStatuses = Object.keys(PIPELINE_VAR) as Array<keyof typeof PIPELINE_VAR>;
  const schemes = ['light', 'dark'] as const;

  it('resolves every TaskStatus to a non-empty string in both schemes', () => {
    for (const scheme of schemes) {
      const colors = statusIndicatorColor(scheme);
      for (const status of taskStatuses) {
        expect(colors[status]).toBeTruthy();
      }
    }
  });

  it('resolves every PipelineStatus to a non-empty string in both schemes', () => {
    for (const scheme of schemes) {
      const colors = pipelineColor(scheme);
      for (const status of pipelineStatuses) {
        expect(colors[status]).toBeTruthy();
      }
    }
  });
});

describe('FLUO_VAR / STATUS_INDICATOR_VAR / PIPELINE_VAR', () => {
  const schemes = ['light', 'dark'] as const;

  it('FLUO_VAR points at the --tm-fluo-* custom property for every FluoPalette key', () => {
    expect(FLUO_VAR).toEqual({
      cyan: 'var(--tm-fluo-cyan)',
      cyanDim: 'var(--tm-fluo-cyan-dim)',
      cyanDeep: 'var(--tm-fluo-cyan-deep)',
      green: 'var(--tm-fluo-green)',
      red: 'var(--tm-fluo-red)',
      amber: 'var(--tm-fluo-amber)',
      violet: 'var(--tm-fluo-violet)',
    });
  });

  /** `"var(--tm-fluo-cyan-dim)"` → `FLUO_BY_SCHEME[scheme].cyanDim`; anything else (a Fluent
   * token var) is already scheme-independent, so it is returned as-is. */
  function resolveFluoVar(value: string, scheme: (typeof schemes)[number]): string {
    const match = value.match(/^var\(--tm-fluo-(.+)\)$/);
    if (!match) return value;
    const camelKey = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return (FLUO_BY_SCHEME[scheme] as unknown as Record<string, string>)[camelKey];
  }

  it('STATUS_INDICATOR_VAR resolves to the same colour as statusIndicatorColor, proving the shared role table', () => {
    for (const scheme of schemes) {
      const literal = statusIndicatorColor(scheme);
      for (const status of Object.keys(STATUS_INDICATOR_VAR) as Array<
        keyof typeof STATUS_INDICATOR_VAR
      >) {
        expect(resolveFluoVar(STATUS_INDICATOR_VAR[status], scheme)).toBe(literal[status]);
      }
    }
  });

  it('PIPELINE_VAR resolves to the same colour as pipelineColor, proving the shared role table', () => {
    for (const scheme of schemes) {
      const literal = pipelineColor(scheme);
      for (const status of Object.keys(PIPELINE_VAR) as Array<keyof typeof PIPELINE_VAR>) {
        expect(resolveFluoVar(PIPELINE_VAR[status], scheme)).toBe(literal[status]);
      }
    }
  });
});

describe('graphInk', () => {
  it('resolves every key to a non-empty string in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const ink = graphInk(scheme);
      for (const value of Object.values(ink)) {
        expect(value).toBeTruthy();
      }
    }
  });
});

describe('GRAPH_INK_VAR', () => {
  it('reuses the Fluent-token fields from graphInk, scheme-free', () => {
    const dark = graphInk('dark');
    expect(GRAPH_INK_VAR.line).toBe(dark.line);
    expect(GRAPH_INK_VAR.merge).toBe(dark.merge);
    expect(GRAPH_INK_VAR.dot).toBe(dark.dot);
  });

  it('points live at --tm-fluo-cyan, which is FLUO_BY_SCHEME[scheme].cyan for both schemes', () => {
    expect(GRAPH_INK_VAR.live).toBe(FLUO_VAR.cyan);
    for (const scheme of ['light', 'dark'] as const) {
      expect(FLUO_BY_SCHEME[scheme].cyan).toBe(graphInk(scheme).live);
    }
  });
});

describe('SEMANTIC.statusBar.ink', () => {
  // Unlike the live/dead dot (which keeps a dark ring instead — see `StatusBar.tsx`), this
  // ink has no ring to lean on, so it has to clear F13.2's own bar on every surface it is
  // ever drawn on directly: all three statusGradientStops, and the attention fill.
  it('passes F13.2 contrast (AA.nonText) against every statusGradientStops entry and attention, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const s = SEMANTIC[scheme];
      const surfaces: readonly string[] = [...s.statusGradientStops, s.attention];
      for (const surface of surfaces) {
        expect(contrastRatio(s.statusBar.ink, surface)).toBeGreaterThanOrEqual(AA.nonText);
      }
    }
  });
});

describe('the two Fluent themes', () => {
  it('keeps the dark theme on the editor-grey body text', () => {
    expect(appDarkTheme.colorNeutralForeground1).toBe(EDITOR_FOREGROUND);
    expect(appDarkTheme.colorNeutralForeground1Hover).toBe(EDITOR_FOREGROUND);
    expect(appDarkTheme.colorNeutralForeground1Pressed).toBe(EDITOR_FOREGROUND);
    expect(appDarkTheme.colorNeutralForeground1Selected).toBe(EDITOR_FOREGROUND);
  });

  it('builds the brand ramp around #0F6CBD', () => {
    expect(appLightTheme.colorBrandBackground).toBe('#0F6CBD');
  });

  it('carries colorNeutralBackground2 as the scheme canvas', () => {
    expect(appLightTheme.colorNeutralBackground2).toBe(SEMANTIC.light.canvas);
    expect(appDarkTheme.colorNeutralBackground2).toBe(SEMANTIC.dark.canvas);
  });
});

describe('CODE_VAR', () => {
  it('points at the --tm-code-* custom property for every CodeSurfaceTokens key', () => {
    expect(CODE_VAR).toEqual({
      bg: 'var(--tm-code-bg)',
      inlineBg: 'var(--tm-code-inline-bg)',
      border: 'var(--tm-code-border)',
    });
  });
});
