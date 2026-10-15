/**
 * mediaPermission — a blanket deny for `media` (microphone and camera alike; Electron
 * passes both under that one permission name), registered session-wide.
 *
 * The F9.7 spike found `getUserMedia({ audio: true })` is granted **silently** when no
 * `setPermissionRequestHandler` is registered at all — no prompt, the real device label
 * handed back to whatever renderer code asked. That alone requires a handler regardless
 * of Web Speech's outcome (it failed; see F9.7's findings). The spike also found Electron
 * reports the request-time origin to `setPermissionRequestHandler` as the opaque string
 * `"null"` for a packaged `file://` renderer, even though `setPermissionCheckHandler` sees
 * `"file:///"` for that same request — a handler written to string-match a literal
 * `file://` origin denies its own app. Denying by *permission name* rather than by origin
 * sidesteps that mismatch entirely, and is the correct scope while the desktop has no
 * in-app mic path (F9.10 ships the OS-dictation hint instead).
 *
 * A future in-app mic path must grant audio by *webContents identity* (the main window's,
 * via the handler's `webContents` argument) rather than by origin string, since origin
 * alone cannot be trusted to tell this app's renderer apart from anything else loaded into
 * the same session.
 */
import type { Session } from 'electron';

/** `false` denies `media` (mic + camera); every other permission keeps today's default. */
export function allowPermission(permission: string): boolean {
  return permission !== 'media';
}

export function registerMediaPermissionGuard(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowPermission(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => allowPermission(permission));
}
