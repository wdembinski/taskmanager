import { describe, expect, it } from 'vitest';
import {
  SKILL_BODY_MAX,
  type RepoSkillDetail,
  type Skill,
  type SkillImportResult,
} from '@tm/shared/skills';
import {
  applyDelete,
  applyImportResults,
  applySaveResult,
  canSave,
  cancelPendingSelection,
  confirmPendingSelection,
  copyRepoToLibrary,
  discardDraft,
  dismissClash,
  editDraft,
  isDirty,
  nextImportReplace,
  openSkillsEditor,
  replaceDraft,
  selectLibrary,
  selectRepo,
  skipImportClash,
  startNew,
  validateDraft,
  type SkillsEditorState,
} from './skillsEditorState';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'a',
    name: 'tdd',
    description: 'Test-driven development',
    body: 'Write the test first.',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('selectLibrary', () => {
  it('opens a draft matching the selected skill, clean', () => {
    const state = openSkillsEditor([skill()]);

    const next = selectLibrary(state, 'a');

    expect(next.selection).toEqual({ kind: 'library', id: 'a' });
    expect(next.draft).toEqual({
      id: 'a',
      name: 'tdd',
      description: 'Test-driven development',
      body: 'Write the test first.',
    });
    expect(isDirty(next)).toBe(false);
  });
});

describe('edit', () => {
  it('is dirty after a change', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');

    const next = editDraft(state, { description: 'Changed' });

    expect(isDirty(next)).toBe(true);
  });

  it('is clean again after editing back to the baseline', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');

    const edited = editDraft(state, { description: 'Changed' });
    const reverted = editDraft(edited, { description: 'Test-driven development' });

    expect(isDirty(reverted)).toBe(false);
  });
});

describe('save', () => {
  it('upserts into the library, cleans the draft, and selects the saved id', () => {
    const state = startNew(openSkillsEditor([]));
    const edited = editDraft(state, { name: 'new-skill', description: 'New', body: 'Body' });

    const saved = skill({ id: 'minted', name: 'new-skill', description: 'New', body: 'Body' });
    const next = applySaveResult(edited, { ok: true, skill: saved });

    expect(next.library).toEqual([saved]);
    expect(next.selection).toEqual({ kind: 'library', id: 'minted' });
    expect(isDirty(next)).toBe(false);
    expect(next.draft).toEqual({
      id: 'minted',
      name: 'new-skill',
      description: 'New',
      body: 'Body',
    });
  });

  it('turns any other refusal into a notice', () => {
    const state = startNew(openSkillsEditor([]));

    const next = applySaveResult(state, {
      ok: false,
      reason: 'too-large',
      message: 'too large to sync',
    });

    expect(next.notices).toEqual(['too large to sync']);
    expect(next.clash).toBeNull();
  });
});

describe('discard', () => {
  it('restores the baseline', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');
    const edited = editDraft(state, { description: 'Changed' });

    const next = discardDraft(edited);

    expect(next.draft).toEqual(state.draft);
    expect(isDirty(next)).toBe(false);
  });
});

describe('switch while dirty', () => {
  function dirtyState(): SkillsEditorState {
    const state = openSkillsEditor([skill({ id: 'a' }), skill({ id: 'b', name: 'other' })]);
    const selected = selectLibrary(state, 'a');
    return editDraft(selected, { description: 'Changed' });
  }

  it('sets pendingSelection instead of switching immediately', () => {
    const next = selectLibrary(dirtyState(), 'b');

    expect(next.pendingSelection).toEqual({ target: { kind: 'library', id: 'b' } });
    expect(next.selection).toEqual({ kind: 'library', id: 'a' });
  });

  it('confirm applies the pending switch', () => {
    const switched = selectLibrary(dirtyState(), 'b');

    const next = confirmPendingSelection(switched);

    expect(next.selection).toEqual({ kind: 'library', id: 'b' });
    expect(next.pendingSelection).toBeNull();
    expect(isDirty(next)).toBe(false);
  });

  it('cancel keeps the current selection and draft', () => {
    const switched = selectLibrary(dirtyState(), 'b');
    const original = dirtyState();

    const next = cancelPendingSelection(switched);

    expect(next.pendingSelection).toBeNull();
    expect(next.selection).toEqual(original.selection);
    expect(next.draft).toEqual(original.draft);
  });

  it('does not ask when the draft is clean', () => {
    const state = selectLibrary(
      openSkillsEditor([skill({ id: 'a' }), skill({ id: 'b', name: 'other' })]),
      'a',
    );

    const next = selectLibrary(state, 'b');

    expect(next.pendingSelection).toBeNull();
    expect(next.selection).toEqual({ kind: 'library', id: 'b' });
  });
});

