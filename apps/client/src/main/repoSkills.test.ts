/**
 * Integration tests for repo skill discovery, run against REAL temporary directories
 * (no Electron ABI, so these run fine under vitest).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostJoin, localHost } from './exec';
import { listRepoSkills, readRepoSkill } from './repoSkills';

let root = '';

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
});

function makeSkillDir(name: string): string {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('listRepoSkills', () => {
  it('finds skills, sorted by name', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    writeFileSync(
      join(makeSkillDir('b-skill'), 'SKILL.md'),
      '---\nname: b-skill\ndescription: The b skill\n---\n\nBody b.\n',
    );
    writeFileSync(
      join(makeSkillDir('a-skill'), 'SKILL.md'),
      '---\nname: a-skill\ndescription: The a skill\n---\n\nBody a.\n',
    );

    const skills = await listRepoSkills('proj-1', root, localHost());

    expect(skills).toEqual([
      {
        projectId: 'proj-1',
        name: 'a-skill',
        description: 'The a skill',
        path: '.claude/skills/a-skill/SKILL.md',
      },
      {
        projectId: 'proj-1',
        name: 'b-skill',
        description: 'The b skill',
        path: '.claude/skills/b-skill/SKILL.md',
      },
    ]);
  });

  it('ignores non-skill entries', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    // A loose file sitting next to the skill directories.
    writeFileSync(join(root, '.claude', 'skills', 'README.md'), '# not a skill');
    // A folder with no SKILL.md.
    mkdirSync(join(root, '.claude', 'skills', 'no-skill-md'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'no-skill-md', 'notes.md'), 'notes');
    // A folder whose SKILL.md is itself a directory.
    mkdirSync(join(root, '.claude', 'skills', 'dir-skill-md', 'SKILL.md'), { recursive: true });
    // A folder with an invalid name.
    mkdirSync(join(root, '.claude', 'skills', 'Bad_Name'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'skills', 'Bad_Name', 'SKILL.md'),
      '---\nname: bad-name\ndescription: Bad\n---\n\nBody.\n',
    );

    const skills = await listRepoSkills('proj-1', root, localHost());

    expect(skills).toEqual([]);
  });

  it('returns an empty list when the skills directory is missing', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));

    expect(await listRepoSkills('proj-1', root, localHost())).toEqual([]);
    expect(await listRepoSkills('proj-1', join(root, 'does-not-exist'), localHost())).toEqual([]);
    expect(await listRepoSkills('proj-1', '', localHost())).toEqual([]);
  });
});

describe('readRepoSkill', () => {
  it('returns the body and a host-shaped dir', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    writeFileSync(
      join(makeSkillDir('my-skill'), 'SKILL.md'),
      '---\nname: my-skill\ndescription: My skill\n---\n\nThe body.\n',
    );

    const skill = await readRepoSkill(root, 'my-skill', localHost());

    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('my-skill');
    expect(skill?.description).toBe('My skill');
    expect(skill?.body).toBe('The body.');
    expect(skill?.dir).toBe(hostJoin(root, '.claude', 'skills', 'my-skill'));
    expect(skill?.warnings).toEqual([]);
  });

  it('falls back to the folder name when frontmatter has no name, with a warning', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    writeFileSync(
      join(makeSkillDir('no-name'), 'SKILL.md'),
      '---\ndescription: No name here\n---\n\nBody.\n',
    );

    const skill = await readRepoSkill(root, 'no-name', localHost());

    expect(skill?.name).toBe('no-name');
    expect(skill?.warnings.length).toBeGreaterThan(0);
  });

  it('prefers the folder name when frontmatter disagrees, with a warning', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    writeFileSync(
      join(makeSkillDir('folder-name'), 'SKILL.md'),
      '---\nname: other-name\ndescription: Mismatched\n---\n\nBody.\n',
    );

    const skill = await readRepoSkill(root, 'folder-name', localHost());

    expect(skill?.name).toBe('folder-name');
    expect(skill?.warnings.some((w) => w.includes('other-name') && w.includes('folder-name'))).toBe(
      true,
    );
  });

  it('returns null for an absent skill and a path escape attempt', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));

    expect(await readRepoSkill(root, 'does-not-exist', localHost())).toBeNull();
    expect(await readRepoSkill(root, '../x', localHost())).toBeNull();
  });

  it('parses a CRLF SKILL.md with the correct description', async () => {
    root = mkdtempSync(join(tmpdir(), 'orch-repo-skills-'));
    writeFileSync(
      join(makeSkillDir('crlf-skill'), 'SKILL.md'),
      '---\r\nname: crlf-skill\r\ndescription: CRLF description\r\n---\r\n\r\nBody.\r\n',
    );

    const skill = await readRepoSkill(root, 'crlf-skill', localHost());

    expect(skill?.description).toBe('CRLF description');
  });
});
