/**
 * Hex colour parsing for the custom-colour picker.
 *
 * The value chosen here is written to `Project.color` and rendered straight into a
 * `style` attribute on the card's stripe. A malformed value there is not a crash — it is
 * worse: the browser silently ignores the declaration, so the stripe just doesn't appear
 * and nothing says why. So the hex field validates before it writes, and this is the
 * function that decides.
 *
 * Pure, so the accept/reject edges are testable without a DOM.
 */
import { PALETTE } from './ColorSwatches';

/**
 * Canonicalise a typed or pasted hex colour to `#rrggbb`, or null when it isn't one.
 *
 * Accepts `#abc`, `abc`, `#aabbcc`, `aabbcc`, any case, with surrounding whitespace.
 * Shorthand is expanded, because everything downstream compares colours as strings and
 * `#abc` and `#aabbcc` are the same colour spelled two ways.
 *
 * Alpha (`#rgba`/`#rrggbbaa`) is deliberately rejected: a translucent stripe over the
 * card's fill is a different colour on a selected card than on an unselected one, which
 * defeats the point of colouring by project.
 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  if (raw.length === 3) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')}`.toLowerCase();
  }
  if (raw.length === 6) return `#${raw}`.toLowerCase();
  return null;
}

/** Whether a colour is one of the eight the palette row already offers. */
export function isOnPalette(color: string): boolean {
  const hex = normalizeHex(color);
  return hex !== null && PALETTE.some((p) => p.toLowerCase() === hex);
}

/**
 * Hue/saturation/value, in the convention Fluent's `ColorPicker` speaks: hue in degrees,
 * saturation and value as fractions. We convert rather than store HSV because the app's
 * colours are hex everywhere else — in the palette, in the DB, and in the `style`
 * attribute the stripe is painted with.
 */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** `#rrggbb` → HSV. Returns null for anything `normalizeHex` rejects. */
export function hexToHsv(hex: string): Hsv | null {
  const normal = normalizeHex(hex);
  if (!normal) return null;
  const r = parseInt(normal.slice(1, 3), 16) / 255;
  const g = parseInt(normal.slice(3, 5), 16) / 255;
  const b = parseInt(normal.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;

  let h = 0;
  if (span !== 0) {
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : span / max, v: max };
}

/** HSV → `#rrggbb`. Out-of-range inputs are clamped rather than rejected. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[sector];

  const byte = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
