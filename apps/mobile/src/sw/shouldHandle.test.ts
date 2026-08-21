import { describe, expect, it } from 'vitest';
import { shouldHandle } from './shouldHandle';

const ORIGIN = 'https://mobile.vipper.network';

describe('shouldHandle', () => {
  it('caches same-origin hashed assets first', () => {
    expect(shouldHandle({ method: 'GET', url: `${ORIGIN}/assets/index-abc123.js` }, ORIGIN)).toBe(
      'cache-first',
    );
  });

  it('falls back to cache for a same-origin navigation', () => {
    expect(shouldHandle({ method: 'GET', url: `${ORIGIN}/board`, mode: 'navigate' }, ORIGIN)).toBe(
      'network-first',
    );
  });

  it('passes through a same-origin GET that is neither an asset nor a navigation', () => {
    expect(
      shouldHandle({ method: 'GET', url: `${ORIGIN}/manifest.webmanifest` }, ORIGIN),
    ).toBeNull();
  });

  it('passes through the cloud API — a different origin, even though the method is GET', () => {
    expect(
      shouldHandle(
        { method: 'GET', url: 'https://api.vipper.network/v1/events', mode: 'cors' },
        ORIGIN,
      ),
    ).toBeNull();
  });

  it('passes through a cross-origin navigation-shaped request too — origin wins over mode', () => {
    expect(
      shouldHandle(
        { method: 'GET', url: 'https://auth.vipper.network/oidc/authorize', mode: 'navigate' },
        ORIGIN,
      ),
    ).toBeNull();
  });

  it('never intercepts a non-GET, so the same-origin OIDC token POST is left alone', () => {
    expect(shouldHandle({ method: 'POST', url: `${ORIGIN}/assets/whatever` }, ORIGIN)).toBeNull();
  });

  it('does not cache an /assets/-shaped path on a different origin', () => {
    expect(
      shouldHandle({ method: 'GET', url: 'https://api.vipper.network/assets/x.js' }, ORIGIN),
    ).toBeNull();
  });

  it('passes through a request whose URL cannot be parsed, rather than throwing', () => {
    expect(shouldHandle({ method: 'GET', url: 'not a url' }, ORIGIN)).toBeNull();
  });
});
