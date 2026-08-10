/**
 * Readiness for the local machine, phrased the same way as a WSL target's.
 *
 * The app has always had a local Claude check (`claudeStatus.ts`) and it stays the
 * source of truth — this only re-shapes its answer into the per-target form the
 * Settings panel renders, so both targets read identically in the UI instead of
 * having one bespoke banner and one list.
 */
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  type ExecTarget,
  type TargetReadiness,
} from '@shared/execTarget';
import type { ClaudeStatus } from '@shared/ipc';
import { getClaudeStatus } from '../claudeStatus';
import { probeWslTarget } from './wsl';

export async function localReadiness(): Promise<TargetReadiness> {
  const status = await getClaudeStatus();
  return {
    target: LOCAL_TARGET,
    // An API key is a billing warning, not a blocker — it does not gate `ok`.
    ok: status.installed && status.authenticated,
    checks: [
      {
        id: 'claude',
        label: 'Claude CLI found',
        ok: status.installed,
        detail: status.version ?? 'not on PATH',
        fix: status.installed ? undefined : 'Install Claude Code and restart the app.',
      },
      {
        id: 'auth',
        label: 'Logged in',
        ok: status.authenticated,
        detail: status.authenticated ? 'subscription credentials present' : 'no credentials file',
        fix: status.authenticated ? undefined : 'Run `claude` once and sign in.',
      },
      {
        id: 'billing',
        label: 'Using your subscription',
        ok: !status.apiKeyDetected,
        detail: status.apiKeyDetected ? 'ANTHROPIC_API_KEY is set' : 'no API key set',
        fix: status.apiKeyDetected
          ? 'Unset ANTHROPIC_API_KEY so runs bill your subscription, not the paid API.'
          : undefined,
      },
    ],
  };
}

/** Readiness for one target, whichever machine it names. */
export function readinessFor(target: ExecTarget): Promise<TargetReadiness> {
  return target.kind === 'wsl' ? probeWslTarget(target.distro) : localReadiness();
}

/**
 * The app-wide "is Claude ready" answer, across the machines the user's projects
 * ACTUALLY run on.
 *
 * The original check only ever asked the local machine, which is wrong the moment a
 * project runs in WSL: someone whose `claude` lives only inside a distro got a
 * permanent "the CLI was not found on your PATH" warning while everything worked.
 * A machine nothing runs on is not a problem worth a banner.
 */
export async function statusForTargets(targets: ExecTarget[]): Promise<ClaudeStatus> {
  const seen = new Map<string, ExecTarget>();
  for (const target of targets) seen.set(formatExecTarget(target), target);
  const unique = [...seen.values()];
  if (unique.length === 0) return getClaudeStatus();

  const results = await Promise.all(unique.map(readinessFor));

  // An API key only reaches a LOCAL run: environment variables do not cross into WSL
  // unless forwarded through WSLENV, and we forward only the relay's own.
  const apiKeyDetected =
    unique.some((t) => t.kind === 'local') && Boolean(process.env.ANTHROPIC_API_KEY);

  const check = (r: TargetReadiness, id: string): boolean =>
    r.checks.find((c) => c.id === id)?.ok ?? false;
  const installed = results.every((r) => check(r, 'claude'));
  const authenticated = results.every((r) => check(r, 'auth'));

  const broken = results.find((r) => !r.ok);
  const version = results
    .map((r) => r.checks.find((c) => c.id === 'claude')?.detail ?? '')
    .map((d) => d.match(/\d+\.\d+\.\d+/)?.[0])
    .find(Boolean);

  let message: string;
  if (!broken) {
    const where =
      unique.length === 1 && unique[0].kind === 'local'
        ? 'with your subscription'
        : `on ${unique.map(execTargetLabel).join(', ')}`;
    message = `Claude ${version ?? ''} is installed and logged in ${where}.`.replace('  ', ' ');
  } else if (apiKeyDetected) {
    message =
      'ANTHROPIC_API_KEY is set — Claude would bill the paid API. Unset it to use your subscription for free.';
  } else {
    // Name the machine: "not found" is unactionable when several are in play.
    const failed = broken.checks.find((c) => !c.ok);
    message = `${execTargetLabel(broken.target)}: ${failed?.label ?? 'not ready'} — ${
      failed?.fix ?? failed?.detail ?? 'see Settings'
    }`;
  }

  return { installed, version, authenticated, apiKeyDetected, message };
}
