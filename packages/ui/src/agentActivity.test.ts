import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@tm/shared/session';
import { activityLabel, isTranscriptNoise, runningSubAgents } from './agentActivity';

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

describe('activityLabel', () => {
  it('names a file read or write by its last path segment', () => {
    expect(activityLabel(toolUse('Read', 't1', { file_path: 'src/foo.ts' }))).toBe(
      'Reading foo.ts',
    );
    expect(activityLabel(toolUse('Write', 't1', { file_path: 'C:\\proj\\bar.tsx' }))).toBe(
      'Writing bar.tsx',
    );
    expect(activityLabel(toolUse('Edit', 't1', { file_path: 'baz.ts' }))).toBe('Editing baz.ts');
  });

  it('falls back to a generic phrase with no path', () => {
    expect(activityLabel(toolUse('Read', 't1'))).toBe('Reading a file');
  });

  it('turns a Bash description into a gerund phrase', () => {
    expect(activityLabel(toolUse('Bash', 't1', { description: 'Run tests' }))).toBe(
      'Running tests',
    );
    expect(activityLabel(toolUse('Bash', 't1', { description: 'Install dependencies' }))).toBe(
      'Installing dependencies',
    );
  });

  it('falls back to the command when a Bash call carries no description', () => {
    expect(activityLabel(toolUse('Bash', 't1', { command: 'pnpm test' }))).toBe(
      'Running pnpm test',
    );
    expect(activityLabel(toolUse('Bash', 't1', {}))).toBe('Running a command');
  });

  it('phrases search tools with their query', () => {
    expect(activityLabel(toolUse('Grep', 't1', { pattern: 'TODO' }))).toBe('Searching for "TODO"');
    expect(activityLabel(toolUse('Glob', 't1', { pattern: '**/*.ts' }))).toBe(
      'Finding files matching **/*.ts',
    );
    expect(activityLabel(toolUse('WebSearch', 't1', { query: 'fluent ui tokens' }))).toBe(
      'Searching the web for "fluent ui tokens"',
    );
  });

  it('names a sub-agent call the same way the folded chat row does', () => {
    expect(activityLabel(toolUse('Task', 't1', { description: 'audit the CSS' }))).toBe(
      'Running: audit the CSS',
    );
    expect(activityLabel(toolUse('Task', 't1', {}))).toBe('Running a sub-agent');
  });

  it('names thinking, and falls back to the raw tool name for anything unmapped', () => {
    expect(activityLabel({ kind: 'thinking', text: 'hmm' })).toBe('Thinking');
    expect(activityLabel(toolUse('SomeCustomTool', 't1'))).toBe('Using SomeCustomTool');
  });

  it('returns null for events that are not tool-use or thinking', () => {
    expect(activityLabel({ kind: 'assistant', text: 'done' })).toBeNull();
    expect(activityLabel(toolResult('t1'))).toBeNull();
  });
});
