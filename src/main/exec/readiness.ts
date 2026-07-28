/**
 * Readiness for the local machine, phrased the same way as a WSL target's.
 *
 * The app has always had a local Claude check (`claudeStatus.ts`) and it stays the
 * source of truth — this only re-shapes its answer into the per-target form the
 * Settings panel renders, so both targets read identically in the UI instead of
 * having one bespoke banner and one list.
 */
import { LOCAL_TARGET, type TargetReadiness } from '@shared/execTarget';
import { getClaudeStatus } from '../claudeStatus';

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
