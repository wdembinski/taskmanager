import { describe, expect, it } from 'vitest';
import {
  coalesceKey,
  dropReason,
  EVENT_FANOUT,
  fanoutPolicy,
  isDroppedPayload,
  isForwarded,
  MAX_EVENT_BYTES,
  truncateEventPayload,
} from './ipcEventFanout';

/**
 * The classification, restated here as data rather than derived from the module under test —
 * a test that reads its expectation out of the thing it is testing passes for any table at
 * all (the point `ipcRelay.test.ts` makes for the other direction). A channel silently
 * changing class is what this catches.
 */
const CLASSIFIED: ReadonlyArray<readonly [string, string]> = [
  ['session:event', 'stream'],
  ['session:gap', 'replace-by-key'],
  ['task:changed', 'replace-by-key'],
  ['task:integrating', 'replace-last'],
  ['scheduler:changed', 'replace-by-key'],
  ['attention:new', 'stream'],
  ['attention:resolved', 'stream'],
  ['board:notice', 'stream'],
  ['limit:changed', 'replace-last'],
  ['auth:changed', 'replace-last'],
  ['usage:sample', 'replace-last'],
  ['mergeRequests:changed', 'replace-last'],
  ['chain:changed', 'replace-last'],
  ['attachment:changed', 'replace-last'],
  ['sync:changed', 'replace-last'],
  ['settings:changed', 'replace-last'],
  ['update:changed', 'replace-last'],
  ['ticketProject:changed', 'replace-last'],
  ['ticketLink:changed', 'replace-last'],
  ['person:changed', 'replace-last'],
  ['label:changed', 'replace-last'],
  ['milestone:changed', 'replace-last'],
  ['window:maximizedChanged', 'drop'],
  ['project:tasksChanged', 'drop'],
];

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe('the fanout classification', () => {
  for (const [channel, kind] of CLASSIFIED) {
    it(`${channel} is ${kind}`, () => {
      expect(fanoutPolicy(channel)?.kind).toBe(kind);
    });
  }

  it('covers exactly the event channels — no more, no fewer', () => {
    expect(Object.keys(EVENT_FANOUT).sort()).toEqual(CLASSIFIED.map(([c]) => c).sort());
  });

  it('forwards everything except the two that are deliberately dropped', () => {
    for (const [channel, kind] of CLASSIFIED) {
      expect(isForwarded(channel)).toBe(kind !== 'drop');
    }
  });

  it('says WHY a dropped channel is dropped, and says nothing for one that is not', () => {
    expect(dropReason('window:maximizedChanged')).toContain('no app window');
    expect(dropReason('project:tasksChanged')).toContain('mirror');
    expect(dropReason('task:changed')).toBeNull();
  });

  it('does not treat a prototype key as a channel', () => {
    // `EVENT_FANOUT` is an object literal, so `'constructor' in it` is true — a lookup that
    // trusted `in` rather than the VALUE would forward it.
    expect(fanoutPolicy('constructor')).toBeNull();
    expect(isForwarded('constructor')).toBe(false);
    expect(isForwarded('session:selfDestruct')).toBe(false);
    expect(dropReason('constructor')).toBeNull();
  });
});

describe('the coalescing key', () => {
  const change = (id: string): unknown => ({ task: { id, title: 'x' }, runId: null });

  it('is the channel itself for a whole-list event, whatever the payload', () => {
    expect(coalesceKey('chain:changed', [])).toBe('chain:changed');
    expect(coalesceKey('chain:changed', [{ id: 'l1' }])).toBe('chain:changed');
  });

  it('separates two cards, and collapses two updates to one card', () => {
    const first = coalesceKey('task:changed', change('t1'));
    expect(first).toBe(coalesceKey('task:changed', change('t1')));
    expect(first).not.toBe(coalesceKey('task:changed', change('t2')));
    expect(first).toContain('task:changed');
    expect(first).toContain('t1');
  });

  it('cannot collide a channel name with a subject id', () => {
    // The separator is a NUL, so `'a:b' + 'c'` and `'a' + 'b:c'` stay distinct even though
    // the concatenation of their characters is identical.
    const key = coalesceKey('task:changed', change('run-1'));
    expect(key).not.toBe('task:changedrun-1');
    expect(key).not.toBe('task:changed:run-1');
  });

  it('keys a scheduler change by its project and a gap by its run', () => {
    expect(coalesceKey('scheduler:changed', { projectId: 'p1', state: 'running' })).toContain('p1');
    expect(coalesceKey('session:gap', { runId: 'r9' })).toContain('r9');
  });

  it('is null for a stream, and for anything that should never have been queued', () => {
    expect(coalesceKey('session:event', { runId: 'r1', event: { kind: 'assistant' } })).toBeNull();
    expect(coalesceKey('attention:new', { id: 'a1' })).toBeNull();
    expect(coalesceKey('window:maximizedChanged', true)).toBeNull();
    expect(coalesceKey('nope:nope', null)).toBeNull();
  });
});

