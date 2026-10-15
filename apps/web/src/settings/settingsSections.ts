/**
 * Which Settings panes can only draw once `settings:get` has answered — and, by the same
 * token, which are reachable with no desktop app polling at all.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `settings:get` used to be a RELAYED read (`@tm/shared/ipcRelay`): a browser tab posted an
 * `ipc-invoke` and waited for a desktop client to answer it, which with no desktop on the
 * account never resolved. It now reads `GET /v1/settings` directly, but `SettingsScreen` still
 * waits on that one call before drawing a pane, which used to trap every tab — including
 * **Personal access tokens**, the page whose only job is to mint the credential you paste into
 * your first desktop. That was a bootstrap deadlock: you needed a desktop to reach the page
 * that lets you connect a desktop.
 *
 * Only the panes that render `AppSettings` FIELDS actually need the blob. The token page, the
 * People pane, the Projects list and the Desktop-only notices all reach the server (or a
 * static list) on their own and must render whether or not that read has answered yet. This
 * predicate is the seam that keeps the two sets honest, and is unit-tested directly so the rule
 * cannot quietly drift back to "the whole screen waits".
 */

export type SettingsSection =
  | 'general'
  | 'board'
  | 'features'
  | 'projects'
  | 'jira'
  | 'linear'
  | 'tokens'
  | 'people'
  | 'desktop'
  | 'skills'
  | 'promptTemplates';

/**
 * The sections whose form reads `AppSettings`. Everything NOT here draws without it — see the
 * file header for why that distinction is the whole point.
 */
const SECTIONS_NEEDING_SETTINGS: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  'general',
  'board',
  'features',
  'jira',
  'linear',
  'promptTemplates',
]);

/** Whether this pane can only render once `settings:get` has answered. */
export function sectionNeedsSettings(section: SettingsSection): boolean {
  return SECTIONS_NEEDING_SETTINGS.has(section);
}
