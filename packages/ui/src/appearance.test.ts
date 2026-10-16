import { describe, expect, it } from 'vitest';
import { resolveAppearance, type AppearanceEnv } from './appearance';

const env = (overrides: Partial<AppearanceEnv> = {}): AppearanceEnv => ({
  prefersDark: false,
  prefersReducedTransparency: false,
  backdropFilterSupported: true,
  nativeMaterial: null,
  ...overrides,
});

describe('resolveAppearance — scheme', () => {
  it('follows the OS under system, both ways', () => {
    expect(
      resolveAppearance(
        { appearance: 'system', transparency: 'system' },
        env({ prefersDark: true }),
      ),
    ).toMatchObject({ scheme: 'dark' });
    expect(
      resolveAppearance(
        { appearance: 'system', transparency: 'system' },
        env({ prefersDark: false }),
      ),
    ).toMatchObject({ scheme: 'light' });
  });

  it('ignores the OS under an explicit light/dark setting', () => {
    expect(
      resolveAppearance(
        { appearance: 'light', transparency: 'system' },
        env({ prefersDark: true }),
      ),
    ).toMatchObject({ scheme: 'light' });
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ prefersDark: false }),
      ),
    ).toMatchObject({ scheme: 'dark' });
  });

  it('falls back to system for a junk or missing value', () => {
    expect(
      resolveAppearance(
        { appearance: 'neon' as never, transparency: 'system' },
        env({ prefersDark: true }),
      ),
    ).toMatchObject({ scheme: 'dark' });
  });

  it('is never affected by the glass mode', () => {
    const { scheme } = resolveAppearance(
      { appearance: 'dark', transparency: 'reduced' },
      env({ nativeMaterial: 'mica' }),
    );
    expect(scheme).toBe('dark');
  });
});

describe('resolveAppearance — glass', () => {
  it('goes opaque under an explicit reduced setting, even with a native material and backdrop support', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'reduced' },
        env({ nativeMaterial: 'mica', backdropFilterSupported: true }),
      ),
    ).toMatchObject({ glass: 'opaque' });
  });

  it('goes opaque under system when the OS asks for reduced transparency', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ prefersReducedTransparency: true }),
      ),
    ).toMatchObject({ glass: 'opaque' });
  });

  it('lets full override the OS reduced-transparency query', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'full' },
        env({ prefersReducedTransparency: true, nativeMaterial: 'acrylic' }),
      ),
    ).toMatchObject({ glass: 'native' });
  });

  it('goes opaque with no backdrop-filter support, even under full', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ backdropFilterSupported: false }),
      ),
    ).toMatchObject({ glass: 'opaque' });
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'full' },
        env({ backdropFilterSupported: false }),
      ),
    ).toMatchObject({ glass: 'opaque' });
  });

  it('goes native only when a mica or acrylic material took effect', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ nativeMaterial: 'mica' }),
      ),
    ).toMatchObject({ glass: 'native' });
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ nativeMaterial: 'acrylic' }),
      ),
    ).toMatchObject({ glass: 'native' });
  });

  it('falls back to css when no native material took effect (null or absent)', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'system' },
        env({ nativeMaterial: null }),
      ),
    ).toMatchObject({ glass: 'css' });
    expect(resolveAppearance({ appearance: 'dark', transparency: 'system' }, env())).toMatchObject({
      glass: 'css',
    });
  });

  it('treats a junk transparency value as system, subject to the OS query', () => {
    expect(
      resolveAppearance(
        { appearance: 'dark', transparency: 'neon' as never },
        env({ prefersReducedTransparency: true }),
      ),
    ).toMatchObject({ glass: 'opaque' });
  });
});
