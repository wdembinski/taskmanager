import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from '@tm/shared/model';
import {
  EMPTY_TIMELINE,
  timelineAccepts,
  timelineActivityArrived,
  timelineCommentsArrived,
  timelineLoadStarted,
} from './taskTimeline';

const activity = (id: number): TaskActivityEntry => ({
  kind: 'comment',
  id,
  body: `activity ${id}`,
  createdAt: id,
});
const comment = (id: number): TaskActivityEntry => ({
  kind: 'comment',
  id,
  body: `comment ${id}`,
  createdAt: id,
});

describe('timelineLoadStarted', () => {
  it('clears a card switch in the same step that starts the new load', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineActivityArrived(state, 'a', 1, [activity(1)]);
    state = timelineCommentsArrived(state, 'a', 1, [comment(1)]);

    const switched = timelineLoadStarted(state, 'b', 2);

    expect(switched).toMatchObject({
      taskId: 'b',
      activity: [],
      ticketComments: [],
      loading: true,
    });
  });

  it('keeps an already-loaded timeline on screen while the same card reloads', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineActivityArrived(state, 'a', 1, [activity(1)]);
    state = timelineCommentsArrived(state, 'a', 1, [comment(1)]);

    const reloaded = timelineLoadStarted(state, 'a', 2);

    expect(reloaded.activity).toEqual([activity(1)]);
    expect(reloaded.ticketComments).toEqual([comment(1)]);
    expect(reloaded.loading).toBe(true);
  });
});

describe('timelineActivityArrived', () => {
  it('never lets an answer meant for one card land on another', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineLoadStarted(state, 'b', 2);

    const result = timelineActivityArrived(state, 'a', 1, [activity(1)]);

    expect(result).toBe(state);
  });

  it('keeps the newest answer no matter which order two loads settle in', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineLoadStarted(state, 'a', 2);
    // The newer load's answer lands first…
    state = timelineActivityArrived(state, 'a', 2, [activity(2)]);
    // …then the older load's answer arrives late.
    const after = timelineActivityArrived(state, 'a', 1, [activity(1)]);

    expect(after).toBe(state);
    expect(after.activity).toEqual([activity(2)]);
  });

  it('keeps the newest answer when it arrives after the older one instead', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineLoadStarted(state, 'a', 2);
    state = timelineActivityArrived(state, 'a', 1, [activity(1)]);
    state = timelineActivityArrived(state, 'a', 2, [activity(2)]);

    expect(state.activity).toEqual([activity(2)]);
  });
});

describe('timelineCommentsArrived', () => {
  it("drops a superseded load's tail arriving between the two awaits", () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineActivityArrived(state, 'a', 1, [activity(1)]);
    // A newer load starts before load 1's second await (its ticket comments) settles.
    state = timelineLoadStarted(state, 'a', 2);

    const stale = timelineCommentsArrived(state, 'a', 1, [comment(1)]);

    expect(stale).toBe(state);
  });

  it("cannot clear a newer load's loading flag", () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineLoadStarted(state, 'a', 2);
    expect(state.loading).toBe(true);

    const after = timelineCommentsArrived(state, 'a', 1, [comment(1)]);

    expect(after).toBe(state);
    expect(after.loading).toBe(true);
  });

  it('turns loading off once the newest load finishes', () => {
    let state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    state = timelineActivityArrived(state, 'a', 1, [activity(1)]);
    state = timelineCommentsArrived(state, 'a', 1, [comment(1)]);

    expect(state.loading).toBe(false);
    expect(state.ticketComments).toEqual([comment(1)]);
  });
});

describe('timelineAccepts', () => {
  it('accepts the newest load for the current card', () => {
    const state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    expect(timelineAccepts(state, 'a', 1)).toBe(true);
  });

  it('refuses an older load once a newer one has started', () => {
    const state = timelineLoadStarted(timelineLoadStarted(EMPTY_TIMELINE, 'a', 1), 'a', 2);
    expect(timelineAccepts(state, 'a', 1)).toBe(false);
  });

  it('refuses an answer meant for a different card', () => {
    const state = timelineLoadStarted(EMPTY_TIMELINE, 'a', 1);
    expect(timelineAccepts(state, 'b', 1)).toBe(false);
  });
});