describe('validateDraft', () => {
  it('flags an invalid slug', () => {
    const errors = validateDraft({ name: 'Not Valid', description: '', body: 'Body' }, []);
    expect(errors.name).toBe(
      'Skill names must be lower-case letters, numbers and hyphens, 1 to 64 characters.',
    );
  });

  it('flags a duplicate name on an existing-skill edit', () => {
    const library = [skill({ id: 'a', name: 'tdd' }), skill({ id: 'b', name: 'other' })];

    const errors = validateDraft({ id: 'b', name: 'tdd', description: '', body: 'Body' }, library);

    expect(errors.name).toBe('A skill named "tdd" already exists.');
  });

  it('does not flag a brand-new draft sharing a name with an existing skill', () => {
    const library = [skill({ id: 'a', name: 'tdd' })];

    const errors = validateDraft({ name: 'tdd', description: '', body: 'Body' }, library);

    expect(errors.name).toBeUndefined();
  });

  it('flags an empty body', () => {
    const errors = validateDraft({ name: 'tdd', description: '', body: '   ' }, []);
    expect(errors.body).toBe('Body is required.');
  });

  it('flags a body too large in multi-byte characters', () => {
    const body = '模'.repeat(Math.floor(SKILL_BODY_MAX / 2) + 10);
    const errors = validateDraft({ name: 'tdd', description: '', body }, []);
    expect(errors.body).toMatch(/too large to sync/);
  });

  it('has no entries for a fully valid draft', () => {
    const errors = validateDraft({ name: 'tdd', description: '', body: 'Body' }, []);
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

describe('canSave', () => {
  it('is false when nothing changed', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');
    expect(canSave(state)).toBe(false);
  });

  it('is true when dirty and valid', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');
    expect(canSave(editDraft(state, { description: 'Changed' }))).toBe(true);
  });

  it('is false when dirty but invalid', () => {
    const state = selectLibrary(openSkillsEditor([skill()]), 'a');
    expect(canSave(editDraft(state, { name: 'Not Valid' }))).toBe(false);
  });
});

describe('clash', () => {
  it('a name-taken result sets clash', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const state = startNew(openSkillsEditor([skill({ id: 'a' }), existing]));
    const edited = editDraft(state, { name: 'other', description: 'Mine', body: 'Body' });

    const next = applySaveResult(edited, {
      ok: false,
      reason: 'name-taken',
      message: 'A skill named "other" already exists.',
    });

    expect(next.clash).toEqual({
      draft: { name: 'other', description: 'Mine', body: 'Body' },
      existing,
      message: 'A skill named "other" already exists.',
    });
  });
});

describe('replace', () => {
  it('carries the existing id', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const state = startNew(openSkillsEditor([skill({ id: 'a' }), existing]));
    const edited = editDraft(state, { name: 'other', description: 'Mine', body: 'Body' });
    const clashed = applySaveResult(edited, {
      ok: false,
      reason: 'name-taken',
      message: 'A skill named "other" already exists.',
    });

    const draft = replaceDraft(clashed);

    expect(draft).toEqual({ id: 'b', name: 'other', description: 'Mine', body: 'Body' });
  });

  it('a save after it clears the clash', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const state = startNew(openSkillsEditor([skill({ id: 'a' }), existing]));
    const edited = editDraft(state, { name: 'other', description: 'Mine', body: 'Body' });
    const clashed = applySaveResult(edited, {
      ok: false,
      reason: 'name-taken',
      message: 'A skill named "other" already exists.',
    });

    const replaced = skill({ id: 'b', name: 'other', description: 'Mine', body: 'Body' });
    const next = applySaveResult(clashed, { ok: true, skill: replaced });

    expect(next.clash).toBeNull();
    expect(next.library.find((s) => s.id === 'b')).toEqual(replaced);
  });
});

describe('dismissClash', () => {
  it('drops the clash without touching the library', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const state = startNew(openSkillsEditor([existing]));
    const edited = editDraft(state, { name: 'other', description: 'Mine', body: 'Body' });
    const clashed = applySaveResult(edited, {
      ok: false,
      reason: 'name-taken',
      message: 'A skill named "other" already exists.',
    });

    const next = dismissClash(clashed);

    expect(next.clash).toBeNull();
    expect(next.library).toEqual([existing]);
  });
});

