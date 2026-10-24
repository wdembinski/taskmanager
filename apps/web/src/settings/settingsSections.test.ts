import { describe, expect, it } from 'vitest';
import {
  resolveWebSettingsNav,
  sectionNeedsSettings,
  WEB_SETTINGS_GROUPS,
  type SettingsSection,
} from './settingsSections';

describe('sectionNeedsSettings', () => {
  it('lets the Personal access tokens pane render without settings — the bootstrap fix', () => {
    // A fresh account has no desktop polling, so the relayed `settings:get` never answers.
    // The token page must still be reachable: minting a PAT here is how the FIRST desktop
    // gets connected, so gating it behind a desktop-only read is a deadlock.
    expect(sectionNeedsSettings('tokens')).toBe(false);
  });

  it('keeps every desktop-independent pane reachable with no settings', () => {
    // People, the Projects list and the Desktop-only notices each reach the server (or a
    // static list) on their own — none of them reads an `AppSettings` field.
    expect(sectionNeedsSettings('people')).toBe(false);
    expect(sectionNeedsSettings('projects')).toBe(false);
    expect(sectionNeedsSettings('desktop')).toBe(false);
  });

  it('lets the Shortcuts pane render without settings — it is a static list', () => {
    // `KeyboardShortcutsList` holds no `AppSettings` field, same reasoning as Skills and
    // Workflows below, so it draws whether or not `settings:get` has answered.
    expect(sectionNeedsSettings('shortcuts')).toBe(false);
  });

  it('still gates the panes that render AppSettings fields', () => {
    // These six ARE forms over the blob, so they genuinely cannot draw until it loads.
    expect(sectionNeedsSettings('general')).toBe(true);
    expect(sectionNeedsSettings('board')).toBe(true);
    expect(sectionNeedsSettings('features')).toBe(true);
    expect(sectionNeedsSettings('jira')).toBe(true);
    expect(sectionNeedsSettings('linear')).toBe(true);
    expect(sectionNeedsSettings('promptTemplates')).toBe(true);
  });

  it('lets the Skills pane render without settings — it loads itself', () => {
    // `SkillsSection` owns its own `skill:list`/`project:list` round trip and holds no
    // `AppSettings` field, so it draws whether or not `settings:get` has answered.
    expect(sectionNeedsSettings('skills')).toBe(false);
  });

  it('lets the Workflows pane render without settings — it loads itself', () => {
    // `WorkflowBuilder` owns its own `workflow:list` round trip and holds no `AppSettings`
    // field, same as `SkillsSection` above, so it draws whether or not `settings:get` has
    // answered.
    expect(sectionNeedsSettings('workflows')).toBe(false);
  });

  it('classifies every section — no pane is left unclassified', () => {
    // Exhaustive over the union: if a new section is added to `SettingsSection`, this array
    // stops compiling until it is listed, which is the review gate that stops a new pane from
    // silently defaulting either way.
    const all: Record<SettingsSection, boolean> = {
      general: true,
      board: true,
      features: true,
      projects: false,
      integrations: true,
      jira: true,
      linear: true,
      tokens: false,
      people: false,
      desktop: false,
      skills: false,
      workflows: false,
      promptTemplates: true,
      appearance: true,
      shortcuts: false,
    };
    for (const [section, expected] of Object.entries(all)) {
      expect(sectionNeedsSettings(section as SettingsSection)).toBe(expected);
    }
  });

  it('gates the Integrations and Appearance panes — both render AppSettings fields', () => {
    // Integrations holds the JIRA and Linear forms; Appearance holds Monochrome code beside
    // the per-browser theme, so neither can draw its Save-backed half before the blob loads.
    expect(sectionNeedsSettings('integrations')).toBe(true);
    expect(sectionNeedsSettings('appearance')).toBe(true);
  });
});

describe('WEB_SETTINGS_GROUPS', () => {
  it('groups the nav as the v10 mockup does, with Tokens under Connections', () => {
    expect(
      WEB_SETTINGS_GROUPS.map((g) => [g.heading, g.items.map((i) => i.title)] as const),
    ).toEqual([
      [
        'Workspace',
        [
          'General',
          'Board',
          'Features',
          'Projects',
          'People',
          'Skills',
          'Workflows',
          'Prompt templates',
        ],
      ],
      ['Connections', ['Integrations', 'Tokens']],
      ['This machine', ['Appearance', 'Shortcuts', 'Desktop only']],
    ]);
  });

  it('lists every nav section exactly once, and no provider as a nav item', () => {
    // JIRA and Linear live inside Integrations; a nav item for either would draw it twice.
    const ids = WEB_SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('jira');
    expect(ids).not.toContain('linear');
  });
});

describe('resolveWebSettingsNav', () => {
  it('opens a provider id as Integrations on that provider’s tab', () => {
    expect(resolveWebSettingsNav('jira')).toEqual({ nav: 'integrations', provider: 'jira' });
    expect(resolveWebSettingsNav('linear')).toEqual({ nav: 'integrations', provider: 'linear' });
  });

  it('opens any other id as its own nav item', () => {
    expect(resolveWebSettingsNav('tokens')).toEqual({ nav: 'tokens' });
    expect(resolveWebSettingsNav('appearance')).toEqual({ nav: 'appearance' });
  });
});
