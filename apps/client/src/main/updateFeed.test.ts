/**
 * Unit tests for the pure update-feed decisions: which feed config to hand
 * electron-updater, which token wins when more than one is available, how a
 * feed error maps onto a reason the UI can explain, and redacting secrets out
 * of anything that gets logged.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUpdateError,
  pickUpdateToken,
  redactSecret,
  UPDATE_OWNER,
  UPDATE_REPO,
  updateFeedConfig,
} from './updateFeed';

describe('updateFeedConfig', () => {
  it('is the public feed with no token', () => {
    expect(updateFeedConfig(null)).toEqual({
      provider: 'github',
      owner: UPDATE_OWNER,
      repo: UPDATE_REPO,
    });
  });

  it('carries the token and never sets private, even with one', () => {
    const config = updateFeedConfig('ghp_abc123');
    expect(config).toEqual({
      provider: 'github',
      owner: UPDATE_OWNER,
      repo: UPDATE_REPO,
      token: 'ghp_abc123',
    });
    expect(config).not.toHaveProperty('private');
  });
});

describe('pickUpdateToken', () => {
  it('prefers a stored token over gh, whatever the setting', () => {
    expect(pickUpdateToken({ stored: 'stored-token', ghCli: 'gh-token', useGhCli: true })).toEqual({
      token: 'stored-token',
      source: 'stored',
    });
    expect(pickUpdateToken({ stored: 'stored-token', ghCli: 'gh-token', useGhCli: false })).toEqual(
      { token: 'stored-token', source: 'stored' },
    );
  });

  it('falls back to gh only when the setting is on', () => {
    expect(pickUpdateToken({ stored: null, ghCli: 'gh-token', useGhCli: true })).toEqual({
      token: 'gh-token',
      source: 'gh',
    });
    expect(pickUpdateToken({ stored: null, ghCli: 'gh-token', useGhCli: false })).toEqual({
      token: null,
      source: 'none',
    });
  });

  it('is none when nothing is available', () => {
    expect(pickUpdateToken({ stored: null, ghCli: null, useGhCli: true })).toEqual({
      token: null,
      source: 'none',
    });
  });
});

describe('classifyUpdateError', () => {
  it('reads a raw HttpError statusCode', () => {
    const err = Object.assign(new Error('Response error'), { statusCode: 404 });
    expect(classifyUpdateError(err, true)).toBe('token-blind');
    expect(classifyUpdateError(err, false)).toBe('needs-token');
  });

  it('parses the wrapped ERR_UPDATER_LATEST_VERSION_NOT_FOUND text', () => {
    const err = Object.assign(
      new Error(
        'Error: Unable to find latest version on GitHub, please ensure a successful ' +
          'release exists.\n  Underlying error: HttpError: 401 Unauthorized',
      ),
      { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' },
    );
    expect(classifyUpdateError(err, true)).toBe('token-rejected');
  });

  it('maps a 403 with a token to token-rejected', () => {
    const err = new Error('HttpError: 403 Forbidden');
    expect(classifyUpdateError(err, true)).toBe('token-rejected');
  });

  it('maps a 404 without a token to needs-token', () => {
    const err = new Error('HttpError: 404 Not Found');
    expect(classifyUpdateError(err, false)).toBe('needs-token');
  });

  it('leaves a network error unclassified', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), {
      code: 'ENOTFOUND',
    });
    expect(classifyUpdateError(err, true)).toBeNull();
    expect(classifyUpdateError(err, false)).toBeNull();
  });

  it('is unclassified for a status code it does not map', () => {
    expect(classifyUpdateError(new Error('HttpError: 500 Internal Server Error'), true)).toBeNull();
  });
});

describe('redactSecret', () => {
  it('replaces every occurrence of the given token', () => {
    const text = 'failed for ghp_abc123: ghp_abc123 was rejected';
    expect(redactSecret(text, 'ghp_abc123')).toBe('failed for ***: *** was rejected');
  });

  it('redacts anything shaped like a PAT even without the secret', () => {
    expect(redactSecret('token github_pat_11ABCDEF is bad', null)).toBe('token *** is bad');
    expect(redactSecret('token ghp_xyz789 is bad', null)).toBe('token *** is bad');
    expect(redactSecret('token ghs_serverToServer is bad', null)).toBe('token *** is bad');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecret('Update check failed: ENOTFOUND', null)).toBe(
      'Update check failed: ENOTFOUND',
    );
  });
});
