import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from '@shared/model';
import { mergeActivity } from './activityMerge';

const comment = (id: number, createdAt: number): TaskActivityEntry => ({
  kind: 'comment',
  id,
  body: `c${id}`,
  createdAt,
});
const status = (id: number, createdAt: number): TaskActivityEntry => ({
  kind: 'status',
  id,
  from: 'pending',
  to: 'in-progress',
  createdAt,
});
const event = (id: number, createdAt: number): TaskActivityEntry => ({
  kind: 'event',
  id,
  event: { kind: 'assistant', text: `e${id}` },
  createdAt,
});

describe('mergeActivity', () => {
  it('interleaves the two sources oldest-first by timestamp', () => {
    const merged = mergeActivity([
      comment(1, 300),
      status(1, 100),
      event(5, 200),
      comment(2, 400),
    ]);
    expect(merged.map((e) => [e.kind, e.createdAt])).toEqual([
      ['status', 100],
      ['event', 200],
      ['comment', 300],
      ['comment', 400],
    ]);
  });

  it('breaks ties deterministically: status → comment → event, then id', () => {
    const merged = mergeActivity([event(9, 50), comment(3, 50), status(7, 50), status(2, 50)]);
    expect(merged.map((e) => [e.kind, e.id])).toEqual([
      ['status', 2],
      ['status', 7],
      ['comment', 3],
      ['event', 9],
    ]);
  });

  it('does not mutate its input', () => {
    const input = [comment(1, 200), status(1, 100)];
    const copy = [...input];
    mergeActivity(input);
    expect(input).toEqual(copy);
  });
});
