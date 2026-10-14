import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_TEMPLATES, type PromptTemplate } from '@tm/shared/promptTemplates';
import {
  addTemplate,
  canSave,
  discard,
  editTemplate,
  isDirty,
  markSaved,
  moveTemplate,
  openEditor,
  removeTemplate,
  resetToDefaults,
  toggleSurface,
  validateTemplates,
  type PromptTemplatesEditor,
} from './promptTemplatesEditor';

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'a',
    name: 'Template A',
    body: 'Body A',
    surfaces: ['add-task', 'assign', 'chat'],
    ...overrides,
  };
}

describe('openEditor', () => {
  it('starts with saved and draft equal, and not dirty', () => {
    const state = openEditor([template()]);
    expect(state.saved).toEqual([template()]);
    expect(state.draft).toEqual([template()]);
    expect(isDirty(state)).toBe(false);
  });

  it('clones deeply, so editing the draft never touches the input array or saved', () => {
    const input = [template({ surfaces: ['chat'] })];
    const state = openEditor(input);

    const edited = toggleSurface(state, 'a', 'assign');

    expect(input[0].surfaces).toEqual(['chat']);
    expect(state.draft[0].surfaces).toEqual(['chat']);
    expect(edited.saved[0].surfaces).toEqual(['chat']);
  });
});

describe('editTemplate', () => {
  it('patches name and body on the matching draft template only', () => {
    const state = openEditor([template({ id: 'a' }), template({ id: 'b', name: 'B' })]);

    const next = editTemplate(state, 'a', { name: 'Renamed', body: 'New body' });

    expect(next.draft[0]).toMatchObject({ name: 'Renamed', body: 'New body' });
    expect(next.draft[1]).toMatchObject({ name: 'B' });
    expect(next.saved[0].name).toBe('Template A');
  });
});

describe('toggleSurface', () => {
  it('removes a surface that is present', () => {
    const state = openEditor([template({ surfaces: ['add-task', 'assign', 'chat'] })]);

    const next = toggleSurface(state, 'a', 'assign');

    expect(next.draft[0].surfaces).toEqual(['add-task', 'chat']);
  });

  it('adds a surface that is absent, in canonical order', () => {
    const state = openEditor([template({ surfaces: ['chat'] })]);

    const next = toggleSurface(state, 'a', 'add-task');

    expect(next.draft[0].surfaces).toEqual(['add-task', 'chat']);
  });
});

describe('addTemplate', () => {
  it('appends a blank template with every surface', () => {
    const state = openEditor([template()]);

    const next = addTemplate(state, 'new-1');

    expect(next.draft).toHaveLength(2);
    expect(next.draft[1]).toEqual({
      id: 'new-1',
      name: '',
      body: '',
      surfaces: ['add-task', 'assign', 'chat'],
    });
  });
});

describe('removeTemplate', () => {
  it('removes the matching draft template', () => {
    const state = openEditor([template({ id: 'a' }), template({ id: 'b' })]);

    const next = removeTemplate(state, 'a');

    expect(next.draft.map((t) => t.id)).toEqual(['b']);
  });
});

