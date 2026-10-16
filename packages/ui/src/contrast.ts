/**
 * WCAG contrast arithmetic for the shell's token pairs.
 *
 * Deliberately pure and Fluent-free: `color.ts#normalizeHex` already parses hex, but it
 * rejects alpha and imports `ColorSwatches` for its palette check, neither of which belongs
 * in a test that just wants to know if two colours read. This module is the one place that
 * `relativeLuminance`/`contrastRatio` math lives, so a later checker test can assert every
 * token pair in both themes without dragging Fluent into a pure test.
 */

/** An opaque or translucent colour as 0-255 channels plus a 0-1 alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_SHORT = /^#([0-9a-fA-F]{3})$/;
const HEX_LONG = /^#([0-9a-fA-F]{6})$/;
const RGB_FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` into channels. Throws on anything else
 * — a test pair that typos a colour must fail loudly, not silently resolve to black.
 */
export function parseColor(css: string): Rgba {
  const input = css.trim();

  const short = input.match(HEX_SHORT);
  if (short) {
    const [r, g, b] = short[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }

  const long = input.match(HEX_LONG);
  if (long) {
    const hex = long[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  const fn = input.match(RGB_FN);
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }

  throw new Error(`parseColor: not a recognised colour: "${css}"`);
}

/** sRGB relative luminance (0 black – 1 white), per the WCAG 2 definition. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const linearize = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Straight alpha-composite a (possibly translucent) colour over an opaque one. */
export function composite(rgba: Rgba, over: Rgba): Rgba {
  const a = rgba.a;
  return {
    r: rgba.r * a + over.r * (1 - a),
    g: rgba.g * a + over.g * (1 - a),
    b: rgba.b * a + over.b * (1 - a),
    a: 1,
  };
}

const toRgba = (color: string | Rgba): Rgba =>
  typeof color === 'string' ? parseColor(color) : color;

/**
 * WCAG contrast ratio between a foreground and an opaque background. A translucent `fg` is
 * composited over `bg` first, so a glass token reads as it actually renders. `bg` itself
 * must be opaque — the caller composites glass-on-glass explicitly rather than this function
 * guessing what's underneath.
 */
export function contrastRatio(fg: string | Rgba, bg: string | Rgba): number {
  const bgColor = toRgba(bg);
  if (bgColor.a !== 1) {
    throw new Error('contrastRatio: bg must be opaque; composite it onto its own backdrop first');
  }

  const fgColor = toRgba(fg);
  const resolvedFg = fgColor.a === 1 ? fgColor : composite(fgColor, bgColor);

  const l1 = relativeLuminance(resolvedFg);
  const l2 = relativeLuminance(bgColor);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2 AA minimum contrast ratios. */
export const AA = { text: 4.5, large: 3, nonText: 3 } as const;
