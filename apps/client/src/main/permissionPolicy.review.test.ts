/**
 * Unit tests for the review policy (F16.5): an unattended AI review may read and
 * run a handful of read-only git commands, and everything else is denied — never
 * held for a human, because nobody is watching.
 */
import { describe, expect, it } from 'vitest';
import { evaluateReviewToolUse, type PermissionDecision } from './permissionPolicy';

const ALLOWED_TOOLS = ['Read', 'grep', 'Glob'];

const ALLOWED_COMMANDS = [
  'git log',
  'git log --oneline -20',
  'git show HEAD~1:src/a.ts',
  'git diff abc...def -- src',
  'git blame -L 10,20 src/a.ts',
  '  git log  ',
];

const DENIED_COMMANDS = [
  'git checkout main',
  'git commit -m x',
  'git push',
  'git reset --hard',
  'git log; rm x',
  'git log && rm x',
  'git log | sh',
  'git log > out.txt',
  'git log `id`',
  'git log $(id)',
  'git log\nrm x',
  'git -c core.pager=sh log',
  'git -C /tmp log',
  'git diff --output=x',
  'git diff --ext-diff',
  'ls',
  'cat a.ts',
  '',
  'git',
];

const DENIED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'ExitPlanMode',
  'AskUserQuestion',
  'mcp__x__y',
  'SomeFutureTool',
];

function expectDenied(d: PermissionDecision): void {
  expect(d.action).toBe('deny');
  if (d.action === 'deny') expect(d.reason.trim()).not.toBe('');
}

describe('evaluateReviewToolUse — allows only reads and read-only git', () => {
  it.each(ALLOWED_TOOLS)('allows %s', (tool) => {
    expect(evaluateReviewToolUse(tool, { file_path: 'src/a.ts' })).toEqual({ action: 'allow' });
  });

  it.each(ALLOWED_COMMANDS)('allows Bash %j', (command) => {
    expect(evaluateReviewToolUse('Bash', { command })).toEqual({ action: 'allow' });
  });

  it('reads the command from cmd and script too', () => {
    expect(evaluateReviewToolUse('shell', { cmd: 'git log' })).toEqual({ action: 'allow' });
    expect(evaluateReviewToolUse('PowerShell', { script: 'git diff' })).toEqual({
      action: 'allow',
    });
  });
});

describe('evaluateReviewToolUse — denies everything else', () => {
  it.each(DENIED_COMMANDS)('denies Bash %j', (command) => {
    expectDenied(evaluateReviewToolUse('Bash', { command }));
  });

  it('denies a shell call with no command at all', () => {
    expectDenied(evaluateReviewToolUse('Bash', {}));
  });

  it('denies a multi-line command with a carriage return', () => {
    expectDenied(evaluateReviewToolUse('Bash', { command: 'git log\r\nrm x' }));
  });

  it.each(DENIED_TOOLS)('denies %s', (tool) => {
    const d = evaluateReviewToolUse(tool, { file_path: 'src/a.ts' });
    expectDenied(d);
    if (d.action === 'deny') expect(d.reason).toContain(tool);
  });
});

describe('evaluateReviewToolUse — never asks', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ...ALLOWED_TOOLS.map((tool): [string, Record<string, unknown>] => [tool, {}]),
    ...DENIED_TOOLS.map((tool): [string, Record<string, unknown>] => [tool, {}]),
    ...[...ALLOWED_COMMANDS, ...DENIED_COMMANDS].map(
      (command): [string, Record<string, unknown>] => ['Bash', { command }],
    ),
  ];

  it('returns allow or deny for every case, and every deny has a reason', () => {
    for (const [tool, input] of cases) {
      const d = evaluateReviewToolUse(tool, input);
      expect(['allow', 'deny']).toContain(d.action);
      if (d.action !== 'allow') expectDenied(d);
    }
  });
});