describe('import batch', () => {
  function repoCandidate(name: string): Pick<Skill, 'name' | 'description' | 'body'> {
    return { name, description: 'desc', body: 'body' };
  }

  it('upserts imported skills, queues clashes, and notices refusals', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const imported = skill({ id: 'new', name: 'fresh' });
    const results: SkillImportResult[] = [
      { status: 'imported', skill: imported, warnings: [], source: 'files' },
      {
        status: 'clash',
        candidate: repoCandidate('other'),
        existing,
        source: 'files',
        message: 'A skill named "other" already exists.',
      },
      {
        status: 'refused',
        source: 'files',
        reason: 'too-large',
        message: '"huge" is too large.',
      },
    ];

    const next = applyImportResults(openSkillsEditor([existing]), results);

    expect(next.library).toEqual([existing, imported]);
    expect(next.importQueue).toHaveLength(1);
    expect(next.notices).toEqual(['Imported "fresh".', '"huge" is too large.']);
  });

  it('surfaces parse warnings on an imported skill as additional notices', () => {
    const imported = skill({ id: 'new', name: 'fresh' });
    const results: SkillImportResult[] = [
      {
        status: 'imported',
        skill: imported,
        warnings: ['frontmatter has no description'],
        source: 'text',
      },
    ];

    const next = applyImportResults(openSkillsEditor([]), results);

    expect(next.notices).toEqual(['Imported "fresh".', '"fresh": frontmatter has no description']);
  });

  it('nextImportReplace opens the head clash as an editable draft against the existing id', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const results: SkillImportResult[] = [
      {
        status: 'clash',
        candidate: repoCandidate('other'),
        existing,
        source: 'files',
        message: 'clash',
      },
    ];
    const queued = applyImportResults(openSkillsEditor([existing]), results);

    const next = nextImportReplace(queued);

    expect(next.importQueue).toHaveLength(0);
    expect(next.selection).toEqual({ kind: 'library', id: 'b' });
    expect(next.draft).toEqual({ id: 'b', name: 'other', description: 'desc', body: 'body' });
    expect(isDirty(next)).toBe(true);
  });

  it('skipImportClash drops the head clash and notices it, leaving the library untouched', () => {
    const existing = skill({ id: 'b', name: 'other' });
    const results: SkillImportResult[] = [
      {
        status: 'clash',
        candidate: repoCandidate('other'),
        existing,
        source: 'files',
        message: 'clash',
      },
    ];
    const queued = applyImportResults(openSkillsEditor([existing]), results);

    const next = skipImportClash(queued);

    expect(next.importQueue).toHaveLength(0);
    expect(next.library).toEqual([existing]);
    expect(next.notices).toEqual(['Skipped "other": already exists.']);
  });
});

describe('copy to library', () => {
  it('opens a new, pre-filled, clean draft', () => {
    const repoSkill: RepoSkillDetail = {
      name: 'repo-skill',
      description: 'From the repo',
      body: 'Repo body',
      path: '.claude/skills/repo-skill/SKILL.md',
      warnings: [],
    };

    const next = copyRepoToLibrary(openSkillsEditor([]), repoSkill);

    expect(next.selection).toEqual({ kind: 'new' });
    expect(next.draft).toEqual({
      name: 'repo-skill',
      description: 'From the repo',
      body: 'Repo body',
    });
    expect(isDirty(next)).toBe(false);
  });
});

describe('selectRepo', () => {
  it('selects a read-only repo skill with no editable draft', () => {
    const next = selectRepo(openSkillsEditor([]), 'proj-1', 'repo-skill');

    expect(next.selection).toEqual({ kind: 'repo', projectId: 'proj-1', name: 'repo-skill' });
    expect(next.draft).toBeNull();
    expect(isDirty(next)).toBe(false);
  });
});

describe('applyDelete', () => {
  it('clears the selection when the deleted skill was selected', () => {
    const state = selectLibrary(openSkillsEditor([skill({ id: 'a' })]), 'a');

    const next = applyDelete(state, 'a');

    expect(next.library).toEqual([]);
    expect(next.selection).toBeNull();
    expect(next.draft).toBeNull();
  });

  it('leaves the selection alone when a different skill was deleted', () => {
    const state = selectLibrary(
      openSkillsEditor([skill({ id: 'a' }), skill({ id: 'b', name: 'other' })]),
      'a',
    );

    const next = applyDelete(state, 'b');

    expect(next.library.map((s) => s.id)).toEqual(['a']);
    expect(next.selection).toEqual({ kind: 'library', id: 'a' });
  });
});
