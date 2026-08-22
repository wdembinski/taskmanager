import { describe, expect, it } from 'vitest';
import { RESULTS_BYTES_LIMIT, boundCloudResults, type PendingResultRow } from './cloudResults';

/** A pending answer whose `value` is `bytes`-ish of JSON — enough to drive the budget. */
function row(commandId: string, bytes: number): PendingResultRow {
  return { commandId, ok: true, reason: null, value: 'x'.repeat(bytes) };
}

describe('boundCloudResults', () => {
  it('shapes a stored outcome the way the wire wants it', () => {
    const { results, sent, oversized } = boundCloudResults([
      { commandId: 'cmd-1', ok: true, reason: null, value: 7 },
      { commandId: 'cmd-2', ok: false, reason: 'nope' },
    ]);
    expect(results).toEqual([
      { commandId: 'cmd-1', ok: true, value: 7 },
      { commandId: 'cmd-2', ok: false, error: 'nope' },
    ]);
    expect(sent).toEqual(['cmd-1', 'cmd-2']);
    expect(oversized).toEqual([]);
  });

  it('leaves the answers past the budget for the next tick', () => {
    const { results, sent } = boundCloudResults(
      [row('a', 600), row('b', 600), row('c', 600)],
      1000,
    );
    expect(results.map((r) => r.commandId)).toEqual(['a']);
    expect(sent).toEqual(['a']);
  });

  it('always carries one answer, however small the budget', () => {
    // Otherwise a budget below the head of the queue sends nothing, marks nothing sent, and
    // the queue — and every outbox row behind it — never moves.
    const { results, sent } = boundCloudResults([row('a', 5000)], 10);
    expect(results.map((r) => r.commandId)).toEqual(['a']);
    expect(sent).toEqual(['a']);
  });

  it('replaces an answer too large to ever be sent with an error, and keeps going', () => {
    const { results, sent, oversized } = boundCloudResults(
      [row('huge', 5000), row('small', 10)],
      100_000,
      1000,
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/too large to send/);
    expect(results[0]!.value).toBeUndefined();
    // The point of the replacement: the answer behind it goes out on the SAME tick.
    expect(results.map((r) => r.commandId)).toEqual(['huge', 'small']);
    expect(sent).toEqual(['huge', 'small']);
    expect(oversized).toEqual([{ commandId: 'huge', bytes: expect.any(Number) }]);
    expect(oversized[0]!.bytes).toBeGreaterThan(1000);
  });

  it('defers under a shrunken budget rather than destroying a sendable answer', () => {
    // A 413 halves the budget, never the hard cap: an answer that was sendable a minute ago
    // must come back next tick, not be swapped for an error.
    const rows = [row('a', 50_000), row('b', 50_000)];
    const { results, oversized } = boundCloudResults(rows, 60_000, RESULTS_BYTES_LIMIT);
    expect(results.map((r) => r.commandId)).toEqual(['a']);
    expect(results[0]!.ok).toBe(true);
    expect(oversized).toEqual([]);
  });

  it('the real wedge: 36 answers totalling 10 MB no longer build one 10 MB request', () => {
    // The shape of the failure on 15 Aug 2026 — thirty-odd timeline answers of ~300 kB each,
    // sent whole on every tick and refused 413 every time.
    const rows = Array.from({ length: 36 }, (_v, i) => row(`cmd-${i}`, 300_000));
    const { results } = boundCloudResults(rows);
    const bytes = Buffer.byteLength(JSON.stringify(results), 'utf8');
    expect(bytes).toBeLessThanOrEqual(RESULTS_BYTES_LIMIT);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(rows.length);
  });

  it('takes nothing when there is nothing pending', () => {
    expect(boundCloudResults([])).toEqual({ results: [], sent: [], oversized: [] });
  });
});
