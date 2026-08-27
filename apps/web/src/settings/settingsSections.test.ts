import { describe, expect, it } from 'vitest';
import { sectionNeedsSettings, type SettingsSection } from './settingsSections';

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

  it('still gates the panes that render AppSettings fields', () => {
    // These three ARE forms over the blob, so they genuinely cannot draw until it loads.
    expect(sectionNeedsSettings('general')).toBe(true);
    expect(sectionNeedsSettings('board')).toBe(true);
    expect(sectionNeedsSettings('jira')).toBe(true);
  });

  it('classifies every section — no pane is left unclassified', () => {
    // Exhaustive over the union: if a new section is added to `SettingsSection`, this array
    // stops compiling until it is listed, which is the review gate that stops a new pane from
    // silently defaulting either way.
    const all: Record<SettingsSection, boolean> = {
      general: true,
      board: true,
      projects: false,
      jira: true,
      tokens: false,
      people: false,
      desktop: false,
    };
    for (const [section, expected] of Object.entries(all)) {
      expect(sectionNeedsSettings(section as SettingsSection)).toBe(expected);
    }
  });
});
