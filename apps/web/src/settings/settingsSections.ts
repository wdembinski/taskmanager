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
 *
 * It also holds the web's grouped nav (v10 mockup, {@link WEB_SETTINGS_GROUPS}): JIRA sits
 * under the Integrations nav item, as a provider tab inside the pane, but keeps its own id so
 * {@link resolveWebSettingsNav} can still open it by name.
 */
import { SETTINGS_NAV_ICONS, type SettingsNavGroup } from '@tm/ui/settings/SettingsPage';

/** The providers drawn as the horizontal tabs inside Integrations, in tab order. */
export const WEB_SETTINGS_PROVIDERS = [{ id: 'jira', title: 'JIRA' }] as const;

export type WebSettingsProvider = (typeof WEB_SETTINGS_PROVIDERS)[number]['id'];

/** One item of the grouped nav. */
export type WebSettingsNavSection =
  | 'general'
  | 'board'
  | 'features'
  | 'projects'
  | 'people'
  | 'skills'
  | 'workflows'
  | 'promptTemplates'
  | 'integrations'
  | 'tokens'
  | 'appearance'
  | 'shortcuts'
  | 'desktop';

/** Anything Settings can be asked to open: a nav item, or a provider inside Integrations. */
export type SettingsSection = WebSettingsNavSection | WebSettingsProvider;

/** The web's grouped nav (plan Decision 2). The token page is titled "Tokens" here; its own
 *  heading still reads "Personal access tokens". */
export const WEB_SETTINGS_GROUPS: Array<
  SettingsNavGroup & { items: Array<{ id: WebSettingsNavSection }> }
> = [
  {
    heading: 'Workspace',
    items: [
      { id: 'general', title: 'General', icon: SETTINGS_NAV_ICONS.general },
      { id: 'board', title: 'Board', icon: SETTINGS_NAV_ICONS.board },
      { id: 'features', title: 'Features', icon: SETTINGS_NAV_ICONS.features },
      { id: 'projects', title: 'Projects', icon: SETTINGS_NAV_ICONS.projects },
      { id: 'people', title: 'People', icon: SETTINGS_NAV_ICONS.people },
      { id: 'skills', title: 'Skills', icon: SETTINGS_NAV_ICONS.skills },
      { id: 'workflows', title: 'Workflows', icon: SETTINGS_NAV_ICONS.workflows },
      {
        id: 'promptTemplates',
        title: 'Prompt templates',
        icon: SETTINGS_NAV_ICONS.promptTemplates,
      },
    ],
  },
  {
    heading: 'Connections',
    items: [
      { id: 'integrations', title: 'Integrations', icon: SETTINGS_NAV_ICONS.integrations },
      { id: 'tokens', title: 'Tokens', icon: SETTINGS_NAV_ICONS.tokens },
    ],
  },
  {
    heading: 'This machine',
    items: [
      { id: 'appearance', title: 'Appearance', icon: SETTINGS_NAV_ICONS.appearance },
      { id: 'shortcuts', title: 'Shortcuts', icon: SETTINGS_NAV_ICONS.shortcuts },
      { id: 'desktop', title: 'Desktop only', icon: SETTINGS_NAV_ICONS.desktopOnly },
    ],
  },
];

export interface ResolvedWebSettingsNav {
  nav: WebSettingsNavSection;
  /** Set only when the section asked for was a provider. */
  provider?: WebSettingsProvider;
}

function isProvider(section: SettingsSection): section is WebSettingsProvider {
  return WEB_SETTINGS_PROVIDERS.some((p) => p.id === section);
}

/** A provider id opens Integrations on that provider's tab; any other id is its own nav item. */
export function resolveWebSettingsNav(section: SettingsSection): ResolvedWebSettingsNav {
  return isProvider(section) ? { nav: 'integrations', provider: section } : { nav: section };
}

/**
 * The sections whose form reads `AppSettings`. Everything NOT here draws without it — see the
 * file header for why that distinction is the whole point. Integrations holds the JIRA
 * form; Appearance holds Monochrome code beside the per-browser theme.
 */
const SECTIONS_NEEDING_SETTINGS: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  'general',
  'board',
  'features',
  'integrations',
  'jira',
  'appearance',
  'promptTemplates',
]);

/** Whether this pane can only render once `settings:get` has answered. */
export function sectionNeedsSettings(section: SettingsSection): boolean {
  return SECTIONS_NEEDING_SETTINGS.has(section);
}
