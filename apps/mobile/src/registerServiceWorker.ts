/**
 * Registers the service worker built by `vite.sw.config.ts` — see that file's header for
 * why it is a second build rather than an entry in this one.
 *
 * Guarded on `PROD`: `dist/sw.js` does not exist under `vite dev`, and a dev session
 * behind a stale cached bundle is a worse debugging experience than having no service
 * worker at all. Guarded on the API existing at all, since `main.tsx` runs on whatever
 * browser opened the page, not only Chrome/WebAPK.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
