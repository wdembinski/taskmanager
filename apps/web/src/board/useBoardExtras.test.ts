import { describe, expect, it } from 'vitest';
import type { Transport } from '@tm/ui/transport';
import { resumeTaskOver, stopTaskOver } from './useBoardExtras';

/**
 * A fake desktop: each channel answers with whatever the test seeded, and every call is
 * recorded IN ORDER, because the order is the claim — a control that re-read the live set
 * before sending its command would read the world as it was and put the wrong badge on the
 * card. Same shape as `polledEvents.test.ts`'s engine, for the same reason.
 */
function fakeTransport(seed: Partial<Record<string, unknown>> = {}) {
  const answers = new Map<string, unknown>(Object.entries(seed));
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const invoke = (async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (!answers.has(channel)) throw new Error(`no fake answer for ${channel}`);
    const answer = answers.get(channel);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Transport['invoke'];
  return { invoke, calls, channels: () => calls.map((c) => c.channel) };
}

describe('the board card’s Resume, over the relay', () => {
  it('relays task:resumeAgent with the card’s id, then re-reads the live set', async () => {
    const transport = fakeTransport({
      'task:resumeAgent': { id: 't1' },
      'scheduler:activeRuns': [{ taskId: 't1' }, { taskId: 't9' }],
    });

    const live = await resumeTaskOver(transport, 't1');

    expect(transport.channels()).toEqual(['task:resumeAgent', 'scheduler:activeRuns']);
    expect(transport.calls[0].args).toEqual(['t1']);
    // The spinner goes on the card NOW, rather than whenever the desktop next syncs.
    expect([...live]).toEqual(['t1', 't9']);
  });

  it('does not claim a run when the resume itself was refused', async () => {
    // A relayed command can be refused by the desktop (no worktree, no sign-in, a chain
    // already running). Re-reading anyway would be harmless but dishonest about ordering;
    // rejecting is what `BoardScreen` turns into the board's one error line.
    //
    // A usage limit is deliberately NOT one of those any more: `task:resumeAgent` parks the
    // card and RESOLVES with it (`CARD_RECORDS_PARK`), so that path takes the branch above —
    // two calls, and the pane reads `blocked-by-limit` off the card as "Paused — usage
    // limit". What this case covers is the walls a human still has to clear.
    const transport = fakeTransport({ 'task:resumeAgent': new Error('nothing to resume into') });

    await expect(resumeTaskOver(transport, 't1')).rejects.toThrow('nothing to resume into');
    expect(transport.channels()).toEqual(['task:resumeAgent']);
  });

  it('is the exact inverse of Stop — the same two calls, the other command', async () => {
    const transport = fakeTransport({
      'task:stopAgent': { id: 't1' },
      'scheduler:activeRuns': [],
    });

    const live = await stopTaskOver(transport, 't1');

    expect(transport.channels()).toEqual(['task:stopAgent', 'scheduler:activeRuns']);
    expect([...live]).toEqual([]);
  });
});
