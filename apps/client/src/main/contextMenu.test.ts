import { describe, expect, it } from 'vitest';
import { buildContextMenuTemplate, type ContextMenuDecisionParams } from './contextMenu';

function params(overrides: Partial<ContextMenuDecisionParams> = {}): ContextMenuDecisionParams {
  return {
    isEditable: false,
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    },
    ...overrides,
  };
}

describe('buildContextMenuTemplate', () => {
  it('offers cut/copy/paste/select-all roles for an editable field', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }),
    );

    const roles = template?.map((item) => item.role);
    expect(roles).toEqual(['cut', 'copy', 'paste', undefined, 'selectAll']);
  });

  it('disables the editable roles Electron itself reports as unavailable', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
      }),
    );

    const byRole = Object.fromEntries((template ?? []).map((item) => [item.role, item]));
    expect(byRole['cut']?.enabled).toBe(false);
    expect(byRole['copy']?.enabled).toBe(false);
    expect(byRole['paste']?.enabled).toBe(false);
    expect(byRole['selectAll']?.enabled).toBe(true);
  });

  it('offers only copy/select-all for a plain (non-editable) selection', () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: false,
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
    );

    const roles = template?.map((item) => item.role);
    expect(roles).toEqual(['copy', undefined, 'selectAll']);
  });

  it('shows nothing when the click is on neither an editable field nor a selection', () => {
    const template = buildContextMenuTemplate(params());

    expect(template).toBeNull();
  });
});
