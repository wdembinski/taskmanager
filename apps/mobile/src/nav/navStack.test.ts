import { describe, expect, it } from 'vitest';
import { navStackReducer, topOverlay, topScreen, type NavStack } from './navStack';

const ROOT: NavStack = [{ type: 'tab', screen: 'mytasks' }];

describe('navStackReducer', () => {
  it('push appends a frame to the top of the stack', () => {
    const next = navStackReducer(ROOT, { type: 'push', frame: { type: 'task', taskId: 't1' } });
    expect(next).toEqual([
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't1' },
    ]);
  });

  it('popTo trims the stack down to depth + 1 frames', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't1' },
      { type: 'graph' },
    ];
    expect(navStackReducer(stack, { type: 'popTo', depth: 1 })).toEqual([
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't1' },
    ]);
  });

  it('popTo back to depth 0 leaves only the root frame', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't1' },
    ];
    expect(navStackReducer(stack, { type: 'popTo', depth: 0 })).toEqual(ROOT);
  });

  it('popTo below the root is a no-op — the root frame can never be popped', () => {
    expect(navStackReducer(ROOT, { type: 'popTo', depth: -1 })).toBe(ROOT);
  });

  it('popTo past the current top is a no-op — the stack never grows on pop', () => {
    const stack: NavStack = [{ type: 'tab', screen: 'mytasks' }, { type: 'graph' }];
    expect(navStackReducer(stack, { type: 'popTo', depth: 5 })).toBe(stack);
  });
});

describe('topScreen', () => {
  it('reads the screen off a stack that is just the root tab frame', () => {
    expect(topScreen(ROOT)).toBe('mytasks');
  });

  it('is unaffected by an overlay pushed on top of the tab', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't1' },
    ];
    expect(topScreen(stack)).toBe('mytasks');
  });

  it('follows the most recently pushed tab frame after a tab switch', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'tab', screen: 'settings' },
    ];
    expect(topScreen(stack)).toBe('settings');
  });

  it('falls back to the nearest tab frame below an overlay pushed after a tab switch', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'tab', screen: 'settings' },
      { type: 'addTask' },
    ];
    expect(topScreen(stack)).toBe('settings');
  });
});

describe('topOverlay', () => {
  it('is null when the tab frame itself is on top', () => {
    expect(topOverlay(ROOT)).toBeNull();
  });

  it('surfaces the frame pushed on top of the tab', () => {
    const stack: NavStack = [{ type: 'tab', screen: 'mytasks' }, { type: 'addTask' }];
    expect(topOverlay(stack)).toEqual({ type: 'addTask' });
  });

  it('reflects a task frame including its taskId', () => {
    const stack: NavStack = [
      { type: 'tab', screen: 'mytasks' },
      { type: 'task', taskId: 't42' },
    ];
    expect(topOverlay(stack)).toEqual({ type: 'task', taskId: 't42' });
  });
});

describe('a tab switch and back round trip', () => {
  it('restores the earlier overlay once the tab switch itself is undone', () => {
    const withTask: NavStack = navStackReducer(ROOT, {
      type: 'push',
      frame: { type: 'task', taskId: 't1' },
    });
    const switched = navStackReducer(withTask, {
      type: 'push',
      frame: { type: 'tab', screen: 'settings' },
    });
    expect(topScreen(switched)).toBe('settings');
    expect(topOverlay(switched)).toBeNull();

    const backOnce = navStackReducer(switched, { type: 'popTo', depth: 1 });
    expect(topScreen(backOnce)).toBe('mytasks');
    expect(topOverlay(backOnce)).toEqual({ type: 'task', taskId: 't1' });
  });
});
