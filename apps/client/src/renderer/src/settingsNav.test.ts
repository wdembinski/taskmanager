import { describe, expect, it } from 'vitest';
import { resolveSettingsNav, SETTINGS_PROVIDERS } from './settingsNav';

describe('resolveSettingsNav', () => {
  it('opens Integrations on the provider tab for every provider id', () => {
    for (const { id } of SETTINGS_PROVIDERS) {
      expect(resolveSettingsNav(id)).toEqual({ nav: 'integrations', provider: id });
    }
  });

  it('maps any other id to itself, with no provider', () => {
    for (const id of ['general', 'integrations', 'agentsModels', 'updates'] as const) {
      expect(resolveSettingsNav(id)).toEqual({ nav: id });
    }
  });
});
