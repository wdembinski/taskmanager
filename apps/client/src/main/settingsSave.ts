/**
 * The body of `settings:save` — validate, normalise, store, reschedule, and then tell every
 * listener what was stored. Kept here rather than inline in `ipc.ts`, which has no test
 * harness of its own, so the one rule that matters most can be pinned: a save is followed by
 * exactly one `settings:changed`, carrying the STORED blob. Without that broadcast the
 * renderer root never re-reads appearance or font size, and `send`'s own `nativeTheme`
 * update never fires, so a changed setting only showed after a Ctrl+R.
 *
 * The payload is `store.getSettings()` after the save, not the argument: the stored blob
 * carries the normalised URLs, the surviving `apiBaseUrl` and the machine-local trust the
 * argument never had a say in. No listener saves in response, so the broadcast cannot loop.
 */
import { AGENT_ROLES, isEffort, isUsableModel } from '@shared/model';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import type { AppSettings } from '@shared/settings';
import { preserveLocalTrust } from './gateTrust';

export interface SettingsSaveDeps {
  store: { getSettings(): AppSettings; saveSettings(settings: AppSettings): void };
  send(channel: 'settings:changed', payload: AppSettings): void;
  syncPoller: { reschedule(): void };
  cloudPoller: { reschedule(): void };
  cloudBoardPuller: { reschedule(): void };
  pushSyncState(): void;
}

export function saveAndBroadcastSettings(deps: SettingsSaveDeps, settings: AppSettings): void {
  const { store } = deps;
  // A relayed write from the web can name any model string — see the identical guard
  // in `task:assignAgent`. `defaultModel`/`defaultPlanningModel` are both replayed
  // straight from the cloud settings mirror (see `settings.ts`'s global-keys list).
  if (!isUsableModel(settings.defaultModel)) {
    throw new Error(`Not a usable model: ${settings.defaultModel}`);
  }
  if (settings.defaultPlanningModel !== null && !isUsableModel(settings.defaultPlanningModel)) {
    throw new Error(`Not a usable model: ${settings.defaultPlanningModel}`);
  }
  // `defaultEfforts` is a global key too, and each value reaches a spawned CLI as `--effort`.
  // A missing blob or role is fine — `getSettings` reads it back as `high` — but a value
  // that is not an `Effort` is refused rather than stored.
  const efforts: unknown = (settings as Partial<AppSettings>).defaultEfforts;
  if (efforts !== undefined) {
    if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts)) {
      throw new Error('Not a usable set of default efforts.');
    }
    for (const role of AGENT_ROLES) {
      const effort = (efforts as Record<string, unknown>)[role];
      if (effort !== undefined && !isEffort(effort)) {
        throw new Error(`Not a usable effort for ${role}: ${String(effort)}`);
      }
    }
  }
  // Normalize the JIRA URL once, on the way in, so every consumer sees the same
  // origin — the client, the epic-field and identity caches (both keyed by baseUrl),
  // and the issue links written onto cards.
  const storedSettings = store.getSettings();
  const stored = storedSettings.jira;
  const baseUrl = normalizeBaseUrl(settings.jira.baseUrl);
  // The discovered API gateway belongs to ONE site and ONE deployment mode, and it is
  // never typed — the probe writes it (see `JiraSettings.apiBaseUrl`). Two rules follow.
  // Point the settings at a different site, or flip the dropdown, and it is stale, so it
  // goes. Otherwise it survives a form the renderer read BEFORE the probe found it —
  // which is every save that follows a Test connection, and losing it there would undo
  // the fix on the next click.
  const gatewayStillApplies =
    baseUrl === normalizeBaseUrl(stored.baseUrl) && settings.jira.deployment === stored.deployment;
  store.saveSettings({
    ...settings,
    jira: {
      ...settings.jira,
      baseUrl,
      cloudEmail: settings.jira.cloudEmail.trim(),
      apiBaseUrl: gatewayStillApplies
        ? settings.jira.apiBaseUrl?.trim() || stored.apiBaseUrl || ''
        : '',
    },
    cloud: { ...settings.cloud, baseUrl: normalizeBaseUrl(settings.cloud.baseUrl) },
    // Machine-local trust (F8.8) never travels on this channel — see `preserveLocalTrust`.
    trustedGateCommands: preserveLocalTrust(storedSettings, settings),
  });
  // Pick up a changed poll interval (or enable/disable) without a restart.
  deps.syncPoller.reschedule();
  // Same reason, on the cloud mirror's own clock — an edit to `cloud.enabled`/`baseUrl`
  // takes effect at once rather than waiting for whatever tick was already in flight.
  deps.cloudPoller.reschedule();
  deps.cloudBoardPuller.reschedule();
  // The countdown is drawn from the interval, so a changed one has to reach the bar or
  // the ring would keep draining at the old rate until the next sync landed.
  deps.pushSyncState();
  // Appearance, font size and the native theme all follow this event — see the header.
  deps.send('settings:changed', store.getSettings());
}
