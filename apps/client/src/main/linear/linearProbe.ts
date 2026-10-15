/**
 * What "Test connection" tells the Settings pane, once the viewer, organization and team
 * list have all come back — pure, so the branches below are testable without a fake server.
 *
 * A valid key always answers the viewer and org request; it is the TEAM list that tells you
 * whether the `teamKeys` already configured actually point at anything. Matching is
 * case-insensitive because Linear's own team-key picker and a hand-typed settings value can
 * disagree on case without disagreeing on which team they mean.
 */
import type { JiraTestResult } from '@shared/ipc';
import type { LinearTeam } from './linearClient';

export interface LinearProbeInput {
  viewer: { displayName: string };
  organization: { name: string; urlKey: string };
  teams: LinearTeam[];
  teamKeys: readonly string[];
  /** `linear.enabled` — never gates the probe itself; only whether the message nudges you to flip it on. */
  enabled: boolean;
}

/** `describeLinearProbe`'s result, structurally `JiraTestResult`. */
export type LinearProbeResult = JiraTestResult;

export function describeLinearProbe({
  viewer,
  organization,
  teams,
  teamKeys,
  enabled,
}: LinearProbeInput): LinearProbeResult {
  // Deduped case-insensitively — "ENG" and "eng" name the same team, so the message should
  // only ever mention it once, under whichever casing was typed first.
  const seenKeys = new Set<string>();
  const configured: string[] = [];
  for (const raw of teamKeys) {
    const key = raw.trim();
    if (!key || seenKeys.has(key.toLowerCase())) continue;
    seenKeys.add(key.toLowerCase());
    configured.push(key);
  }
  const reminder = enabled ? '' : ' Switch Linear on above to start syncing.';

  if (configured.length === 0) {
    return {
      ok: true,
      displayName: viewer.displayName,
      message:
        `Connected as ${viewer.displayName} to ${organization.name} — pick the teams to ` +
        `mirror below.${reminder}`,
    };
  }

  const found: string[] = [];
  const missing: string[] = [];
  for (const key of configured) {
    const match = teams.find((team) => team.key.toLowerCase() === key.toLowerCase());
    if (match) found.push(match.key);
    else missing.push(key);
  }

  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'team' : 'teams';
    const verb = missing.length === 1 ? "isn't" : "aren't";
    const existing = teams.length > 0 ? teams.map((team) => team.key).join(', ') : 'none';
    return {
      ok: false,
      displayName: viewer.displayName,
      message:
        `Connected as ${viewer.displayName} (${organization.name}), but ${noun} ` +
        `${missing.join(', ')} ${verb} in this workspace — teams: ${existing}.`,
    };
  }

  return {
    ok: true,
    displayName: viewer.displayName,
    message: `Connected as ${viewer.displayName} to ${organization.name} — ${found.join(', ')} found.${reminder}`,
  };
}
