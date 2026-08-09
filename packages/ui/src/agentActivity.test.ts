import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@tm/shared/session';
import { isTranscriptNoise, runningSubAgents } from './agentActivity';

const toolUse = (name: string, toolId: string, input?: Record<string, unknown>): SessionEvent => ({
  kind: 'tool-use',
  name,
  toolId,
  input,
});
const toolResult = (toolId: string, isError = false): SessionEvent => ({
  kind: 'tool-result',
  toolId,
  isError,
});

describe('isTranscriptNoise', () => {
  it('filters thinking and tool chatter', () => {
    expect(isTranscriptNoise({ kind: 'thinking', text: 'hmm' })).toBe(true);
    expect(isTranscriptNoise(toolUse('Glob', 't1'))).toBe(true);
    expect(isTranscriptNoise(toolResult('t1'))).toBe(true);
  });

  it('keeps what a human reads', () => {
    expect(isTranscriptNoise({ kind: 'assistant', text: 'Done.' })).toBe(false);
    expect(isTranscriptNoise({ kind: 'stderr', text: 'boom' })).toBe(false);
    expect(
      isTranscriptNoise({
        kind: 'started',
        sessionId: 's',
        model: 'sonnet',
        cwd: '/x',
        permissionMode: 'plan',
      }),
    ).toBe(false);
  });

  it('keeps failed tool results so a broken run is visible', () => {
    expect(isTranscriptNoise(toolResult('t1', true))).toBe(false);
  });
});

describe('runningSubAgents', () => {
  it('reports a spawned sub-agent that has not returned', () => {
    const agents = runningSubAgents([
      toolUse('Task', 't1', { description: 'Search the codebase' }),
    ]);
    expect(agents).toEqual([{ toolId: 't1', label: 'Search the codebase' }]);
  });

  it('drops it once its result arrives', () => {
    expect(runningSubAgents([toolUse('Task', 't1'), toolResult('t1')])).toEqual([]);
  });

  it('tracks several at once, in spawn order', () => {
    const agents = runningSubAgents([
      toolUse('Task', 't1', { description: 'one' }),
      toolUse('Task', 't2', { description: 'two' }),
      toolResult('t1'),
      toolUse('Task', 't3', { description: 'three' }),
    ]);
    expect(agents.map((a) => a.label)).toEqual(['two', 'three']);
  });

  it('ignores ordinary tools', () => {
    expect(runningSubAgents([toolUse('Bash', 't1'), toolUse('Read', 't2')])).toEqual([]);
  });

  it('falls back through description → subagent_type → prompt, and truncates', () => {
    expect(runningSubAgents([toolUse('Task', 't1', { subagent_type: 'Explore' })])[0].label).toBe(
      'Explore',
    );
    expect(runningSubAgents([toolUse('Task', 't1', {})])[0].label).toBeNull();
    const long = 'x'.repeat(200);
    expect(runningSubAgents([toolUse('Task', 't1', { prompt: long })])[0].label).toHaveLength(81);
  });

  it('clears everything when the run ends', () => {
    const ended = runningSubAgents([
      toolUse('Task', 't1'),
      {
        kind: 'result',
        success: true,
        resultText: '',
        costUsd: null,
        durationMs: null,
        stopReason: null,
        terminalReason: null,
        usage: null,
      },
    ]);
    expect(ended).toEqual([]);
  });
});
