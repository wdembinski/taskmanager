/**
 * The canvas haze (`--tm-page-wash`) draws the mockups' blurred circles: each haze's stops
 * sample a disc blurred by a Gaussian, at the centre and radius the scheme's own mockup gives.
 * `canvasWash.render.test.tsx` proves the wash is wired up; this proves what it draws.
 */
import { describe, expect, it } from 'vitest';
import { parseColor } from './contrast';
import { HAZE_STOPS, WASH_DITHER, erf, hazeGradient, hazeStops, washGradient } from './theme';
import { SEMANTIC, type ColorScheme } from './tokens';

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];
const HAZES = ['a', 'b'] as const;

/** `<g id="wash">` in v9-7 (light) and v9-7b (dark), on the 1440×900 artboard. */
const MOCKUP: Record<ColorScheme, Record<'a' | 'b', { cx: number; cy: number; r: number }>> = {
  light: { a: { cx: 115.2, cy: 90, r: 345.6 }, b: { cx: 1368, cy: 828, r: 374.4 } },
  dark: { a: { cx: 144, cy: 108, r: 374.4 }, b: { cx: 1324.8, cy: 810, r: 432 } },
};

/** The alpha the stops draw at `d` vw, interpolated the way CSS does between two stops. */
function alphaAt(stops: { at: number; alpha: number }[], d: number): number {
  const i = stops.findIndex((s) => s.at >= d);
  if (i <= 0) return i === 0 ? stops[0]!.alpha : 0;
  const [p, q] = [stops[i - 1]!, stops[i]!];
  return p.alpha + ((q.alpha - p.alpha) * (d - p.at)) / (q.at - p.at);
}

describe('WASH_DITHER', () => {
  it('is a seamless noise tile at ±1/255 or less', () => {
    const svg = decodeURIComponent(WASH_DITHER.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).toContain("stitchTiles='stitch'");
    // Full-range grey at this opacity spans at most 255 × 0.008 ≈ 2 levels: ±1.
    expect(Number(/opacity='([\d.]+)'/.exec(svg)![1])).toBeLessThanOrEqual(0.008);
  });
});

describe('erf', () => {
  it('matches known values', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(0.5)).toBeCloseTo(0.5204999, 6);
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
    expect(erf(2)).toBeCloseTo(0.9953223, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427008, 6);
  });
});

describe.each(SCHEMES)('the %s haze', (scheme) => {
  const wash = SEMANTIC[scheme].wash;

  it('blurs by the mockup σ, 90px of 1440', () => {
    expect(wash.blur).toBeCloseTo((90 / 1440) * 100, 6);
  });

  describe.each(HAZES)('haze %s', (key) => {
    const shape = wash.shape[key];
    const peak = parseColor(wash[key]).a;
    const stops = hazeStops(shape, peak, wash.blur);

    it("sits where the mockup's circle does", () => {
      const m = MOCKUP[scheme][key];
      expect(shape.x).toBeCloseTo((m.cx / 1440) * 100, 6);
      expect(shape.y).toBeCloseTo((m.cy / 900) * 100, 6);
      expect(shape.r).toBeCloseTo((m.r / 1440) * 100, 6);
    });

    it(`has ${HAZE_STOPS} stops from the centre out to r + 3σ`, () => {
      expect(stops).toHaveLength(HAZE_STOPS);
      expect(stops[0]!.at).toBe(0);
      expect(stops.at(-1)!.at).toBeCloseTo(shape.r + 3 * wash.blur, 3);
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i]!.at).toBeGreaterThan(stops[i - 1]!.at);
      }
    });

    it('never gets brighter going out', () => {
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i]!.alpha).toBeLessThanOrEqual(stops[i - 1]!.alpha);
      }
    });

    it("peaks at the token's alpha and ends at 0", () => {
      expect(stops[0]!.alpha).toBe(peak);
      expect(stops.at(-1)!.alpha).toBe(0);
    });

    it('is about half the peak at the edge of the circle', () => {
      expect(alphaAt(stops, shape.r) / peak).toBeCloseTo(0.5, 2);
    });

    it("draws a circle at the mockup's centre", () => {
      expect(hazeGradient(wash[key], shape, wash.blur)).toMatch(
        new RegExp(`^radial-gradient\\(circle ${stops.at(-1)!.at}vw at ${shape.x}% ${shape.y}%, `),
      );
    });
  });

  it('stacks the dither over haze a over haze b, in the token colours', () => {
    const css = washGradient(wash);
    const { r, g, b, a } = parseColor(wash.a);
    // The dither is a layer of the wash itself, so forced colours drop it with the hazes.
    expect(css.startsWith(`${WASH_DITHER}, radial-gradient(`)).toBe(true);
    expect(css).toContain(`rgba(${r}, ${g}, ${b}, ${a}) 0vw`);
    expect(css.split('radial-gradient(')).toHaveLength(3);
  });
});
