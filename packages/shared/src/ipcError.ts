/**
 * Turning an IPC rejection back into the sentence the engine meant to say.
 *
 * A handler in `src/main/ipc.ts` that throws `new Error('Sign in from the banner…')` does
 * NOT reach the renderer as that message. Electron serialises the throw across the process
 * boundary and re-prefixes it with the plumbing that carried it, so the UI catches:
 *
 *     Error invoking remote method 'task:run': Error: Sign in from the banner…
 *
 * Every panel in this app renders `e.message` straight into a MessageBar, so the human
 * reads the channel name, the word "remote", and two colons before the first word written
 * for them — and the sentence they need is the tail of a stack-trace-looking string. It
 * reads as a crash rather than as an answer, which is precisely wrong: these throws are
 * ordinary refusals with an action in them.
 *
 * So the bridge unwraps it once, in one place, rather than each of the twenty-odd call
 * sites remembering to. Pure and exported for its own test because the format is
 * Electron's, not ours: if a future version changes the wording, one test fails loudly
 * instead of the prefix silently reappearing everywhere.
 */

/** Electron's own wrapper: `Error invoking remote method '<channel>': `. */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;

/**
 * The re-thrown error's class name, which Electron keeps in the text: `Error: `,
 * `TypeError: `, and so on. Stripped only INSIDE the wrapper — a handler whose message
 * legitimately begins "TypeError: …" (quoting one, say) keeps it when nothing wrapped it.
 */
const ERROR_CLASS_PREFIX = /^[\w$]*Error:\s*/;

/**
 * The human-facing message for anything caught from `window.api.invoke`.
 *
 * Anything that is not one of Electron's wrapped rejections is returned as-is, so this is
 * safe to apply to every channel: an ordinary `Error`, a rejected non-Error value, and a
 * message that merely mentions an error all pass through untouched.
 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!REMOTE_METHOD_PREFIX.test(raw)) return raw;
  const inner = raw.replace(REMOTE_METHOD_PREFIX, '').replace(ERROR_CLASS_PREFIX, '').trim();
  // A handler that threw an empty message leaves nothing to show; the wrapper at least
  // names the channel, which beats a MessageBar with no words in it.
  return inner || raw;
}
