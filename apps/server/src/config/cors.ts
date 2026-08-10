/**
 * Which browser origins may call the mirror API.
 *
 * `main.ts` used to call a bare `app.enableCors()`, which sets
 * `Access-Control-Allow-Origin: *` — every site on the internet may make requests to this
 * API from a visitor's browser. That is survivable only while nothing is deployed: the
 * bearer token is the real gate, and `*` cannot be combined with credentials. It is still
 * the wrong default for a public hostname, because it invites any page to spend a visitor's
 * token against this API on their behalf if one ever leaks into a place a script can read.
 *
 * So the origins are named, via `CLOUD_ALLOWED_ORIGINS` (comma-separated). The deployed
 * value is the Static Web App's own origin and nothing else.
 *
 * When the variable is unset the answer depends on `NODE_ENV`, and the two cases are
 * deliberately opposite:
 *
 *  - **not production** — the local Vite dev server, on whichever port it grabbed. Vite
 *    walks up from 5173 when a port is busy (this is how `apps/web` came up on 5175), so
 *    pinning one port would break the second dev server someone starts. Any `localhost`
 *    origin is allowed instead; none of them are reachable from another machine.
 *  - **production** — nothing. An unset variable in a deployment is a missing
 *    configuration, and answering it with `*` is how a wide-open API ships without anyone
 *    deciding to. A blocked browser call is a loud, obvious failure; a silently permissive
 *    one is not.
 *
 * Non-browser callers (the desktop Client, curl, the health probe) are unaffected either
 * way — CORS is enforced by browsers, not servers.
 */

/** What `main.ts` hands to `app.enableCors({ origin })`. */
export type CorsOrigin = string[] | ((origin: string | undefined, cb: CorsCallback) => void);

type CorsCallback = (err: Error | null, allow?: boolean) => void;

export function corsOrigin(env: NodeJS.ProcessEnv = process.env): CorsOrigin {
  const configured = (env.CLOUD_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);

  if (configured.length > 0) return configured;
  if (env.NODE_ENV === 'production') return [];

  return (origin, callback) => {
    // A request with no Origin header is not a cross-origin browser request at all
    // (curl, the health probe, the desktop Client) — there is nothing to refuse.
    if (origin === undefined) return callback(null, true);
    callback(null, isLocalhostOrigin(origin));
  };
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    // Not a URL — no reason to trust it.
    return false;
  }
}
