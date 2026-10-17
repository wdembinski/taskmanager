import { describe, expect, it } from 'vitest';
import {
  applyReviewKey,
  reviewKeyAction,
  REVIEW_KEYS,
  type ReviewKeyEventLike,
} from './reviewKeys';
import { EMPTY_REVIEW, selectFile, type ReviewState } from './reviewState';

const key = (overrides: Partial<ReviewKeyEventLike> = {}): ReviewKeyEventLike => ({
  key: 'n',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

const closedEditor = { editorOpen: false };
const openEditor = { editorOpen: true };

describe('reviewKeyAction', () => {
  it('ignores composing and repeat keystrokes outright', () => {
    expect(reviewKeyAction(key({ isComposing: true }), closedEditor)).toBeNull();
    expect(reviewKeyAction(key({ repeat: true }), closedEditor)).toBeNull();
  });

  it('only Escape does anything while the editor is open, even inside a textarea', () => {
    const inTextarea = key({ key: 'Escape', target: { tagName: 'TEXTAREA' } });
    expect(reviewKeyAction(inTextarea, openEditor)).toBe('escape');

    expect(reviewKeyAction(key({ key: 'n' }), openEditor)).toBeNull();
    expect(reviewKeyAction(key({ key: 'v' }), openEditor)).toBeNull();
  });

  it('ignores every letter while focus is in an editable field, editor closed', () => {
    const target = { tagName: 'INPUT' };
    expect(reviewKeyAction(key({ key: 'n', target }), closedEditor)).toBeNull();
    expect(reviewKeyAction(key({ key: 'v', target }), closedEditor)).toBeNull();
    // Escape itself is also gated by isEditableTarget once the editor is closed — it is the
    // "no editor, close the workspace" case, not a field-cancel key.
    expect(reviewKeyAction(key({ key: 'Escape', target }), closedEditor)).toBeNull();
  });

  it('ignores a letter chord with Ctrl, Meta or Alt held', () => {
    expect(reviewKeyAction(key({ key: 'n', ctrlKey: true }), closedEditor)).toBeNull();
    expect(reviewKeyAction(key({ key: 'n', metaKey: true }), closedEditor)).toBeNull();
    expect(reviewKeyAction(key({ key: 'n', altKey: true }), closedEditor)).toBeNull();
  });

  it('maps every bare letter to its action', () => {
    expect(reviewKeyAction(key({ key: 'n' }), closedEditor)).toBe('nextFile');
    expect(reviewKeyAction(key({ key: 'p' }), closedEditor)).toBe('prevFile');
    expect(reviewKeyAction(key({ key: 'j' }), closedEditor)).toBe('nextHunk');
    expect(reviewKeyAction(key({ key: 'k' }), closedEditor)).toBe('prevHunk');
    expect(reviewKeyAction(key({ key: 'v' }), closedEditor)).toBe('toggleViewed');
    expect(reviewKeyAction(key({ key: 's' }), closedEditor)).toBe('toggleLayout');
    expect(reviewKeyAction(key({ key: 'e' }), closedEditor)).toBe('expandContext');
    expect(reviewKeyAction(key({ key: 'c' }), closedEditor)).toBe('comment');
  });

  it('refuses a letter chorded with Shift, unlike "?"', () => {
    expect(reviewKeyAction(key({ key: 'N', shiftKey: true }), closedEditor)).toBeNull();
    expect(reviewKeyAction(key({ key: '?', shiftKey: true }), closedEditor)).toBe('showKeys');
    expect(reviewKeyAction(key({ key: '?', shiftKey: false }), closedEditor)).toBe('showKeys');
  });

  it('maps Escape to escape when the editor is closed and focus is not editable', () => {
    expect(reviewKeyAction(key({ key: 'Escape' }), closedEditor)).toBe('escape');
  });

  it('is null for an unmapped key', () => {
    expect(reviewKeyAction(key({ key: 'z' }), closedEditor)).toBeNull();
  });
});

describe('applyReviewKey', () => {
  function loaded(): ReviewState {
    return {
      ...EMPTY_REVIEW,
      taskId: 'a',
      summary: {
        status: 'ok',
        summary: {
          diffId: 'd1',
          baseRef: 'main',
          baseSha: 'b',
          headSha: 'h',
          includesWorkingTree: false,
          files: [
            {
              path: 'a.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              binary: false,
              image: false,
              bytes: 1,
            },
            {
              path: 'b.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              binary: false,
              image: false,
              bytes: 1,
            },
          ],
          truncated: false,
        },
      },
      diffId: 'd1',
    };
  }

  it('dispatches nextFile / prevFile', () => {
    const state = loaded();
    expect(applyReviewKey(state, 'nextFile', 0).selectedPath).toBe('a.ts');
    expect(applyReviewKey(state, 'prevFile', 0).selectedPath).toBe('b.ts');
  });

  it('dispatches nextHunk / prevHunk as no-ops with nothing selected', () => {
    const state = loaded();
    expect(applyReviewKey(state, 'nextHunk', 0)).toBe(state);
    expect(applyReviewKey(state, 'prevHunk', 0)).toBe(state);
  });

  it('dispatches toggleViewed through toggleViewedAndAdvance', () => {
    const state = selectFile(loaded(), 'a.ts');
    // No newBlobSha on the fixture entries, so the toggle itself is refused — same object.
    expect(applyReviewKey(state, 'toggleViewed', 0)).toBe(state);
  });

  it('closes the editor on escape, and is a no-op with no editor open', () => {
    const state = loaded();
    expect(applyReviewKey(state, 'escape', 0)).toBe(state);

    const withEditor: ReviewState = {
      ...state,
      editor: {
        path: 'a.ts',
        anchor: { side: 'new', line: 1 },
        draft: '',
        outdated: false,
        saving: false,
      },
    };
    expect(applyReviewKey(withEditor, 'escape', 0).editor).toBeNull();
  });

  it('leaves the state untouched for the four host-only actions', () => {
    const state = loaded();
    for (const action of ['toggleLayout', 'expandContext', 'comment', 'showKeys'] as const) {
      expect(applyReviewKey(state, action, 0)).toBe(state);
    }
  });
});

describe('REVIEW_KEYS', () => {
  it('has one row per discoverable action, and none for escape', () => {
    const ids = REVIEW_KEYS.map((item) => item.id);
    expect(ids).toEqual([
      'nextFile',
      'prevFile',
      'nextHunk',
      'prevHunk',
      'toggleViewed',
      'toggleLayout',
      'expandContext',
      'comment',
      'showKeys',
    ]);
    expect(ids).not.toContain('escape');
  });
});
