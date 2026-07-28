/**
 * The target is persisted as text and read back on every project load, so parsing
 * has to be total: whatever is in the column, a project must still open.
 */
import { describe, expect, it } from 'vitest';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
  sameExecTarget,
} from './execTarget';

describe('formatExecTarget / parseExecTarget', () => {
  it('round-trips local', () => {
    expect(formatExecTarget(LOCAL_TARGET)).toBe('local');
    expect(parseExecTarget('local')).toEqual(LOCAL_TARGET);
  });

  it('round-trips a distro', () => {
    const target = { kind: 'wsl', distro: 'Ubuntu-20.04' } as const;
    expect(formatExecTarget(target)).toBe('wsl:Ubuntu-20.04');
    expect(parseExecTarget('wsl:Ubuntu-20.04')).toEqual(target);
  });

  it('keeps spaces in a distro name', () => {
    expect(parseExecTarget('wsl:My Custom Distro')).toEqual({
      kind: 'wsl',
      distro: 'My Custom Distro',
    });
  });

  it('degrades anything unrecognized to local rather than failing', () => {
    for (const raw of [null, undefined, '', '   ', 'wsl:', 'nonsense', 'docker:thing']) {
      expect(parseExecTarget(raw)).toEqual(LOCAL_TARGET);
    }
  });
});

describe('sameExecTarget', () => {
  it('compares by machine, not identity', () => {
    expect(sameExecTarget(LOCAL_TARGET, { kind: 'local' })).toBe(true);
    expect(
      sameExecTarget({ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'wsl', distro: 'Ubuntu' }),
    ).toBe(true);
    expect(
      sameExecTarget({ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'wsl', distro: 'Debian' }),
    ).toBe(false);
    expect(sameExecTarget(LOCAL_TARGET, { kind: 'wsl', distro: 'Ubuntu' })).toBe(false);
  });
});

describe('execTargetLabel', () => {
  it('reads plainly in the UI', () => {
    expect(execTargetLabel(LOCAL_TARGET)).toBe('This computer');
    expect(execTargetLabel({ kind: 'wsl', distro: 'Ubuntu-20.04' })).toBe('WSL · Ubuntu-20.04');
  });
});
