import { describe, expect, it } from 'vitest';
import { logEvent, payloadBytes, perfLogEnabled, timeHandler } from './perfLog';

const IPC_LINE = /^perf ipc (\S+) (\d+\.\d)ms in=(-?\d+)B (out=(-?\d+)B|err)$/;

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('perfLogEnabled', () => {
  it('is on for 1 and true, in any case and with stray whitespace', () => {
    expect(perfLogEnabled({ VIPPER_PERF_LOG: '1' })).toBe(true);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: 'true' })).toBe(true);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: 'TRUE' })).toBe(true);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: ' 1 ' })).toBe(true);
  });

  it('is off when unset, empty, or anything else', () => {
    expect(perfLogEnabled({})).toBe(false);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: '' })).toBe(false);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: '0' })).toBe(false);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: 'false' })).toBe(false);
    expect(perfLogEnabled({ VIPPER_PERF_LOG: 'yes' })).toBe(false);
  });
});

describe('payloadBytes', () => {
  it('counts the UTF-8 bytes of the JSON', () => {
    expect(payloadBytes({ a: 1 })).toBe('{"a":1}'.length);
    expect(payloadBytes([])).toBe(2);
    expect(payloadBytes('é')).toBe(4); // "é" — two quotes plus a two-byte character
  });

  it('counts undefined as 0', () => {
    expect(payloadBytes(undefined)).toBe(0);
  });

  it('gives -1 for a circular value without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => payloadBytes(cyclic)).not.toThrow();
    expect(payloadBytes(cyclic)).toBe(-1);
  });
});

describe('timeHandler', () => {
  it('passes the result through and logs the call', async () => {
    const { lines, write } = collector();
    const wrapped = timeHandler('tasks:list', async (id: string) => ({ id }), write);

    await expect(wrapped('p1')).resolves.toEqual({ id: 'p1' });

    expect(lines).toHaveLength(1);
    const match = IPC_LINE.exec(lines[0]);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('tasks:list');
    expect(Number(match?.[3])).toBe(payloadBytes(['p1']));
    expect(Number(match?.[5])).toBe(payloadBytes({ id: 'p1' }));
  });

  it('passes undefined through and counts it as 0 bytes out', async () => {
    const { lines, write } = collector();
    const wrapped = timeHandler('window:noop', () => undefined, write);

    await expect(wrapped()).resolves.toBeUndefined();
    expect(lines[0]).toMatch(/^perf ipc window:noop \d+\.\dms in=2B out=0B$/);
  });

  it('wraps a synchronous handler too', async () => {
    const { write } = collector();
    const wrapped = timeHandler('sum', (a: number, b: number) => a + b, write);
    await expect(wrapped(2, 3)).resolves.toBe(5);
  });

  it('rethrows the handler error unchanged after logging err', async () => {
    const { lines, write } = collector();
    const boom = new Error('boom');
    const wrapped = timeHandler(
      'attention:answer',
      async () => {
        throw boom;
      },
      write,
    );

    await expect(wrapped()).rejects.toBe(boom);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^perf ipc attention:answer \d+\.\dms in=2B err$/);
  });

  it('logs -1 for a result it cannot serialise, and still returns it', async () => {
    const { lines, write } = collector();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const wrapped = timeHandler('odd', () => cyclic, write);

    await expect(wrapped()).resolves.toBe(cyclic);
    expect(lines[0]).toMatch(/ out=-1B$/);
  });

  it('never lets a throwing writer change the outcome', async () => {
    const wrapped = timeHandler(
      'x',
      () => 7,
      () => {
        throw new Error('disk full');
      },
    );
    await expect(wrapped()).resolves.toBe(7);
  });
});

describe('logEvent', () => {
  it('writes the channel and payload bytes', () => {
    const { lines, write } = collector();
    const payload = { projectId: 'p', tasks: [] };
    logEvent('project:tasksChanged', payload, write);
    expect(lines).toEqual([`perf event project:tasksChanged ${payloadBytes(payload)}B`]);
  });

  it('writes -1 for a circular payload without throwing', () => {
    const { lines, write } = collector();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logEvent('weird', cyclic, write)).not.toThrow();
    expect(lines).toEqual(['perf event weird -1B']);
  });
});
