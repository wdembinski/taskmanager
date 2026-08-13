import { describe, expect, it, vi } from 'vitest';
import { runShutdownSteps, type ShutdownStep } from './shutdown';

/**
 * A stand-in for `before-quit`'s disposer list: each step records that it ran, and the
 * names in `boom` throw instead. `store` is last, as it is in the real handler — it is
 * the step whose survival the whole module is about.
 */
function harness(names: readonly string[], boom: readonly string[] = []) {
  const ran: string[] = [];
  const errors: Array<[string, unknown]> = [];
  const steps: ShutdownStep[] = names.map((name) => ({
    name,
    run: () => {
      ran.push(name);
      if (boom.includes(name)) throw new Error(`${name} failed`);
    },
  }));
  return { steps, ran, errors, onError: (n: string, e: unknown) => errors.push([n, e]) };
}

describe('runShutdownSteps', () => {
  it('runs every step, in the order given', () => {
    const { steps, ran, errors, onError } = harness(['tracker', 'scheduler', 'store']);

    runShutdownSteps(steps, onError);

    expect(ran).toEqual(['tracker', 'scheduler', 'store']);
    expect(errors).toEqual([]);
  });

  // The regression: `windowTracker.dispose()` threw `The database connection is not open`
  // and took `store.close()` — the WAL checkpoint — down with it.
  it('runs the later steps after one throws, including the store close', () => {
    const { steps, ran, onError } = harness(['tracker', 'scheduler', 'store'], ['tracker']);

    runShutdownSteps(steps, onError);

    expect(ran).toEqual(['tracker', 'scheduler', 'store']);
  });

  it('keeps going when several steps throw', () => {
    const { steps, ran, errors, onError } = harness(
      ['tracker', 'scheduler', 'sessions', 'store'],
      ['tracker', 'sessions'],
    );

    runShutdownSteps(steps, onError);

    expect(ran).toEqual(['tracker', 'scheduler', 'sessions', 'store']);
    expect(errors.map(([name]) => name)).toEqual(['tracker', 'sessions']);
  });

  it('reports the failing step by name, with the error it threw', () => {
    const { steps, errors, onError } = harness(['tracker', 'store'], ['tracker']);

    runShutdownSteps(steps, onError);

    expect(errors).toHaveLength(1);
    const [name, err] = errors[0]!;
    expect(name).toBe('tracker');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('tracker failed');
  });

  it('never throws, whatever the steps do', () => {
    const { steps, onError } = harness(['a', 'b'], ['a', 'b']);

    expect(() => runShutdownSteps(steps, onError)).not.toThrow();
  });

  // Quitting before the engine came up: nothing to dispose is not an error.
  it('accepts an empty list', () => {
    const onError = vi.fn();

    expect(() => runShutdownSteps([], onError)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  // Teardown must survive its own reporter — logging touches the filesystem.
  it('runs the remaining steps even if onError itself throws', () => {
    const { steps, ran } = harness(['tracker', 'store'], ['tracker']);

    expect(() =>
      runShutdownSteps(steps, () => {
        throw new Error('the log is unwritable');
      }),
    ).not.toThrow();
    expect(ran).toEqual(['tracker', 'store']);
  });
});
