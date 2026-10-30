import { describe, expect, it } from 'vitest';
import { taskBundle, taskGetSpec } from './taskBundle.mjs';

const ROWS = [
  { id: 'p', projectId: 'x', order: 0 },
  { id: 's2', projectId: 'x', parentTaskId: 'p', order: 2 },
  { id: 's1', projectId: 'x', parentTaskId: 'p', order: 1 },
];

describe('taskBundle', () => {
  it('answers a card with its steps in order and no parent', () => {
    const b = taskBundle(ROWS, 'p');
    expect(b.task.id).toBe('p');
    expect(b.parent).toBeNull();
    expect(b.steps.map((t) => t.id)).toEqual(['s1', 's2']);
  });

  it('answers a step with its parent', () => {
    expect(taskBundle(ROWS, 's1').parent.id).toBe('p');
  });

  it('answers null for an unknown id', () => {
    expect(taskBundle(ROWS, 'zz')).toBeNull();
  });

  it('keys a task:get spec on every row, null otherwise', () => {
    const spec = taskGetSpec(ROWS);
    expect(Object.keys(spec.byArgTable)).toEqual(['p', 's2', 's1']);
    expect(spec.fallback).toBeNull();
  });
});
