/**
 * Unit tests for the delegated-card prompt. It is pure, so the whole contract —
 * single-ticket focus, the ticket brief, the worktree rule, the never-write-to-JIRA
 * rule, and the question sentinel — is checkable without a process or a DB.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentTaskPrompt } from './agentTaskPrompt';
import { NEEDS_INPUT_SENTINEL } from './attention';
import type { Task } from '@shared/model';

const jiraTask = {
  id: 't1',
  projectId: 'personal',
  phase: '',
  title: 'Fix the export dialog',
  status: 'pending',
  sessionId: null,
  order: 0,
  source: 'jira',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'ABC-42',
  externalUrl: 'https://jira.example.com/browse/ABC-42',
  externalDescription: 'The export dialog closes without writing the file.',
  agentProjectId: 'agent-1',
} as Task;

const internalTask = {
  id: 't2',
  projectId: 'personal',
  phase: '',
  title: 'Tidy the release script',
  status: 'pending',
  sessionId: null,
  order: 1,
  source: 'adhoc',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  agentProjectId: 'agent-1',
} as Task;

describe('buildAgentTaskPrompt', () => {
  it('focuses the agent on one ticket and names the repo', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask);
    expect(prompt).toContain('Checkout service');
    expect(prompt).toContain('ONE ticket');
    expect(prompt).toContain('ABC-42 — Fix the export dialog');
    expect(prompt).toContain('https://jira.example.com/browse/ABC-42');
    expect(prompt).toContain('The export dialog closes without writing the file.');
  });

  it('never mentions a plan or a task queue (an agent project has neither)', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { branch: 'orch/abc' });
    expect(prompt).not.toContain('plan file');
    expect(prompt).toContain('there is none');
  });

  it('reuses the question sentinel verbatim so detection cannot drift', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask);
    expect(prompt).toContain(NEEDS_INPUT_SENTINEL);
  });

  it('lists the ticket comments in the order given, and the human’s notes', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      comments: [
        { author: 'Ada', body: 'Only on Windows.' },
        { author: 'Grace', body: 'Repro attached.' },
      ],
      notes: ['Start with the file-picker path.'],
    });
    expect(prompt).toContain('- Ada: Only on Windows.');
    expect(prompt).toContain('- Grace: Repro attached.');
    expect(prompt.indexOf('Ada')).toBeLessThan(prompt.indexOf('Grace'));
    expect(prompt).toContain('- Start with the file-picker path.');
  });

  it('drops empty comments/notes rather than emitting blank bullets', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      comments: [{ author: 'Ada', body: '   ' }],
      notes: ['', '  '],
    });
    expect(prompt).not.toContain('Comments on the ticket');
    expect(prompt).not.toContain('Notes from the human');
  });

  it('tells a worktree run to commit on its own branch', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { branch: 'orch/abc123' });
    expect(prompt).toContain('orch/abc123');
    expect(prompt).toContain('Commit your');
    expect(prompt).toContain('merges it back');
  });

  it('forbids writing back to the tracker for a linked ticket', () => {
    expect(buildAgentTaskPrompt('Checkout service', jiraTask)).toContain('Do NOT update ABC-42');
  });

  it('says nothing about a tracker for an internal task', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', internalTask);
    expect(prompt).toContain('Task: Tidy the release script');
    expect(prompt).not.toContain('tracker');
    expect(prompt).not.toContain('Link:');
  });

  it('hands over a previous failure on an AI-assisted retry', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      failureNote: 'the build broke',
    });
    expect(prompt).toContain('the build broke');
    expect(prompt).toContain('Diagnose why it failed');
  });

  it('never leaves a double blank line', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', internalTask, { branch: 'orch/x' });
    expect(prompt).not.toContain('\n\n\n');
  });
});
