import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { forgeBaseUrl } from './baseUrl';

/** Settings with each forge's URL wherever the test needs it. */
function settings(patch: {
  github?: Partial<AppSettings['github']>;
  gitlab?: Partial<AppSettings['gitlab']>;
}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    github: { ...DEFAULT_SETTINGS.github, ...patch.github },
    gitlab: { ...DEFAULT_SETTINGS.gitlab, ...patch.gitlab },
  };
}

describe('forgeBaseUrl', () => {
  it('hands back the configured instance for either forge', () => {
    const s = settings({
      github: { baseUrl: 'https://ghe.example.com/api/v3' },
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    });
    expect(forgeBaseUrl('github', s)).toBe('https://ghe.example.com/api/v3');
    expect(forgeBaseUrl('gitlab', s)).toBe('https://gitlab.example.com');
  });

  it('names the SETTING when it is blank, not the forge', () => {
    // `TypeError: Invalid URL` out of `fetch` is what this replaces — a refusal that names
    // neither the forge nor the field nor the screen it is on.
    const blank = settings({ github: { baseUrl: '' }, gitlab: { baseUrl: '   ' } });
    expect(() => forgeBaseUrl('github', blank)).toThrow(/GitHub API URL/);
    expect(() => forgeBaseUrl('gitlab', blank)).toThrow(/GitLab URL/);
    // GitHub's field takes an API root, so telling somebody to set "the GitHub URL" sends
    // them to paste https://github.com — the one value that cannot work.
    expect(() => forgeBaseUrl('github', blank)).toThrow(/Settings/);
  });

  it('trims what it returns, because the clients do not', () => {
    // `GitLabClient.url` strips a trailing slash but never trims: a pasted URL with a space
    // on it passes every `.trim()` test written around it and still builds an unfetchable
    // string. Same shape as a token pasted with a newline on it.
    const padded = settings({ gitlab: { baseUrl: '  https://gitlab.example.com  ' } });
    expect(forgeBaseUrl('gitlab', padded)).toBe('https://gitlab.example.com');
  });
});
