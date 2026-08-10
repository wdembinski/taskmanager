import { describe, expect, it } from 'vitest';
import { corsOrigin } from './cors';

/** Exercises the callback form the way the `cors` middleware does. */
function allows(origin: ReturnType<typeof corsOrigin>, value: string | undefined): boolean {
  if (Array.isArray(origin)) return value !== undefined && origin.includes(value);
  let allowed = false;
  origin(value, (_err, ok) => {
    allowed = ok === true;
  });
  return allowed;
}

describe('corsOrigin', () => {
  it('names exactly the configured origins', () => {
    const origin = corsOrigin({ CLOUD_ALLOWED_ORIGINS: 'https://tasks.vipper.network' });

    expect(origin).toEqual(['https://tasks.vipper.network']);
    expect(allows(origin, 'https://tasks.vipper.network')).toBe(true);
    expect(allows(origin, 'https://evil.example')).toBe(false);
  });

  it('splits a list, trimming spaces and trailing slashes', () => {
    // A pasted origin very often arrives with a trailing slash; that would silently never
    // match, because the browser's Origin header never has one.
    const origin = corsOrigin({
      CLOUD_ALLOWED_ORIGINS: ' https://tasks.vipper.network/ , https://staging.example ',
    });

    expect(origin).toEqual(['https://tasks.vipper.network', 'https://staging.example']);
  });

  it('allows any localhost port outside production, so a second dev server still works', () => {
    // Vite walks up from 5173 when the port is taken, so the port cannot be pinned.
    const origin = corsOrigin({ NODE_ENV: 'development' });

    expect(allows(origin, 'http://localhost:5173')).toBe(true);
    expect(allows(origin, 'http://localhost:5175')).toBe(true);
    expect(allows(origin, 'http://127.0.0.1:4400')).toBe(true);
    expect(allows(origin, 'https://tasks.vipper.network')).toBe(false);
  });

  it('allows a request with no Origin header at all', () => {
    // curl, the desktop Client and the health probe send none — there is nothing to refuse.
    expect(allows(corsOrigin({ NODE_ENV: 'development' }), undefined)).toBe(true);
  });

  it('refuses everything in production when the variable is missing', () => {
    // The whole point: a deployment that forgets to configure this fails visibly, rather
    // than falling back to the wide-open `*` that `app.enableCors()` used to send.
    const origin = corsOrigin({ NODE_ENV: 'production' });

    expect(origin).toEqual([]);
    expect(allows(origin, 'https://tasks.vipper.network')).toBe(false);
    expect(allows(origin, 'https://evil.example')).toBe(false);
  });

  it('still honours a configured list in production', () => {
    const origin = corsOrigin({
      NODE_ENV: 'production',
      CLOUD_ALLOWED_ORIGINS: 'https://tasks.vipper.network',
    });

    expect(allows(origin, 'https://tasks.vipper.network')).toBe(true);
  });

  it('does not treat a non-URL origin as local', () => {
    expect(allows(corsOrigin({ NODE_ENV: 'development' }), 'localhost:5173')).toBe(false);
    expect(allows(corsOrigin({ NODE_ENV: 'development' }), 'null')).toBe(false);
  });
});
