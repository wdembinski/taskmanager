/**
 * Machine-local trust for gate commands (F8.8) — the hashing and set operations behind
 * `AppSettings.trustedGateCommands`. A command is trusted only once a human has told THIS
 * desktop to run it; everything here is pure and synchronous, so the engine (`gateStep.ts`)
 * and the scheduler can call it without touching the store themselves.
 *
 * Hashing is over the EXACT bytes of the command, with no normalisation. That is
 * deliberate: a trust decision is a decision about one specific string, and silently
 * forgiving whitespace or a single edited character would let a trusted command stand in
 * for one the human never actually saw.
 *
 * Also carries `preserveLocalTrust`, `settings:save`'s one rule for this field — kept here
 * rather than inline in `ipc.ts`, which has no test harness of its own (see that file's own
 * header) and moves exactly this kind of decision out into a pure, tested module.
 */
import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a gate command's exact bytes. */
export function gateCommandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

/** Whether `command`'s exact bytes match a hash already in `trusted`. */
export function isCommandTrusted(trusted: readonly string[], command: string): boolean {
  return trusted.includes(gateCommandHash(command));
}

/** `trusted` with `hash` added, deduped, order-preserving. */
export function withTrustedHash(trusted: readonly string[], hash: string): string[] {
  return trusted.includes(hash) ? [...trusted] : [...trusted, hash];
}

/**
 * `settings:save`'s answer for `trustedGateCommands`: always the machine's OWN stored list,
 * never whatever a relayed or stale blob carries.
 *
 * Trust is machine-local (`GLOBAL_SETTINGS_KEYS` never carries it, see `settings.ts`), so a
 * browser tab's blob can only ever be stale about it — it was read before `gate:trust` last
 * wrote, or it is a replay of another desktop's settings mirror. Either way the incoming
 * value is ignored outright rather than merged; only `trustGateCommand` may add a hash.
 */
export function preserveLocalTrust(
  stored: { trustedGateCommands: string[] },
  _incoming: { trustedGateCommands: string[] },
): string[] {
  return stored.trustedGateCommands;
}
