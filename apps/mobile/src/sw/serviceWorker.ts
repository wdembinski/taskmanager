/**
 * The service worker itself — thin on purpose. The one decision that matters,
 * same-origin-GET-only routing, lives in `shouldHandle.ts` where it can be unit-tested;
 * this file is just the two cache strategies `shouldHandle` picks between, plus the
 * install/activate bookkeeping that keeps only the current cache around. Built separately
 * by `vite.sw.config.ts` — see that file's header for why one Vite config cannot emit both
 * this and the hashed main bundle — and registered from `registerServiceWorker.ts`.
 *
 * tsconfig.sw.json type-checks this file alone, under WebWorker libs rather than DOM —
 * see that config's header for why the two libs can't share a program.
 */
import { shouldHandle } from './shouldHandle';

declare const self: ServiceWorkerGlobalScope;

/** Bump this to drop every previously cached response on the next activate. */
const CACHE_NAME = 'tm-mobile-v1';

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const strategy = shouldHandle(event.request, self.location.origin);
  if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(event.request));
  } else if (strategy === 'network-first') {
    event.respondWith(networkFirst(event.request));
  }
  // Anything else (a different origin, a non-GET, a same-origin GET that is neither an
  // asset nor a navigation): no respondWith call at all. The browser handles the request
  // exactly as if this service worker were not installed — see shouldHandle.ts's header
  // for why that has to be a bare passthrough rather than a forwarded fetch().
});

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) void cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
