import { describe, expect, it, vi } from 'vitest';
import { LOCAL_TARGET } from '@shared/execTarget';
import { PERSONAL_PROJECT_ID, type Project } from '@shared/model';
import type { RepoSkillSummary } from '@shared/skills';
import type { ExecHost } from './exec';
import { refreshAllRepoSkills, refreshRepoSkillsForProject } from './repoSkillsRefresher';

const fakeHost = {} as ExecHost;

function project(overrides: Partial<Pick<Project, 'id' | 'path' | 'target'>> = {}) {
  return { id: 'proj-1', path: '/repo', target: LOCAL_TARGET, ...overrides };
}

describe('refreshRepoSkillsForProject', () => {
  it('scans with the project id/path/host and writes the result', async () => {
    const skills: RepoSkillSummary[] = [
      {
        projectId: 'proj-1',
        name: 'tdd',
        description: 'Write the failing test first',
        path: '.claude/skills/tdd/SKILL.md',
      },
    ];
    const listRepoSkills = vi.fn().mockResolvedValue(skills);
    const hostFor = vi.fn().mockReturnValue(fakeHost);
    const setProjectRepoSkills = vi.fn();

    await refreshRepoSkillsForProject({ setProjectRepoSkills, listRepoSkills, hostFor }, project());

    expect(hostFor).toHaveBeenCalledWith(LOCAL_TARGET);
    expect(listRepoSkills).toHaveBeenCalledWith('proj-1', '/repo', fakeHost);
    expect(setProjectRepoSkills).toHaveBeenCalledWith('proj-1', skills);
  });

  it('never throws, and never writes, when the scan fails', async () => {
    const listRepoSkills = vi.fn().mockRejectedValue(new Error('disk is gone'));
    const setProjectRepoSkills = vi.fn();

    await expect(
      refreshRepoSkillsForProject(
        { setProjectRepoSkills, listRepoSkills, hostFor: () => fakeHost },
        project(),
      ),
    ).resolves.toBeUndefined();

    expect(setProjectRepoSkills).not.toHaveBeenCalled();
  });
});

describe('refreshAllRepoSkills', () => {
  it('skips the Personal board and any pathless project', async () => {
    const listRepoSkills = vi.fn().mockResolvedValue([]);
    const setProjectRepoSkills = vi.fn();

    await refreshAllRepoSkills({ setProjectRepoSkills, listRepoSkills, hostFor: () => fakeHost }, [
      project({ id: PERSONAL_PROJECT_ID }),
      project({ id: 'pathless', path: '' }),
      project({ id: 'repo-project' }),
    ]);

    expect(listRepoSkills).toHaveBeenCalledTimes(1);
    expect(listRepoSkills).toHaveBeenCalledWith('repo-project', '/repo', fakeHost);
  });

  it('keeps refreshing the rest of the sweep when one project fails', async () => {
    const listRepoSkills = vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'failing' ? Promise.reject(new Error('nope')) : Promise.resolve([]),
      );
    const setProjectRepoSkills = vi.fn();

    await refreshAllRepoSkills({ setProjectRepoSkills, listRepoSkills, hostFor: () => fakeHost }, [
      project({ id: 'failing' }),
      project({ id: 'ok' }),
    ]);

    expect(setProjectRepoSkills).toHaveBeenCalledWith('ok', []);
    expect(setProjectRepoSkills).not.toHaveBeenCalledWith('failing', expect.anything());
  });
});
