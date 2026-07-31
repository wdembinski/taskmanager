import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, resolveSyncInterval } from './settings';

describe('resolveSyncInterval', () => {
  it('leaves an already-migrated blob alone', () => {
    expect(resolveSyncInterval({ syncIntervalMinutes: 7 })).toBe(7);
    // Including an explicit 0, which means "auto-sync off" and is not a missing value.
    expect(resolveSyncInterval({ syncIntervalMinutes: 0 })).toBe(0);
  });

  // The safe direction for a setting nobody asked to have changed: a user who had GitLab on
  // 2 minutes must not silently drop to JIRA's 5 because the two timers became one.
  it('takes the SHORTER of the two it replaces, so nothing gets staler', () => {
    expect(resolveSyncInterval({ jira: { pollIntervalMinutes: 5 }, gitlab: { pollIntervalMinutes: 2 } })).toBe(2);
    expect(resolveSyncInterval({ jira: { pollIntervalMinutes: 1 }, gitlab: { pollIntervalMinutes: 9 } })).toBe(1);
  });

  // A 0 on one side is "that integration was switched off", not "never sync" — letting it
  // win the minimum would silently disable background sync for the one still in use.
  it('ignores a switched-off integration rather than letting its 0 win', () => {
    expect(resolveSyncInterval({ jira: { pollIntervalMinutes: 0 }, gitlab: { pollIntervalMinutes: 2 } })).toBe(2);
    expect(resolveSyncInterval({ jira: { pollIntervalMinutes: 5 }, gitlab: { pollIntervalMinutes: 0 } })).toBe(5);
  });

  it('keeps auto-sync off when BOTH were off', () => {
    expect(resolveSyncInterval({ jira: { pollIntervalMinutes: 0 }, gitlab: { pollIntervalMinutes: 0 } })).toBe(0);
  });

  it('falls back to the shipped default for a blob that predates either setting', () => {
    expect(resolveSyncInterval({})).toBe(DEFAULT_SETTINGS.syncIntervalMinutes);
    expect(resolveSyncInterval({ jira: {}, gitlab: {} })).toBe(DEFAULT_SETTINGS.syncIntervalMinutes);
  });

  it('never returns a negative interval', () => {
    expect(resolveSyncInterval({ syncIntervalMinutes: -5 })).toBe(0);
  });
});
