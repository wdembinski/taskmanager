import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from '@tm/shared/attention';
import {
  ANSWERED_ELSEWHERE,
  EMPTY_INBOX_STATE,
  answerFailed,
  answerStarted,
  answerSucceeded,
  arrived,
  closed,
  noticeCleared,
  opened,
  resolved,
  seeded,
  type InboxState,
} from './inboxState';

const NOW = 1_700_000_000_000;

let nextId = 0;
function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  nextId += 1;
  return {
    id: overrides.id ?? `item-${nextId}`,
    runId: 'run-1',
    taskId: 'task-1',
    projectId: 'project-1',
    taskTitle: 'A task',
    kind: 'question' as AttentionKind,
    prompt: 'prompt',
    options: [],
    toolName: null,
    reason: null,
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

function seededWith(...items: AttentionItem[]): InboxState {
  return seeded(EMPTY_INBOX_STATE, items);
}

describe('seeded', () => {
  it('sets the items list', () => {
    const a = item({ id: 'a' });
    const state = seededWith(a);
    expect(state.items).toEqual([a]);
  });

  it('closes the open view with a notice when a re-seed drops the open item', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let state = seededWith(a, b);
    state = opened(state, 'a');

    state = seeded(state, [b]);

    expect(state.openId).toBeNull();
    expect(state.notice).toBe(ANSWERED_ELSEWHERE);
  });

  it('leaves the open view alone when the open item survives the re-seed', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let state = seededWith(a, b);
    state = opened(state, 'a');

    state = seeded(state, [a, b]);

    expect(state.openId).toBe('a');
    expect(state.notice).toBeNull();
  });

  it('does not notice-close the item we are ourselves answering', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');
    state = answerStarted(state, 'a');

    state = seeded(state, []);

    expect(state.openId).toBe('a');
    expect(state.notice).toBeNull();
  });
});

describe('arrived', () => {
  it('appends a new item', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let state = seededWith(a);

    state = arrived(state, b);

    expect(state.items).toEqual([a, b]);
  });

  it('ignores a duplicate id', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);

    const after = arrived(state, item({ id: 'a' }));

    expect(after).toBe(state);
  });
});

describe('resolved', () => {
  it('removes the item', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let state = seededWith(a, b);

    state = resolved(state, 'a');

    expect(state.items).toEqual([b]);
  });

  it('closes the open view with a notice when the open item resolves elsewhere', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');

    state = resolved(state, 'a');

    expect(state.openId).toBeNull();
    expect(state.notice).toBe(ANSWERED_ELSEWHERE);
  });

  it('closes quietly, with no notice, when our own answer resolves the open item first', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');
    state = answerStarted(state, 'a');

    state = resolved(state, 'a');

    expect(state.openId).toBeNull();
    expect(state.answeringId).toBeNull();
    expect(state.notice).toBeNull();
  });

  it('leaves the open view untouched when a different item resolves', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let state = seededWith(a, b);
    state = opened(state, 'a');

    state = resolved(state, 'b');

    expect(state.openId).toBe('a');
    expect(state.notice).toBeNull();
    expect(state.items).toEqual([a]);
  });
});

describe('opened', () => {
  it('sets openId and clears a stale notice', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = { ...state, notice: ANSWERED_ELSEWHERE };

    state = opened(state, 'a');

    expect(state.openId).toBe('a');
    expect(state.notice).toBeNull();
  });
});

describe('closed', () => {
  it('clears openId', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');

    state = closed(state);

    expect(state.openId).toBeNull();
  });
});

describe('answerFailed', () => {
  it('clears answeringId but keeps the item and the open view', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');
    state = answerStarted(state, 'a');

    state = answerFailed(state, 'a');

    expect(state.answeringId).toBeNull();
    expect(state.openId).toBe('a');
    expect(state.items).toEqual([a]);
  });

  it('is a no-op for an id we are not answering', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = answerStarted(state, 'a');

    const after = answerFailed(state, 'other');

    expect(after).toBe(state);
  });
});

describe('answerSucceeded', () => {
  it('removes the item and closes it', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');
    state = answerStarted(state, 'a');

    state = answerSucceeded(state, 'a');

    expect(state.items).toEqual([]);
    expect(state.openId).toBeNull();
    expect(state.answeringId).toBeNull();
  });

  it('is idempotent when resolved already removed the item and closed the view', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = opened(state, 'a');
    state = answerStarted(state, 'a');
    state = resolved(state, 'a');

    const after = answerSucceeded(state, 'a');

    expect(after.items).toEqual([]);
    expect(after.openId).toBeNull();
    expect(after.answeringId).toBeNull();
  });
});

describe('noticeCleared', () => {
  it('clears the notice only', () => {
    const a = item({ id: 'a' });
    let state = seededWith(a);
    state = { ...state, notice: ANSWERED_ELSEWHERE };

    state = noticeCleared(state);

    expect(state.notice).toBeNull();
    expect(state.items).toEqual([a]);
  });
});
