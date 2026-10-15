/**
 * `skillPickerState.ts`'s pure state: option building/sorting, filtering, row derivation (own vs
 * inherited vs missing), the toggle, and the agent panel's label line. The one acceptance
 * case F7.9's step-1 design decisions call out by name: an inherited card skill on a step
 * renders checked and non-removable, and toggling it is a no-op.
 */
import { describe, expect, it } from 'vitest';
import type { RepoSkillSummary, Skill } from '@tm/shared/skills';
import {
  filterSkillOptions,
  pickerRows,
  skillOptions,
  skillsLineLabels,
  toggleSkillRef,
  type SkillOption,
} from './skillPickerState';

const librarySkill = (over: Partial<Skill>): Skill => ({
  id: 'id-1',
  name: 'tdd',
  description: 'Write the failing test first',
  body: 'Body.',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const repoSkill = (over: Partial<RepoSkillSummary>): RepoSkillSummary => ({
  projectId: 'p1',
  name: 'repro-first',
  description: 'Reproduce the bug before touching code',
  path: '.claude/skills/repro-first/SKILL.md',
  ...over,
});

describe('skillOptions', () => {
  it('lists library skills before repo skills, each group sorted by name', () => {
    const library = [
      librarySkill({ id: 'id-b', name: 'write-tests' }),
      librarySkill({ id: 'id-a', name: 'bug-first' }),
    ];
    const repo = [repoSkill({ name: 'zeta' }), repoSkill({ name: 'alpha' })];

    const options = skillOptions(library, repo);

    expect(options.map((o) => [o.source, o.name])).toEqual([
      ['library', 'bug-first'],
      ['library', 'write-tests'],
      ['repo', 'alpha'],
      ['repo', 'zeta'],
    ]);
  });

  it('formats refs with the lib:/repo: prefixes', () => {
    const options = skillOptions([librarySkill({ id: 'abc-123' })], [repoSkill({})]);
    expect(options[0].ref).toBe('lib:abc-123');
    expect(options[1].ref).toBe('repo:repro-first');
  });

  it('is empty when both lists are empty', () => {
    expect(skillOptions([], [])).toEqual([]);
  });
});

describe('filterSkillOptions', () => {
  const options: SkillOption[] = [
    { ref: 'lib:a', name: 'tdd', description: 'Write the failing test first', source: 'library' },
    { ref: 'repo:b', name: 'repro-first', description: 'Reproduce the bug', source: 'repo' },
  ];

  it('matches on name, case-insensitively', () => {
    expect(filterSkillOptions(options, 'TDD')).toEqual([options[0]]);
  });

  it('matches on description, case-insensitively', () => {
    expect(filterSkillOptions(options, 'reproduce')).toEqual([options[1]]);
  });

  it('returns everything for an empty or whitespace-only query', () => {
    expect(filterSkillOptions(options, '')).toEqual(options);
    expect(filterSkillOptions(options, '   ')).toEqual(options);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSkillOptions(options, 'nope')).toEqual([]);
  });
});

describe('pickerRows', () => {
  const tdd: SkillOption = {
    ref: 'lib:tdd',
    name: 'tdd',
    description: 'Write the failing test first',
    source: 'library',
  };
  const repro: SkillOption = {
    ref: 'repo:repro-first',
    name: 'repro-first',
    description: 'Reproduce the bug',
    source: 'repo',
  };
  const options = [tdd, repro];

  it('rows an unselected option as available, not removable', () => {
    const rows = pickerRows(options, { own: [], inherited: [] }, '');
    expect(rows).toEqual([
      { ref: 'lib:tdd', label: 'tdd', caption: 'library', state: 'available', removable: false },
      {
        ref: 'repo:repro-first',
        label: 'repro-first',
        caption: 'repo',
        state: 'available',
        removable: false,
      },
    ]);
  });

  it('rows an own ref as selected and removable', () => {
    const rows = pickerRows(options, { own: ['lib:tdd'], inherited: [] }, '');
    expect(rows[0]).toEqual({
      ref: 'lib:tdd',
      label: 'tdd',
      caption: 'library',
      state: 'selected',
      removable: true,
    });
  });

  it('rows an inherited ref as checked and not removable, captioned "from card"', () => {
    const rows = pickerRows(options, { own: [], inherited: ['lib:tdd'] }, '');
    expect(rows[0]).toEqual({
      ref: 'lib:tdd',
      label: 'tdd',
      caption: 'from card',
      state: 'inherited',
      removable: false,
    });
  });

  it('inherited wins over own on a duplicate ref', () => {
    const rows = pickerRows(options, { own: ['lib:tdd'], inherited: ['lib:tdd'] }, '');
    expect(rows[0]).toEqual({
      ref: 'lib:tdd',
      label: 'tdd',
      caption: 'from card',
      state: 'inherited',
      removable: false,
    });
  });

  it('dedupes formatting variants of the same ref across own and inherited', () => {
    const rows = pickerRows(options, { own: [' lib:tdd '], inherited: ['lib:tdd'] }, '');
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('inherited');
  });

  it('filters matched rows by query, case-insensitively on name and description', () => {
    const rows = pickerRows(options, { own: [], inherited: [] }, 'reproduce');
    expect(rows).toEqual([
      {
        ref: 'repo:repro-first',
        label: 'repro-first',
        caption: 'repo',
        state: 'available',
        removable: false,
      },
    ]);
  });

  it('adds a missing row, labelled by the raw ref, for an own ref with no matching option', () => {
    const rows = pickerRows(options, { own: ['lib:gone'], inherited: [] }, '');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({
      ref: 'lib:gone',
      label: 'lib:gone',
      caption: 'missing',
      state: 'missing',
      removable: true,
    });
  });

  it('adds a non-removable missing row for an inherited ref with no matching option', () => {
    const rows = pickerRows(options, { own: [], inherited: ['lib:gone'] }, '');
    expect(rows[2]).toEqual({
      ref: 'lib:gone',
      label: 'lib:gone',
      caption: 'missing',
      state: 'missing',
      removable: false,
    });
  });

  it('shows missing rows regardless of a query that would not otherwise match them', () => {
    const rows = pickerRows(options, { own: ['lib:gone'], inherited: [] }, 'tdd');
    expect(rows.some((row) => row.ref === 'lib:gone' && row.state === 'missing')).toBe(true);
  });

  it('collapses a ref missing from both own and inherited to a single row', () => {
    const rows = pickerRows(options, { own: ['lib:gone'], inherited: ['lib:gone'] }, '');
    expect(rows).toHaveLength(3);
    expect(rows[2].removable).toBe(false);
  });
});

describe('toggleSkillRef', () => {
  it('adds a ref not yet in own, appending it', () => {
    expect(toggleSkillRef(['lib:a'], [], 'lib:b')).toEqual(['lib:a', 'lib:b']);
  });

  it('removes a ref already in own', () => {
    expect(toggleSkillRef(['lib:a', 'lib:b'], [], 'lib:a')).toEqual(['lib:b']);
  });

  it('canonicalises and dedupes own before toggling', () => {
    expect(toggleSkillRef([' lib:a ', 'lib:a'], [], 'lib:b')).toEqual(['lib:a', 'lib:b']);
  });

  it('matches a formatting variant of the toggled ref against an existing own entry', () => {
    expect(toggleSkillRef(['lib:a'], [], ' lib:a ')).toEqual([]);
  });

  it('leaves own completely unchanged when the ref is inherited', () => {
    const own = ['lib:a'];
    expect(toggleSkillRef(own, ['lib:b'], 'lib:b')).toBe(own);
  });

  it('is a no-op for an inherited ref even when own has an unrelated entry', () => {
    expect(toggleSkillRef(['lib:a'], ['lib:b'], 'lib:b')).toEqual(['lib:a']);
  });
});

describe('skillsLineLabels', () => {
  const options: SkillOption[] = [
    { ref: 'lib:a', name: 'tdd', description: '', source: 'library' },
    { ref: 'repo:b', name: 'repro-first', description: '', source: 'repo' },
  ];

  it('returns names in ref order', () => {
    expect(skillsLineLabels(['lib:a', 'repo:b'], options)).toEqual(['tdd', 'repro-first']);
  });

  it('falls back to the raw canonical ref for a dangling ref with no matching option', () => {
    expect(skillsLineLabels(['lib:gone'], options)).toEqual(['lib:gone']);
  });

  it('returns an empty array when there are no effective refs', () => {
    expect(skillsLineLabels([], options)).toEqual([]);
  });
});
