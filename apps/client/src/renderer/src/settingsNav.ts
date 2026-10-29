/**
 * The desktop Settings' section ids and how one maps onto the grouped nav (v10 mockup).
 *
 * Every connection provider kept its own id when they folded into the one Integrations nav
 * item, so a deep link — the palette's "Settings: JIRA", the Board pane's link to the status
 * map — still names the provider it wants. {@link resolveSettingsNav} is the one place that
 * turns such an id into the nav item to select plus the provider tab to open inside it. Pure,
 * with no React, so `settingsNav.test.ts` can pin it without a DOM.
 */

/** The providers drawn as the horizontal tabs inside Integrations, in tab order. */
export const SETTINGS_PROVIDERS = [
  { id: 'jira', title: 'JIRA' },
  { id: 'gitlab', title: 'GitLab' },
  { id: 'github', title: 'GitHub' },
  { id: 'cloud', title: 'Cloud' },
] as const;

export type SettingsProvider = (typeof SETTINGS_PROVIDERS)[number]['id'];

/** One item of the grouped nav. */
export type SettingsNavSection =
  | 'general'
  | 'board'
  | 'features'
  | 'people'
  | 'skills'
  | 'workflows'
  | 'promptTemplates'
  | 'integrations'
  | 'agentsModels'
  | 'appearance'
  | 'shortcuts'
  | 'executionTarget'
  | 'updates';

/** Anything Settings can be asked to open: a nav item, or a provider inside Integrations. */
export type SettingsSection = SettingsNavSection | SettingsProvider;

export interface ResolvedSettingsNav {
  nav: SettingsNavSection;
  /** Set only when the section asked for was a provider. */
  provider?: SettingsProvider;
}

function isProvider(section: SettingsSection): section is SettingsProvider {
  return SETTINGS_PROVIDERS.some((p) => p.id === section);
}

/** A provider id opens Integrations on that provider's tab; any other id is its own nav item. */
export function resolveSettingsNav(section: SettingsSection): ResolvedSettingsNav {
  return isProvider(section) ? { nav: 'integrations', provider: section } : { nav: section };
}