describe('the 32 KB envelope cap', () => {
  it('leaves a board-sized payload exactly as it was', () => {
    const payload = { task: { id: 't1', title: 'Ship the push channel' }, runId: 'r1' };
    const result = truncateEventPayload(payload);
    expect(result.truncated).toBe(false);
    expect(result.payload).toBe(payload); // the same object, not a clone
  });

  it("clips a Write tool's file content but keeps everything that identifies it", () => {
    const payload = {
      runId: 'r1',
      event: {
        kind: 'tool-use',
        name: 'Write',
        toolId: 'tu_1',
        input: { file_path: '/repo/src/huge.ts', content: 'x'.repeat(200_000) },
      },
    };
    const { payload: capped, truncated } = truncateEventPayload(payload);

    expect(truncated).toBe(true);
    expect(byteLength(capped)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const event = (capped as { event: { name: string; input: Record<string, string> } }).event;
    expect(event.name).toBe('Write');
    expect(event.input.file_path).toBe('/repo/src/huge.ts');
    // What was lost is stated, rather than the string just ending mid-word.
    expect(event.input.content).toContain('characters');
    expect(event.input.content.length).toBeLessThan(10_000);
  });

  it('measures BYTES, not characters — a multi-byte string is not half a cap', () => {
    // 20k characters is well under the cap; 20k two-byte characters is 40 KB and over it.
    const payload = { text: 'é'.repeat(20_000) };
    expect(payload.text.length).toBeLessThan(MAX_EVENT_BYTES);
    const { truncated, payload: capped } = truncateEventPayload(payload);
    expect(truncated).toBe(true);
    expect(byteLength(capped)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  it('honours a caller-supplied cap', () => {
    const payload = { text: 'x'.repeat(5_000) };
    expect(truncateEventPayload(payload, MAX_EVENT_BYTES).truncated).toBe(false);
    const tight = truncateEventPayload(payload, 512);
    expect(tight.truncated).toBe(true);
    expect(byteLength(tight.payload)).toBeLessThanOrEqual(512);
  });

  it('gives up honestly when clamping strings cannot get it under the cap', () => {
    // Thousands of tiny fields: there is no long string to clip, so the payload is dropped
    // rather than sent oversized.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i += 1) wide[`field${i}`] = i;
    const { payload, truncated } = truncateEventPayload(wide);

    expect(truncated).toBe(true);
    expect(isDroppedPayload(payload)).toBe(true);
    expect((payload as { bytes: number }).bytes).toBeGreaterThan(MAX_EVENT_BYTES);
  });

  it('drops a payload JSON refuses rather than throwing at the forwarder', () => {
    const cyclic: Record<string, unknown> = { runId: 'r1' };
    cyclic.self = cyclic;
    const { payload, truncated } = truncateEventPayload(cyclic);

    expect(truncated).toBe(true);
    expect(isDroppedPayload(payload)).toBe(true);
    expect((payload as { bytes: number }).bytes).toBe(-1);
  });

  it('recognizes a dropped payload, and only a dropped payload', () => {
    expect(isDroppedPayload(null)).toBe(false);
    expect(isDroppedPayload({ runId: 'r1' })).toBe(false);
    expect(isDroppedPayload('__eventPayloadDropped')).toBe(false);
  });
});
