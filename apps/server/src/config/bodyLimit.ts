/**
 * How large a `POST /v1/sync` body this API will accept.
 *
 * Nest's default JSON body parser stops at express's own 100 kB. That was never noticed
 * because the outbox only ever carried the handful of rows a user had just touched — but
 * one full `Task` is not small (title, description, plan, the chat transcript), so a burst
 * of a few hundred of them (a backfill, a first sync of an existing profile) is comfortably
 * past 100 kB. The failure is a `413 Payload Too Large` that the Client counts as a plain
 * network error and retries forever with the SAME body, so the mirror never catches up.
 *
 * Two limits work together, and only both together are safe:
 *
 *  - the Client caps a batch at `SYNC_BYTES_LIMIT` (1 MB — see `cloudDelta.ts`), so a
 *    request is bounded at the only place that can split the work across ticks;
 *  - this limit is the server's backstop, deliberately several times larger. A cap that
 *    merely matches the Client's would turn every estimation error — the Client measures
 *    the entities, not the framing around them — into a 413.
 *
 * `CLOUD_BODY_LIMIT` overrides it (anything express's `bytes` understands: `512kb`,
 * `8mb`, or a raw byte count). An unparseable value falls back to the default rather than
 * refusing to boot — a typo in a size string should not take the API down — and `main.ts`
 * says so loudly on startup via {@link isBodyLimit}.
 */

/** Roughly a hundred full tasks' worth of headroom over the Client's own 1 MB batch cap. */
export const DEFAULT_BODY_LIMIT = '8mb';

/** `100`, `512kb`, `8mb`, `1.5gb` — the subset of express's `bytes` syntax worth accepting. */
const LIMIT_PATTERN = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/;

/** Whether `value` is a size string this API would honour. Exported so `main.ts` can tell
 *  "unset" (use the default, quietly) from "set to nonsense" (use the default, loudly). */
export function isBodyLimit(value: string): boolean {
  const match = LIMIT_PATTERN.exec(value.trim().toLowerCase());
  // A zero limit parses fine and rejects every request — not a configuration anyone means.
  return match !== null && Number(match[1]) > 0;
}

export function bodyLimit(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.CLOUD_BODY_LIMIT ?? '').trim().toLowerCase();
  if (configured.length === 0) return DEFAULT_BODY_LIMIT;
  return isBodyLimit(configured) ? configured : DEFAULT_BODY_LIMIT;
}
