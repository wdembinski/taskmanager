import { describe, expect, it } from 'vitest';
import { bootAppearanceFor } from './bootAppearance';

const settings = { appearance: 'light', transparency: 'full', fontSizePx: 16 } as const;

describe('bootAppearanceFor', () => {
  it('hands the saved settings through unchanged', () => {
    expect(bootAppearanceFor(settings, 'mica')).toEqual({
      appearance: 'light',
      transparency: 'full',
      fontSizePx: 16,
      nativeMaterial: 'mica',
    });
  });

  it('passes a granted material through', () => {
    expect(bootAppearanceFor(settings, 'acrylic').nativeMaterial).toBe('acrylic');
  });

  it('reads no material as null', () => {
    expect(bootAppearanceFor(settings, 'none').nativeMaterial).toBeNull();
  });
});
