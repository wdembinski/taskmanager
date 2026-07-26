import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from '@shared/model';
import type { SessionEvent } from '@shared/session';
import { foldTurns, type Turn } from './turns';

let seq = 0;
const at = (): number => ++seq;
const event = (e: SessionEvent): TaskActivityEntry => ({
  kind: 'event',
  id: at(),
  event: e,
  createdAt: at(),
});
const kinds = (turns: Turn[]): string[] => turns.map((t) => t.kind);

describe('foldTurns', () => {
  it('puts your three kinds of writing on your side, and keeps them apart', () => {
    const turns = foldTurns([
      { kind: 'chat', id: 1, body: 'skip the cache', createdAt: 1 },
      { kind: 'comment', id: 2, body: 'note to self', createdAt: 2 },
      {
        kind: 'jira-comment',
        id: 'j1',
        author: 'Me',
        body: 'on the ticket',
        createdAt: 3,
        mine: true,
      },
    ]);
    expect(turns.map((t) => (t.kind === 'you' ? t.variant : t.kind))).toEqual([
      'chat',
      'note',
      'jira',
    ]);
    // Only a note can be deleted — the other two were read by someone else.
    expect(turns.map((t) => (t.kind === 'you' ? t.commentId : null))).toEqual([null, 2, null]);
  });

  it('puts someone else’s ticket comment on the other side, with their name', () => {
    const [turn] = foldTurns([
      { kind: 'jira-comment', id: 'j2', author: 'Ada', body: 'ping', createdAt: 1, mine: false },
    ]);
    expect(turn).toMatchObject({ kind: 'them', author: 'Ada', body: 'ping' });
  });

  it('merges the agent’s streamed chunks into one turn', () => {
    const turns = foldTurns([
      event({ kind: 'assistant', text: 'I looked at the parser' }),
      event({ kind: 'assistant', text: 'and found the bug.' }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      kind: 'agent',
      text: 'I looked at the parser\nand found the bug.',
    });
  });

  it('folds a run of tool work into one row that counts the calls', () => {
    const turns = foldTurns([
      event({ kind: 'assistant', text: 'working' }),
      event({ kind: 'thinking', text: 'hmm' }),
      event({ kind: 'tool-use', name: 'Grep', toolId: 't1' }),
      event({ kind: 'tool-result', toolId: 't1', isError: false }),
      event({ kind: 'tool-use', name: 'Read', toolId: 't2' }),
      event({ kind: 'tool-result', toolId: 't2', isError: false }),
      event({ kind: 'assistant', text: 'done' }),
    ]);
    expect(kinds(turns)).toEqual(['agent', 'tools', 'agent']);
    expect(turns[1]).toMatchObject({ kind: 'tools', count: 2 });
  });

  it('names the sub-agents a folded run spawned', () => {
    const turns = foldTurns([
      event({
        kind: 'tool-use',
        name: 'Task',
        toolId: 't1',
        input: { description: 'audit the CSS' },
      }),
    ]);
    expect(turns[0]).toMatchObject({ kind: 'tools', count: 1, labels: ['audit the CSS'] });
  });

  it('never hides a failure inside the folded row', () => {
    const turns = foldTurns([
      event({ kind: 'tool-use', name: 'Bash', toolId: 't1' }),
      event({ kind: 'tool-result', toolId: 't1', isError: true }),
      event({ kind: 'stderr', text: 'boom' }),
    ]);
    expect(kinds(turns)).toEqual(['tools', 'system', 'system']);
    expect(turns.filter((t) => t.kind === 'system' && t.tone === 'err')).toHaveLength(2);
  });

  it('drops bookkeeping events and status changes, which belong to Details', () => {
    const turns = foldTurns([
      event({ kind: 'started', sessionId: 's', model: 'sonnet', cwd: '.', permissionMode: 'plan' }),
      event({
        kind: 'usage',
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
      event({ kind: 'exited', code: 0 }),
      { kind: 'status', id: 9, from: 'pending', to: 'running', createdAt: 9 },
    ]);
    expect(turns).toEqual([]);
  });

  it('keeps a thinking-only stretch from becoming an empty row', () => {
    expect(foldTurns([event({ kind: 'thinking', text: 'hmm' })])).toEqual([]);
  });
});
