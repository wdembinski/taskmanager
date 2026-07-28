/**
 * Unit tests for the one sentence the UI shows about updating. Mostly guards against
 * the small embarrassments of string building: a missing version leaving a double
 * space, and a feed that reports no percentage rendering as "NaN%".
 */
import { describe, expect, it } from 'vitest';
import { describeUpdate } from './update';

describe('describeUpdate', () => {
  it('distinguishes a development run from an install that updates elsewhere', () => {
    expect(describeUpdate({ status: 'unsupported', mode: 'off' })).toMatch(/development/i);
    expect(describeUpdate({ status: 'unsupported', mode: 'manual' })).toMatch(/package manager/i);
  });

  it('names the version once the feed has been read', () => {
    expect(describeUpdate({ status: 'downloaded', mode: 'auto', version: '0.30.0' })).toContain(
      '0.30.0',
    );
    expect(describeUpdate({ status: 'available', mode: 'auto', version: '0.30.0' })).toContain(
      '0.30.0',
    );
  });

  it('reads cleanly when the version is not known yet', () => {
    expect(describeUpdate({ status: 'downloaded', mode: 'auto' })).toBe(
      'Update ready — restart to install',
    );
    expect(describeUpdate({ status: 'available', mode: 'auto' })).toBe(
      'Update found — downloading…',
    );
  });

  it('never renders a missing percentage as NaN', () => {
    expect(describeUpdate({ status: 'downloading', mode: 'auto' })).toBe('Downloading update…');
    expect(describeUpdate({ status: 'downloading', mode: 'auto', percent: 41.6 })).toContain('42%');
  });

  it('surfaces the error text rather than a generic failure', () => {
    expect(describeUpdate({ status: 'error', mode: 'auto', message: 'ENOTFOUND' })).toContain(
      'ENOTFOUND',
    );
    expect(describeUpdate({ status: 'error', mode: 'auto' })).toBe('Update check failed.');
  });

  it('reads as up to date when idle', () => {
    expect(describeUpdate({ status: 'idle', mode: 'auto' })).toBe('Up to date.');
    expect(describeUpdate({ status: 'idle', mode: 'auto', version: '0.29.0' })).toContain('0.29.0');
  });
});
