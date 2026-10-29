/**
 * Opt-in timing for the main process's IPC surface (F29.1).
 *
 * Off unless the owner starts the app with `VIPPER_PERF_LOG=1`. When on, every `handle()`d
 * channel writes one `perf ipc …` line per call and every `send` writes one `perf event …`
 * line, so a slow Approve can be read straight out of `main.log` — how long the handler took
 * and how many bytes crossed the bridge each way.
 *
 * Electron-free on purpose, so it can be unit-tested: the caller injects `write` (in the app,
 * `logMain`). Measuring must never change what the handler returns or throws, so every step
 * that could fail on its own — serialising, writing — is swallowed here.
 */
import { performance } from 'node:perf_hooks';

/** Where a perf line goes. `logMain` fits this signature. */
export type PerfWrite = (line: string) => void;

/** Whether `VIPPER_PERF_LOG` asks for perf logging (`1` or `true`, case-insensitive). */
export function perfLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VIPPER_PERF_LOG?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * The UTF-8 byte length of `value` as JSON — roughly what Electron's structured clone has to
 * copy. `undefined` (which `JSON.stringify` drops) counts as 0. A value that cannot be
 * serialised (a cycle, a BigInt) gives `-1` rather than a throw.
 */
export function payloadBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return -1;
  }
}

function safeWrite(write: PerfWrite, line: string): void {
  try {
    write(line);
  } catch {
    // A logger that throws must not turn into a failed IPC call.
  }
}

function formatMs(ms: number): string {
  return ms.toFixed(1);
}

/**
 * Wrap `handler` so each call logs `perf ipc <channel> <ms>ms in=<argBytes>B out=<resultBytes>B`.
 * A rejection is logged with ` err` in place of `out=` and then rethrown unchanged.
 */
export function timeHandler<A extends unknown[], R>(
  channel: string,
  handler: (...args: A) => R,
  write: PerfWrite,
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    const start = performance.now();
    let result: Awaited<R>;
    try {
      result = await handler(...args);
    } catch (err) {
      const ms = performance.now() - start;
      safeWrite(write, `perf ipc ${channel} ${formatMs(ms)}ms in=${payloadBytes(args)}B err`);
      throw err;
    }
    const ms = performance.now() - start;
    safeWrite(
      write,
      `perf ipc ${channel} ${formatMs(ms)}ms in=${payloadBytes(args)}B out=${payloadBytes(result)}B`,
    );
    return result;
  };
}

/** Log one pushed event: `perf event <channel> <bytes>B`. */
export function logEvent(channel: string, payload: unknown, write: PerfWrite): void {
  safeWrite(write, `perf event ${channel} ${payloadBytes(payload)}B`);
}

/**
 * The line for one renderer long task the preload's `logPerf` sent over `perf:longtask`:
 * `perf longtask <screen> <ms>ms`. The payload crossed a process boundary, so its shape is
 * checked rather than trusted — anything without a string `screen` and a finite `ms` gives
 * `null` (nothing to log). Whitespace in `screen` becomes `_` so the line stays greppable.
 */
export function formatLongTask(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { screen, ms } = entry as { screen?: unknown; ms?: unknown };
  if (typeof screen !== 'string' || typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return `perf longtask ${screen.trim().replace(/\s+/g, '_') || '?'} ${formatMs(ms)}ms`;
}
