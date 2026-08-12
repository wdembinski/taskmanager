import { describe, expect, it, vi } from 'vitest';
import { CommandQueue } from './commandQueue';

const cmd = (id: string) => ({ id });

/** A promise plus the handle to settle it later — for pinning a drain mid-command. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CommandQueue', () => {
  it('runs commands one at a time, in the order it was given them', async () => {
    const order: string[] = [];
    let live = 0;
    const queue = new CommandQueue({
      run: async (c: { id: string }) => {
        live++;
        expect(live, 'two commands ran at once').toBe(1);
        await Promise.resolve();
        order.push(c.id);
        live--;
        return c.id;
      },
    });

    queue.enqueue([cmd('a'), cmd('b'), cmd('c')]);
    await queue.idle();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('emits each result, paired with its command, in run order', async () => {
    const seen: Array<[string, string]> = [];
    const queue = new CommandQueue({
      run: async (c: { id: string }) => `${c.id}-done`,
      onResult: (c, r) => seen.push([c.id, r]),
    });

    queue.enqueue([cmd('a'), cmd('b')]);
    await queue.idle();
    expect(seen).toEqual([
      ['a', 'a-done'],
      ['b', 'b-done'],
    ]);
  });

  it('does not start a second drain when more arrive mid-drain', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    let live = 0;
    const queue = new CommandQueue({
      run: async (c: { id: string }) => {
        live++;
        expect(live).toBe(1);
        if (c.id === 'a') await gate.promise;
        order.push(c.id);
        live--;
        return null;
      },
    });

    queue.enqueue([cmd('a')]);
    // 'a' is now parked inside `run`. This is the poll tick landing on top of it.
    queue.enqueue([cmd('b'), cmd('c')]);
    expect(order).toEqual([]);

    gate.resolve();
    await queue.idle();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps ordering across interleaved enqueues', async () => {
    const order: string[] = [];
    const queue = new CommandQueue({
      run: async (c: { id: string }) => {
        // Yield a couple of turns so a second drain would visibly interleave.
        await Promise.resolve();
        await Promise.resolve();
        order.push(c.id);
        return null;
      },
    });

    queue.enqueue([cmd('a'), cmd('b')]);
    queue.enqueue([cmd('c')]);
    await queue.idle();
    queue.enqueue([cmd('d')]);
    await queue.idle();

    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not let a rejecting command abort the batch', async () => {
    const done: string[] = [];
    const errors: string[] = [];
    const queue = new CommandQueue({
      run: async (c: { id: string }) => {
        if (c.id === 'b') throw new Error('boom');
        done.push(c.id);
        return null;
      },
      onError: (c) => errors.push(c.id),
    });

    queue.enqueue([cmd('a'), cmd('b'), cmd('c')]);
    await queue.idle();

    expect(done).toEqual(['a', 'c']);
    expect(errors).toEqual(['b']);
  });

  it('drops a redelivered id rather than running it twice this process', async () => {
    const run = vi.fn(async () => null);
    const queue = new CommandQueue({ run });

    queue.enqueue([cmd('a')]);
    await queue.idle();
    queue.enqueue([cmd('a')]);
    await queue.idle();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('picks up something enqueued during the very last await of a drain', async () => {
    // The gap this closes: `draining` is cleared in a `finally`, and anything that arrived
    // while the last command was still awaiting would otherwise wait for the next poll.
    const order: string[] = [];
    const queue: CommandQueue<{ id: string }, null> = new CommandQueue({
      run: async (c: { id: string }) => {
        order.push(c.id);
        if (c.id === 'a') queue.enqueue([cmd('b')]);
        return null;
      },
    });

    queue.enqueue([cmd('a')]);
    await queue.idle();
    expect(order).toEqual(['a', 'b']);
  });

  it('is idle before anything is enqueued', async () => {
    const queue = new CommandQueue({ run: async () => null });
    expect(queue.busy).toBe(false);
    await queue.idle();
  });
});
