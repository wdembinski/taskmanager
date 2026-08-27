/**
 * Which Settings panes can only draw once `settings:get` has answered — and, by the same
 * token, which are reachable with no desktop app polling at all.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `settings:get` is a RELAYED read (`@tm/shared/ipcRelay`): a browser tab posts an
 * `ipc-invoke` and waits for a desktop client to answer it. With no desktop on the account it
 * never resolves. `SettingsScreen` used to gate its WHOLE shell behind that one read, which
 * trapped every tab — including **Personal access tokens**, the page whose only job is to mint
 * the credential you paste into your first desktop. That is a bootstrap deadlock: you need a
 * desktop to reach the page that lets you connect a desktop.
 *
 * Only the panes that render `AppSettings` FIELDS actually need the blob. The token page, the
 * People pane, the Projects list and the Desktop-only notices all reach the server (or a
 * static list) on their own and must render whether or not a desktop is awake. This predicate
 * is the seam that keeps the two sets honest, and is unit-tested directly so the rule cannot
 * quietly drift back to "the whole screen waits".
 */

export type SettingsSection =
  'general' | 'board' | 'projects' | 'jira' | 'tokens' | 'people' | 'desktop';

/**
 * The sections whose form reads `AppSettings`. Everything NOT here draws without it — see the
 * file header for why that distinction is the whole point.
 */
const SECTIONS_NEEDING_SETTINGS: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  'general',
  'board',
  'jira',
]);

/** Whether this pane can only render once `settings:get` has answered. */
export function sectionNeedsSettings(section: SettingsSection): boolean {
  return SECTIONS_NEEDING_SETTINGS.has(section);
}
