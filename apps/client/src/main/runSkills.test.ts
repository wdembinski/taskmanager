/**
 * Unit tests for F7.6's resolver: ordering and dedupe of `runSkillRefs`, the
 * resolved/dangling split of `resolveRunSkills`, and the wording `skillsTimelineNote`
 * hands to the card's activity timeline.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/model';
import type { Skill } from '@shared/skills';
import type { RepoSkill } from './repoSkills';
import {
  resolveRunSkills,
  runSkillRefs,
  skillsTimelineNote,
  type RunSkillLookups,
} from './runSkills';

const task = (skillRefs: string[] | null): Pick<Task, 'skillRefs'> => ({ skillRefs });

describe('runSkillRefs', () => {
  it('is empty when neither card nor step has any refs', () => {
    expect(runSkillRefs(task(null), task(null))).toEqual([]);
    expect(runSkillRefs(task([]), task([]))).toEqual([]);
  });

  it('takes the card alone', () => {
    expect(runSkillRefs(task(['lib:a']), task(null))).toEqual(['lib:a']);
  });

  it('takes the step alone', () => {
    expect(runSkillRefs(task(null), task(['lib:a']))).toEqual(['lib:a']);
  });

  it('unions card and step, card refs first', () => {
    expect(runSkillRefs(task(['lib:a']), task(['repo:tdd']))).toEqual(['lib:a', 'repo:tdd']);
  });

  it('dedupes a ref repeated within one list', () => {
    expect(runSkillRefs(task(['lib:a', 'lib:a']), task(null))).toEqual(['lib:a']);
  });

  it('dedupes across card and step, the card occurrence winning the order', () => {
    expect(runSkillRefs(task(['lib:a']), task(['lib:a', 'repo:tdd']))).toEqual([
      'lib:a',
      'repo:tdd',
    ]);
  });

  it('dedupes whitespace variants of the same ref', () => {
    expect(runSkillRefs(task([' lib:a']), task(['lib:a ']))).toEqual(['lib:a']);
  });

  it('keeps an unparseable ref, deduped on its trimmed text', () => {
    expect(runSkillRefs(task(['nope']), task([' nope ']))).toEqual(['nope']);
  });
});

describe('resolveRunSkills', () => {
  const librarySkill: Skill = {
    id: 'abc-123',
    name: 'bug-reproduce-first',
    description: 'Reproduce before fixing',
    body: 'Step 1: reproduce.',
    createdAt: 0,
    updatedAt: 0,
  };
  const repoSkill: RepoSkill = {
    name: 'tdd',
    description: 'Write the test first',
    body: 'Red, green, refactor.',
    dir: 'C:/work/.claude/skills/tdd',
    warnings: [],
  };

  function lookups(
    opts: {
      library?: Record<string, Skill>;
      repo?: Record<string, RepoSkill | null>;
    } = {},
  ): RunSkillLookups {
    return {
      library: (id) => opts.library?.[id],
      repo: (name) => opts.repo?.[name],
    };
  }

  it('resolves no refs to an empty resolved and empty dangling', () => {
    expect(resolveRunSkills(task(null), task(null), lookups())).toEqual({
      resolved: [],
      dangling: [],
    });
  });

  it('maps a library hit to source: library with the row body', () => {
    const { resolved, dangling } = resolveRunSkills(
      task(['lib:abc-123']),
      task(null),
      lookups({ library: { 'abc-123': librarySkill } }),
    );
    expect(dangling).toEqual([]);
    expect(resolved).toEqual([
      {
        ref: 'lib:abc-123',
        name: 'bug-reproduce-first',
        description: 'Reproduce before fixing',
        body: 'Step 1: reproduce.',
        source: 'library',
      },
    ]);
  });

  it('maps a repo hit to source: repo with the .claude/skills/<name> dir', () => {
    const { resolved, dangling } = resolveRunSkills(
      task(['repo:tdd']),
      task(null),
      lookups({ repo: { tdd: repoSkill } }),
    );
    expect(dangling).toEqual([]);
    expect(resolved).toEqual([
      {
        ref: 'repo:tdd',
        name: 'tdd',
        description: 'Write the test first',
        body: 'Red, green, refactor.',
        source: 'repo',
        dir: '.claude/skills/tdd',
      },
    ]);
  });

  it('reports a library miss as dangling while the rest still resolves', () => {
    const { resolved, dangling } = resolveRunSkills(
      task(['lib:gone', 'repo:tdd']),
      task(null),
      lookups({ repo: { tdd: repoSkill } }),
    );
    expect(dangling).toEqual([{ ref: 'lib:gone', reason: 'missing' }]);
    expect(resolved.map((s) => s.ref)).toEqual(['repo:tdd']);
  });

  it('reports a repo miss (null or undefined) as dangling while the rest still resolves', () => {
    const { resolved, dangling } = resolveRunSkills(
      task(['repo:gone', 'lib:abc-123']),
      task(null),
      lookups({ library: { 'abc-123': librarySkill }, repo: { gone: null } }),
    );
    expect(dangling).toEqual([{ ref: 'repo:gone', reason: 'missing' }]);
    expect(resolved.map((s) => s.ref)).toEqual(['lib:abc-123']);
  });

  it('reports an unparseable ref as dangling with reason invalid-ref, while the rest still resolves', () => {
    const { resolved, dangling } = resolveRunSkills(
      task(['nope', 'lib:abc-123']),
      task(null),
      lookups({ library: { 'abc-123': librarySkill } }),
    );
    expect(dangling).toEqual([{ ref: 'nope', reason: 'invalid-ref' }]);
    expect(resolved.map((s) => s.ref)).toEqual(['lib:abc-123']);
  });
});

describe('skillsTimelineNote', () => {
  it('is null when there are no refs at all', () => {
    expect(skillsTimelineNote({ resolved: [], dangling: [] })).toBeNull();
  });

  it('names the skills in force and closes with the next-run line', () => {
    const note = skillsTimelineNote({
      resolved: [
        { ref: 'lib:a', name: 'a', description: '', body: 'x', source: 'library' },
        { ref: 'lib:b', name: 'b', description: '', body: 'y', source: 'library' },
      ],
      dangling: [],
    });
    expect(note).toBe(
      "Skills in force for this run: a, b. Changes to this card's skills take effect on its next run.",
    );
  });

  it('names a dangling ref without any resolved skills', () => {
    const note = skillsTimelineNote({
      resolved: [],
      dangling: [{ ref: 'lib:gone', reason: 'missing' }],
    });
    expect(note).toBe(
      "Skill `lib:gone` no longer exists — this run started without it. Changes to this card's skills take effect on its next run.",
    );
  });

  it('adds the over-budget omission line naming exactly what was dropped', () => {
    const big = (name: string) => ({
      ref: `lib:${name}`,
      name,
      description: '',
      body: 'x'.repeat(1000),
      source: 'library' as const,
    });
    const note = skillsTimelineNote(
      { resolved: [big('a'), big('b'), big('c')], dangling: [] },
      { maxChars: 1200 },
    );
    expect(note).toBe(
      "Skills in force for this run: a. Omitted to fit the size budget: b, c. Changes to this card's skills take effect on its next run.",
    );
  });
});
