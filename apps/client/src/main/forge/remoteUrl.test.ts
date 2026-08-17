import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { parseRemoteUrl, pickForge } from './remoteUrl';

/** Settings with each forge switched on/off and pointed wherever the test needs. */
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

describe('parseRemoteUrl', () => {
  it('reads the SCP-like form git@host:owner/repo.git', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('reads an https remote, keeping every subgroup in the path', () => {
    expect(parseRemoteUrl('https://gitlab.ex.com/group/sub/proj.git')).toEqual({
      host: 'gitlab.ex.com',
      path: 'group/sub/proj',
    });
  });

  it('reads an ssh:// remote and drops its port', () => {
    expect(parseRemoteUrl('ssh://git@host.example:22/o/r')).toEqual({
      host: 'host.example',
      path: 'o/r',
    });
  });

  it('tolerates a trailing slash, a missing .git, and mixed case in the host', () => {
    expect(parseRemoteUrl('https://GitHub.com/Owner/Repo/')).toEqual({
      host: 'github.com',
      path: 'Owner/Repo',
    });
  });

  it('answers null for anything that is not a forge remote', () => {
    // A local path is an ordinary remote to have, and has no host to send a PR to.
    expect(parseRemoteUrl('/srv/repos/x.git')).toBeNull();
    expect(parseRemoteUrl('file:///srv/repos/x.git')).toBeNull();
    // A Windows drive letter matches the SCP-like shape exactly; `C:` is not a host.
    expect(parseRemoteUrl('C:\\repos\\x')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
    // A host with no project path underneath it names no repository.
    expect(parseRemoteUrl('https://github.com/owner')).toBeNull();
  });
});

describe('pickForge', () => {
  it('matches the instance the user configured, however obscure the host', () => {
    const s = settings({
      github: { enabled: true, baseUrl: 'https://github.acme.internal' },
      gitlab: { enabled: true, baseUrl: 'https://gitlab.acme.internal' },
    });
    expect(pickForge('github.acme.internal', s)).toBe('github');
    expect(pickForge('gitlab.acme.internal', s)).toBe('gitlab');
  });

  it("reads api.github.com in the settings as the remote's github.com", () => {
    const s = settings({ github: { enabled: true, baseUrl: 'https://api.github.com' } });
    expect(pickForge('github.com', s)).toBe('github');
  });

  it('knows the two public hosts with nothing configured for them', () => {
    const s = settings({
      github: { enabled: true, baseUrl: 'https://github.acme.internal' },
      gitlab: { enabled: true, baseUrl: 'https://gitlab.acme.internal' },
    });
    expect(pickForge('github.com', s)).toBe('github');
    expect(pickForge('gitlab.com', s)).toBe('gitlab');
  });

  it('falls back to the only provider that is switched on', () => {
    const only = settings({ github: { enabled: true }, gitlab: { enabled: false } });
    expect(pickForge('git.unknown.example', only)).toBe('github');
  });

  it('refuses to guess when both are on and the host is unknown', () => {
    const both = settings({ github: { enabled: true }, gitlab: { enabled: true } });
    expect(pickForge('git.unknown.example', both)).toBeNull();
  });

  it('never picks a provider the human switched off', () => {
    const off = settings({
      github: { enabled: false, baseUrl: 'https://api.github.com' },
      gitlab: { enabled: false },
    });
    expect(pickForge('github.com', off)).toBeNull();
    expect(pickForge('git.unknown.example', off)).toBeNull();
  });

  it('does not let a lookalike host match a real one', () => {
    const s = settings({ github: { enabled: true }, gitlab: { enabled: true } });
    expect(pickForge('github.com.evil.example', s)).toBeNull();
  });
});
