import { describe, expect, it } from 'vitest';
import {
  closeAction,
  shouldQuitOnClose,
  trayLikelyAvailable,
  trayMenuModel,
} from './backgroundMode';

describe('closeAction', () => {
  it('keeps today’s behaviour when the setting is off: darwin stays open', () => {
    expect(closeAction('darwin', { runInBackground: false }, true)).toBe('keep-open');
    expect(closeAction('darwin', { runInBackground: false }, false)).toBe('keep-open');
  });

  it('keeps today’s behaviour when the setting is off: everywhere else quits', () => {
    expect(closeAction('win32', { runInBackground: false }, true)).toBe('quit');
    expect(closeAction('linux', { runInBackground: false }, false)).toBe('quit');
  });

  it('hides to the tray when the setting is on and a tray is available, on any platform', () => {
    expect(closeAction('win32', { runInBackground: true }, true)).toBe('hide-to-tray');
    expect(closeAction('darwin', { runInBackground: true }, true)).toBe('hide-to-tray');
    expect(closeAction('linux', { runInBackground: true }, true)).toBe('hide-to-tray');
  });

  it('minimizes instead when the setting is on but no tray is available', () => {
    expect(closeAction('win32', { runInBackground: true }, false)).toBe('minimize');
    expect(closeAction('linux', { runInBackground: true }, false)).toBe('minimize');
  });
});

describe('shouldQuitOnClose', () => {
  it('is true exactly when closeAction resolves to quit', () => {
    expect(shouldQuitOnClose('win32', { runInBackground: false }, true)).toBe(true);
    expect(shouldQuitOnClose('darwin', { runInBackground: false }, true)).toBe(false);
    expect(shouldQuitOnClose('win32', { runInBackground: true }, true)).toBe(false);
    expect(shouldQuitOnClose('win32', { runInBackground: true }, false)).toBe(false);
  });
});

describe('trayLikelyAvailable', () => {
  it('is false on Linux under WSL’s distro marker', () => {
    expect(trayLikelyAvailable('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(false);
  });

  it('is false on Linux under WSL’s interop marker', () => {
    expect(trayLikelyAvailable('linux', { WSL_INTEROP: '/run/WSL/1_interop' })).toBe(false);
  });

  it('is true on a native Linux desktop with neither marker set', () => {
    expect(trayLikelyAvailable('linux', {})).toBe(true);
  });

  it('is true on win32 and darwin regardless of environment', () => {
    expect(trayLikelyAvailable('win32', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
    expect(trayLikelyAvailable('darwin', {})).toBe(true);
  });
});

describe('trayMenuModel', () => {
  it('always offers Open and Quit', () => {
    const items = trayMenuModel({ canPauseAutomations: false, automationsPaused: false });
    expect(items.find((i) => i.id === 'open')).toMatchObject({ label: 'Open' });
    expect(items.find((i) => i.id === 'quit')).toMatchObject({ label: 'Quit' });
  });

  it('disables Pause automations when the caller has nothing to pause', () => {
    const items = trayMenuModel({ canPauseAutomations: false, automationsPaused: false });
    expect(items.find((i) => i.id === 'pause')).toMatchObject({ enabled: false });
  });

  it('enables Pause automations and reflects its checked state when available', () => {
    const paused = trayMenuModel({ canPauseAutomations: true, automationsPaused: true });
    expect(paused.find((i) => i.id === 'pause')).toMatchObject({ enabled: true, checked: true });

    const running = trayMenuModel({ canPauseAutomations: true, automationsPaused: false });
    expect(running.find((i) => i.id === 'pause')).toMatchObject({ enabled: true, checked: false });
  });
});
