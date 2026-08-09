/**
 * A tiny append-only log file for the main process.
 *
 * A packaged app has nowhere to put `console.error`: on Windows there is no console at
 * all, and on Linux a `.desktop` launcher discards stderr. That is why the v0.25.0
 * Linux startup crash (a wrong-ABI `better_sqlite3.node`) was invisible unless you
 * happened to run the binary from a terminal. Everything that goes wrong in main now
 * also lands in a file the user can be asked for.
 *
 * Deliberately dependency-free (no `electron-log`): append a line, never rotate more
 * than once, and never throw — a logger that can crash the app defeats its purpose.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Roll over at 2 MB, keeping exactly one previous file (`main.log.1`). */
const MAX_BYTES = 2 * 1024 * 1024;

let logPath: string | undefined;

/**
 * Resolve (and create) the log file path. Electron's `logs` directory is the OS
 * convention — `%APPDATA%/<app>/logs` on Windows, `~/.config/<app>/logs` on Linux.
 * Called lazily because `app.getPath` needs the app to have been constructed.
 */
export function getLogPath(): string {
  if (!logPath) {
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'main.log');
  }
  return logPath;
}

/** Format an unknown thrown value into something worth reading in a log. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    // `cause` carries the real reason for wrapped failures — most importantly the
    // ECONNREFUSED/ENOTFOUND/TLS detail hidden behind undici's bare "fetch failed".
    const cause = err.cause ? `\nCaused by: ${formatError(err.cause)}` : '';
    return `${err.stack ?? `${err.name}: ${err.message}`}${cause}`;
  }
  return String(err);
}

/** Append one timestamped entry. Also mirrors to stderr, which helps in development. */
export function logMain(message: string, err?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}${err === undefined ? '' : `\n${formatError(err)}`}\n`;
  console.error(line.trimEnd());
  try {
    const path = getLogPath();
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, line, 'utf8');
  } catch {
    // Disk full, read-only home, no userData yet — never let logging break the app.
  }
}
