import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  PANEL_HISTORY_LIMIT,
  backHistory,
  pushHistory,
  type PanelHistory,
} from './panelHistory';

const ALWAYS_EXISTS = () => true;

describe('pushHistory', () => {
  it('pushes the id being left onto the stack', () => {
    const history = pushHistory(EMPTY_HISTORY, 't1');
    expect(history.stack).toEqual(['t1']);
  });

  it('is a no-op for null', () => {
    const history = pushHistory(EMPTY_HISTORY, null);
    expect(history).toBe(EMPTY_HISTORY);
  });

  it('is a no-op for the same id twice in a row', () => {
    const once = pushHistory(EMPTY_HISTORY, 't1');
    const twice = pushHistory(once, 't1');
    expect(twice).toBe(once);
    expect(twice.stack).toEqual(['t1']);
  });

  it('caps the stack at PANEL_HISTORY_LIMIT, dropping the oldest entry', () => {
    let history: PanelHistory = EMPTY_HISTORY;
    for (let i = 0; i < PANEL_HISTORY_LIMIT + 3; i += 1) {
      history = pushHistory(history, `t${i}`);
    }
    expect(history.stack).toHaveLength(PANEL_HISTORY_LIMIT);
    expect(history.stack[0]).toBe(`t3`);
    expect(history.stack[history.stack.length - 1]).toBe(`t${PANEL_HISTORY_LIMIT + 2}`);
  });
});

describe('backHistory', () => {
  it('pops the most recent id', () => {
    const history = pushHistory(pushHistory(EMPTY_HISTORY, 't1'), 't2');
    const result = backHistory(history, ALWAYS_EXISTS);
    expect(result.taskId).toBe('t2');
    expect(result.history.stack).toEqual(['t1']);
  });

  it('skips an entry a deleted ticket left behind', () => {
    const history = pushHistory(pushHistory(EMPTY_HISTORY, 't1'), 't2');
    const result = backHistory(history, (id) => id !== 't2');
    expect(result.taskId).toBe('t1');
    expect(result.history.stack).toEqual([]);
  });

  it('returns null with an empty stack when every entry is deleted', () => {
    const history = pushHistory(pushHistory(EMPTY_HISTORY, 't1'), 't2');
    const result = backHistory(history, () => false);
    expect(result.taskId).toBeNull();
    expect(result.history.stack).toEqual([]);
  });

  it('is a no-op on an empty history', () => {
    const result = backHistory(EMPTY_HISTORY, ALWAYS_EXISTS);
    expect(result.taskId).toBeNull();
    expect(result.history).toBe(EMPTY_HISTORY);
  });
});
