/**
 * The one decision every request the service worker sees has to make: intercept it or
 * not, and how. Kept pure and imported by the SW entry (`serviceWorker.ts`) rather than
 * inlined there, so it has its own test file instead of only being provable by driving a
 * real `ServiceWorkerGlobalScope`.
 *
 * The rule is same-origin GET only — not "skip /v1/*". `apps/mobile` talks to a cloud API
 * on its OWN origin per Decision 3 (docs/plan/README.md, Phase 27), so an origin check
 * alone already lets every cloud call pass through untouched. That matters because
 * `event.respondWith` on anything but a bare passthrough breaks a streaming response:
 * `GET /v1/events` is Server-Sent Events, and the OIDC token exchange is a POST (excluded
 * on method alone, before origin is even checked). Whatever this function returns `null`
 * for, the SW's fetch listener must not call `respondWith` at all — not even a bare
 * `fetch(request)` forward — so the browser's own handling of streaming, credentials and
 * redirects stays untouched. See `serviceWorker.ts`.
 */

/**
 * Structural rather than the DOM `Request` type: lets tests build cases as plain object
 * literals instead of going through `new Request(url, { mode: 'navigate' })`, which the
 * Fetch spec forbids constructing directly (`navigate` is reserved for real browser
 * navigations). A real `FetchEvent#request` already satisfies this shape as-is.
 */
export interface HandleableRequest {
  readonly method: string;
  readonly url: string;
  readonly mode?: string;
}

export type Strategy = 'cache-first' | 'network-first' | null;

/** Vite's own default — see vite.config.ts's untouched `build.assetsDir`. */
const ASSET_PREFIX = '/assets/';

export function shouldHandle(request: HandleableRequest, selfOrigin: string): Strategy {
  if (request.method !== 'GET') return null;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin !== selfOrigin) return null;

  // Content-hashed — a stale cache entry can never be served for a live filename, which
  // is what makes caching it unconditionally safe.
  if (url.pathname.startsWith(ASSET_PREFIX)) return 'cache-first';

  // A page load/navigation: prefer a fresh network response, but let the app open offline
  // from whatever was cached the last time it succeeded.
  if (request.mode === 'navigate') return 'network-first';

  return null;
}
