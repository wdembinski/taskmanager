import { tokens } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import { AA, composite, contrastRatio, parseColor, type Rgba } from './contrast';
import { appDarkTheme, themeFor } from './theme';
import { SEMANTIC, pipelineColor, statusIndicatorColor, type ColorScheme } from './tokens';

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

describe('contrastRatio', () => {
  it('rates black on white as 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('rates a colour against itself as 1', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#112233', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#112233'),
      10,
    );
  });
});

describe('composite', () => {
  const over: Rgba = { r: 0, g: 0, b: 0, a: 1 };

  it('alpha 0 resolves to the backdrop untouched', () => {
    expect(composite({ r: 255, g: 255, b: 255, a: 0 }, over)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('alpha 1 resolves to the foreground untouched', () => {
    expect(composite({ r: 255, g: 255, b: 255, a: 1 }, over)).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
  });

  it('alpha 0.5 averages foreground and backdrop', () => {
    expect(composite({ r: 255, g: 255, b: 255, a: 0.5 }, over)).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
  });
});

describe('parseColor', () => {
  it('parses #rgb shorthand', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('parses #rrggbb', () => {
    expect(parseColor('#336699')).toEqual({ r: 51, g: 102, b: 153, a: 1 });
  });

  it('parses rgb(...)', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('parses rgba(...)', () => {
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it('rejects anything it does not recognise', () => {
    expect(() => parseColor('papayawhip')).toThrow();
  });
});

/**
 * A `tokens.*` value is `"var(--colorNeutralForeground4)"` — not a colour, a pointer. The
 * shell's two `Theme` objects (`appLightTheme`/`appDarkTheme`) are where that pointer is
 * actually resolved (`colorNeutralForeground4` → `SEMANTIC[scheme].textFaint`), so reading it
 * back off `themeFor(scheme)` is the one way to land on the colour that really paints,
 * including the dark theme's `colorNeutralForeground1` override to {@link EDITOR_FOREGROUND}.
 */
function resolveToken(value: string, scheme: ColorScheme): string {
  const match = value.match(/^var\(--(.+)\)$/);
  if (!match) return value;
  const theme = themeFor(scheme) as unknown as Record<string, string>;
  const resolved = theme[match[1]];
  if (resolved === undefined) {
    throw new Error(`resolveToken: themeFor(${scheme}) has no "${match[1]}"`);
  }
  return resolved;
}

/**
 * Every surface a token pair is checked against, for one scheme. `glassCandidates` is every
 * way `paneGlass` can actually render — over bare canvas, or over either wash — because the
 * washes are positioned, not universal; a pane can sit over either one, or neither.
 *
 * `paneGlass` and `paneOpaque` are exactly the two surfaces `GlassPane` (`shell/GlassPane.tsx`)
 * paints — `paneGlass` when glass is on, `paneOpaque` under `data-glass="opaque"`,
 * `forced-colors: active`, or no `backdrop-filter` support — so the pairs checked here are what
 * makes F13.5's acceptance ("contrast pairs from F13.2 include the pane in both modes")
 * traceable, without needing pairs of its own.
 */
function buildSurfaces(scheme: ColorScheme) {
  const s = SEMANTIC[scheme];
  const canvasRgba = parseColor(s.canvas);
  const washBackdrops = [
    canvasRgba,
    composite(parseColor(s.wash.a), canvasRgba),
    composite(parseColor(s.wash.b), canvasRgba),
  ];
  const glassCandidates = washBackdrops.map((backdrop) =>
    composite(parseColor(s.paneGlass), backdrop),
  );
  return {
    canvas: s.canvas,
    paneOpaque: s.paneOpaque,
    selectedTint: s.selectedTint,
    glassCandidates,
  };
}

/** The worst (lowest-contrast) rendering of glass for this particular foreground. */
function worstGlassRatio(fg: string | Rgba, glassCandidates: Rgba[]): number {
  return Math.min(...glassCandidates.map((bg) => contrastRatio(fg, bg)));
}

/** `it("<fgName> on <bg> >= <min>")` against canvas, paneOpaque, worst glass and selectedTint. */
function assertTextSuite(
  fgName: string,
  fg: string,
  surfaces: ReturnType<typeof buildSurfaces>,
  min: number,
) {
  it(`${fgName} on canvas >= ${min}`, () => {
    expect(contrastRatio(fg, surfaces.canvas)).toBeGreaterThanOrEqual(min);
  });

  it(`${fgName} on paneOpaque >= ${min}`, () => {
    expect(contrastRatio(fg, surfaces.paneOpaque)).toBeGreaterThanOrEqual(min);
  });

  it(`${fgName} on worst glass >= ${min}`, () => {
    expect(worstGlassRatio(fg, surfaces.glassCandidates)).toBeGreaterThanOrEqual(min);
  });

  it(`${fgName} on selectedTint >= ${min}`, () => {
    expect(contrastRatio(fg, surfaces.selectedTint)).toBeGreaterThanOrEqual(min);
  });
}

describe.each(SCHEMES)('shell token pairs (%s)', (scheme) => {
  const s = SEMANTIC[scheme];
  const surfaces = buildSurfaces(scheme);

  describe('text on every surface', () => {
    assertTextSuite('text', s.text, surfaces, AA.text);
    assertTextSuite('textMuted', s.textMuted, surfaces, AA.text);
    assertTextSuite('textFaint', s.textFaint, surfaces, AA.text);
  });

  describe('brand text on every surface', () => {
    assertTextSuite('brand', s.brand, surfaces, AA.text);
  });

  describe('status gradient', () => {
    for (const stop of s.statusGradientStops) {
      it(`statusGradientInk on ${stop}`, () => {
        expect(contrastRatio(s.statusGradientInk, stop)).toBeGreaterThanOrEqual(AA.text);
      });
    }
  });

  it(`attentionInk on attention >= ${AA.text}`, () => {
    expect(contrastRatio(s.attentionInk, s.attention)).toBeGreaterThanOrEqual(AA.text);
  });

  describe('run pill', () => {
    it(`run.ink on run.pill over paneOpaque >= ${AA.text}`, () => {
      const pillOverPane = composite(parseColor(s.run.pill), parseColor(s.paneOpaque));
      expect(contrastRatio(s.run.ink, pillOverPane)).toBeGreaterThanOrEqual(AA.text);
    });

    it(`run.ink on run.pill over worst glass >= ${AA.text}`, () => {
      const ratio = Math.min(
        ...surfaces.glassCandidates.map((glassBg) =>
          contrastRatio(s.run.ink, composite(parseColor(s.run.pill), glassBg)),
        ),
      );
      expect(ratio).toBeGreaterThanOrEqual(AA.text);
    });
  });

  describe('the label chip', () => {
    // Scheme-independent by design (see tokens.test.ts's `labelChip` suite) — the chip's
    // own fill/ink pair carries its contrast, not the canvas it floats on.
    it(`labelChip.ink on labelChip.bg >= ${AA.text}`, () => {
      expect(contrastRatio(s.labelChip.ink, s.labelChip.bg)).toBeGreaterThanOrEqual(AA.text);
    });
  });

  describe('the selection cue', () => {
    // selectedTint itself can't clear 3:1 against the pane by design — the cue is the bar,
    // not the tint — so what's asserted here is that the bar reads, and the tint is at least
    // a distinct fill rather than a no-op.
    it(`accentBar on selectedTint >= ${AA.nonText}`, () => {
      expect(contrastRatio(s.accentBar, s.selectedTint)).toBeGreaterThanOrEqual(AA.nonText);
    });

    it(`accentBar on paneOpaque >= ${AA.nonText}`, () => {
      expect(contrastRatio(s.accentBar, s.paneOpaque)).toBeGreaterThanOrEqual(AA.nonText);
    });

    it('selectedTint differs from paneOpaque', () => {
      expect(contrastRatio(s.selectedTint, s.paneOpaque)).toBeGreaterThan(1);
    });
  });

  describe('bottom tab bar labels', () => {
    const unselected = resolveToken(tokens.colorNeutralForeground2, scheme);
    const selectedTintOverPane = composite(parseColor(s.selectedTint), parseColor(s.paneOpaque));

    it(`unselected label on paneOpaque >= ${AA.text}`, () => {
      expect(contrastRatio(unselected, surfaces.paneOpaque)).toBeGreaterThanOrEqual(AA.text);
    });

    it(`unselected label on worst glass >= ${AA.text}`, () => {
      expect(worstGlassRatio(unselected, surfaces.glassCandidates)).toBeGreaterThanOrEqual(AA.text);
    });

    it(`selected label (brand) on selectedTint over paneOpaque >= ${AA.text}`, () => {
      expect(contrastRatio(s.brand, selectedTintOverPane)).toBeGreaterThanOrEqual(AA.text);
    });

    it(`selected label (brand) on selectedTint over worst glass >= ${AA.text}`, () => {
      const ratio = Math.min(
        ...surfaces.glassCandidates.map((glassBg) =>
          contrastRatio(s.brand, composite(parseColor(s.selectedTint), glassBg)),
        ),
      );
      expect(ratio).toBeGreaterThanOrEqual(AA.text);
    });
  });

  describe('status and pipeline indicator colours', () => {
    const entries: Array<[string, string]> = [
      ...Object.entries(statusIndicatorColor(scheme)).map(
        ([key, value]) => [`statusIndicatorColor.${key}`, value] as [string, string],
      ),
      ...Object.entries(pipelineColor(scheme)).map(
        ([key, value]) => [`pipelineColor.${key}`, value] as [string, string],
      ),
    ];

    for (const [name, rawValue] of entries) {
      const value = resolveToken(rawValue, scheme);

      it(`${name} on paneOpaque >= ${AA.nonText}`, () => {
        expect(contrastRatio(value, surfaces.paneOpaque)).toBeGreaterThanOrEqual(AA.nonText);
      });

      it(`${name} on worst glass >= ${AA.nonText}`, () => {
        expect(worstGlassRatio(value, surfaces.glassCandidates)).toBeGreaterThanOrEqual(AA.nonText);
      });

      it(`${name} on selectedTint >= ${AA.nonText}`, () => {
        expect(contrastRatio(value, surfaces.selectedTint)).toBeGreaterThanOrEqual(AA.nonText);
      });
    }
  });
});

describe('dark body text', () => {
  const surfaces = buildSurfaces('dark');

  it(`colorNeutralForeground1 (EDITOR_FOREGROUND) on paneOpaque >= ${AA.text}`, () => {
    expect(
      contrastRatio(appDarkTheme.colorNeutralForeground1, surfaces.paneOpaque),
    ).toBeGreaterThanOrEqual(AA.text);
  });

  it(`colorNeutralForeground1 (EDITOR_FOREGROUND) on worst glass >= ${AA.text}`, () => {
    expect(
      worstGlassRatio(appDarkTheme.colorNeutralForeground1, surfaces.glassCandidates),
    ).toBeGreaterThanOrEqual(AA.text);
  });
});