describe('moveTemplate', () => {
  function threeState(): PromptTemplatesEditor {
    return openEditor([template({ id: 'a' }), template({ id: 'b' }), template({ id: 'c' })]);
  }

  it('swaps with the previous entry', () => {
    const next = moveTemplate(threeState(), 'b', -1);
    expect(next.draft.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('swaps with the next entry', () => {
    const next = moveTemplate(threeState(), 'b', 1);
    expect(next.draft.map((t) => t.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op moving the first entry earlier', () => {
    const state = threeState();
    const next = moveTemplate(state, 'a', -1);
    expect(next.draft.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op moving the last entry later', () => {
    const state = threeState();
    const next = moveTemplate(state, 'c', 1);
    expect(next.draft.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an id that is not present', () => {
    const state = threeState();
    const next = moveTemplate(state, 'missing', 1);
    expect(next.draft.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('resetToDefaults', () => {
  it('replaces draft with the defaults, leaving saved untouched', () => {
    const state = openEditor([template()]);

    const next = resetToDefaults(state);

    expect(next.draft).toEqual(DEFAULT_PROMPT_TEMPLATES);
    expect(next.saved).toEqual([template()]);
    expect(isDirty(next)).toBe(true);
  });

  it('never mutates DEFAULT_PROMPT_TEMPLATES itself', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_PROMPT_TEMPLATES));
    const state = resetToDefaults(openEditor([template()]));

    state.draft[0].name = 'mutated';
    state.draft[0].surfaces.push('add-task');

    expect(DEFAULT_PROMPT_TEMPLATES).toEqual(before);
  });
});

describe('discard', () => {
  it('restores draft to a fresh copy of saved', () => {
    let state = openEditor([template({ surfaces: ['chat'] })]);
    state = toggleSurface(state, 'a', 'assign');

    const next = discard(state);

    expect(next.draft[0].surfaces).toEqual(['chat']);
  });

  it('reset-then-discard returns to saved, not the defaults', () => {
    const state = openEditor([template({ id: 'only', name: 'Mine' })]);

    const afterReset = resetToDefaults(state);
    const afterDiscard = discard(afterReset);

    expect(afterDiscard.draft).toEqual([template({ id: 'only', name: 'Mine' })]);
  });
});

describe('markSaved', () => {
  it('commits draft as the new saved', () => {
    let state = openEditor([template({ surfaces: ['chat'] })]);
    state = toggleSurface(state, 'a', 'assign');

    const next = markSaved(state);

    expect(next.saved[0].surfaces).toEqual(['assign', 'chat']);
    expect(isDirty(next)).toBe(false);
  });

  it('keeps saved and draft independent after the commit', () => {
    let state = markSaved(openEditor([template({ surfaces: ['chat'] })]));

    state = toggleSurface(state, 'a', 'assign');

    expect(state.saved[0].surfaces).toEqual(['chat']);
  });
});

describe('isDirty', () => {
  it('is false right after opening', () => {
    expect(isDirty(openEditor([template()]))).toBe(false);
  });

  it('is true after an edit', () => {
    const state = openEditor([template()]);
    expect(isDirty(editTemplate(state, 'a', { name: 'Changed' }))).toBe(true);
  });

  it('is false after an edit is reverted back to the original value', () => {
    const state = openEditor([template()]);
    const edited = editTemplate(state, 'a', { name: 'Changed' });
    const reverted = editTemplate(edited, 'a', { name: 'Template A' });

    expect(isDirty(reverted)).toBe(false);
  });

  it('is true when only the order differs', () => {
    const state = openEditor([template({ id: 'a' }), template({ id: 'b' })]);
    const reordered = moveTemplate(state, 'a', 1);

    expect(isDirty(reordered)).toBe(true);
  });
});

describe('validateTemplates', () => {
  it('flags a blank name', () => {
    const errors = validateTemplates([template({ name: '  ' })]);
    expect(errors.a).toContain('Name is required.');
  });

  it('flags a blank body', () => {
    const errors = validateTemplates([template({ body: '' })]);
    expect(errors.a).toContain('Body is required.');
  });

  it('flags no surfaces', () => {
    const errors = validateTemplates([template({ surfaces: [] })]);
    expect(errors.a).toContain('At least one surface is required.');
  });

  it('flags a duplicate name, case-insensitively, on both templates', () => {
    const errors = validateTemplates([
      template({ id: 'a', name: 'Foo' }),
      template({ id: 'b', name: 'foo' }),
    ]);

    expect(errors.a).toContain('Name is already used by another template.');
    expect(errors.b).toContain('Name is already used by another template.');
  });

  it('does not flag duplicates among blank names', () => {
    const errors = validateTemplates([
      template({ id: 'a', name: '' }),
      template({ id: 'b', name: '' }),
    ]);

    expect(errors.a).not.toContain('Name is already used by another template.');
    expect(errors.b).not.toContain('Name is already used by another template.');
  });

  it('has no entry for a fully valid template', () => {
    const errors = validateTemplates([template()]);
    expect(errors.a).toBeUndefined();
  });
});

describe('canSave', () => {
  it('is false when nothing changed', () => {
    expect(canSave(openEditor([template()]))).toBe(false);
  });

  it('is true when dirty and valid', () => {
    const state = openEditor([template()]);
    expect(canSave(editTemplate(state, 'a', { name: 'Changed' }))).toBe(true);
  });

  it('is false when dirty but invalid', () => {
    const state = openEditor([template()]);
    expect(canSave(editTemplate(state, 'a', { name: '' }))).toBe(false);
  });
});
