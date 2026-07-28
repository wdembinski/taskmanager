/**
 * Unit tests for the update-mode decision — the platform × packaged × AppImage matrix
 * the `Updater` gates itself on. The interesting cases are the two that fail LOUDLY in
 * production if they are wrong: a `.deb` install (must be `manual`, or electron-updater
 * errors on every launch) and a from-source Linux run (same).
 */
import { describe, expect, it } from 'vitest';
import { updateMode } from './updateSupport';

describe('updateMode', () => {
  it('is off in a development run, whatever the platform', () => {
    expect(updateMode('win32', {}, false)).toBe('off');
    expect(updateMode('linux', { APPIMAGE: '/tmp/app.AppImage' }, false)).toBe('off');
    expect(updateMode('darwin', {}, false)).toBe('off');
  });

  it('updates itself on packaged Windows', () => {
    expect(updateMode('win32', {}, true)).toBe('auto');
  });

  it('updates a Linux install only when it is running as the AppImage', () => {
    expect(updateMode('linux', { APPIMAGE: '/home/me/Claude.AppImage' }, true)).toBe('auto');
    // A .deb install: apt owns those files, so self-replacement is not ours to do.
    expect(updateMode('linux', {}, true)).toBe('manual');
    // An empty APPIMAGE is not an AppImage path.
    expect(updateMode('linux', { APPIMAGE: '' }, true)).toBe('manual');
  });

  it('leaves macOS (unsigned) and anything unknown on manual', () => {
    expect(updateMode('darwin', {}, true)).toBe('manual');
    expect(updateMode('freebsd', {}, true)).toBe('manual');
  });
});
