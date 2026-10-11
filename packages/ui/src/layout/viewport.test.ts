import { describe, expect, it } from 'vitest';
import {
  COMPACT_QUERY,
  MEDIA,
  MEDIUM_MIN_PX,
  MEDIUM_QUERY,
  WIDE_MIN_PX,
  WIDE_QUERY,
  layoutMode,
} from './viewport';

describe('layoutMode', () => {
  it('reads compact below the medium boundary', () => {
    expect(layoutMode(0)).toBe('compact');
    expect(layoutMode(639)).toBe('compact');
  });

  it('reads medium between the medium and wide boundaries', () => {
    expect(layoutMode(640)).toBe('medium');
    expect(layoutMode(1023)).toBe('medium');
  });

  it('reads wide at and above the wide boundary', () => {
    expect(layoutMode(1024)).toBe('wide');
  });
});

describe('MEDIA', () => {
  it('builds each Griffel key from the same query matchMedia would use', () => {
    expect(MEDIA.compact).toBe(`@media ${COMPACT_QUERY}`);
    expect(MEDIA.medium).toBe(`@media ${MEDIUM_QUERY}`);
    expect(MEDIA.wide).toBe(`@media ${WIDE_QUERY}`);
  });

  it('embeds the boundary constants exactly, not a copied literal', () => {
    expect(MEDIA.compact).toContain(`${MEDIUM_MIN_PX - 1}px`);
    expect(MEDIA.medium).toContain(`${MEDIUM_MIN_PX}px`);
    expect(MEDIA.medium).toContain(`${WIDE_MIN_PX - 1}px`);
    expect(MEDIA.wide).toContain(`${WIDE_MIN_PX}px`);
  });
});

/** Parses the px thresholds a `(max-width: …)`/`(min-width: …)` query embeds. */
function queryBounds(query: string): { min?: number; max?: number } {
  const min = query.match(/min-width:\s*(\d+)px/);
  const max = query.match(/max-width:\s*(\d+)px/);
  return {
    min: min ? Number(min[1]) : undefined,
    max: max ? Number(max[1]) : undefined,
  };
}

describe('layoutMode agrees with the MEDIA queries', () => {
  const boundaries = [0, 639, 640, 1023, 1024];

  it.each(boundaries)('at %ipx, the mode matches the query that covers it', (widthPx) => {
    const mode = layoutMode(widthPx);
    const query =
      mode === 'compact' ? COMPACT_QUERY : mode === 'medium' ? MEDIUM_QUERY : WIDE_QUERY;
    const { min, max } = queryBounds(query);
    if (min !== undefined) expect(widthPx).toBeGreaterThanOrEqual(min);
    if (max !== undefined) expect(widthPx).toBeLessThanOrEqual(max);
  });
});
