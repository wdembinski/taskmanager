import { describe, expect, it } from 'vitest';
import {
  checkPlan,
  NEEDS_INPUT_SENTINEL,
  parseCriticalFiles,
  SHARED_CONTEXT_MARKER,
  type PlanCheckInput,
} from './planCheck';

const BASE_PLAN = [
  '## Critical files',
  '',
  '- src/a.ts',
  '- src/b.ts',
  '',
  '## Step one',
  '',
  'Do the thing.',
  '',
  'Acceptance: pnpm test passes.',
].join('\n');

const BASE_INPUT: PlanCheckInput = {
  plan: BASE_PLAN,
  steps: [{ title: 'Step one', description: 'Do the thing.\n\nAcceptance: pnpm test passes.' }],
  maxSteps: 6,
  ticketText: null,
  activeCards: [],
};

describe('parseCriticalFiles', () => {
  it('returns null when there is no section', () => {
    expect(parseCriticalFiles('## Step one\n\nDo the thing.')).toBeNull();
  });

  it('returns an empty array when the section lists no files', () => {
    expect(parseCriticalFiles('## Critical files\n\nnone\n\n## Step one\n\nx')).toEqual([]);
  });

  it('parses bullet, backtick and annotated lines', () => {
    const plan = [
      '## Critical files',
      '',
      '- `src/a.ts`',
      '- src/b.ts — edited for the new flag',
      '- src/c.ts (new file)',
      '- src/d.ts: the handler',
      '',
      '## Step one',
    ].join('\n');
    expect(parseCriticalFiles(plan)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('normalizes backslashes, a leading ./ and case, and dedupes', () => {
    const plan = ['## Critical files', '', '- .\\Src\\A.TS', '- src/a.ts', ''].join('\n');
    expect(parseCriticalFiles(plan)).toEqual(['src/a.ts']);
  });

  it('stops at the next heading of the same or a shallower level', () => {
    const plan = [
      '# Critical files',
      '',
      '- src/a.ts',
      '',
      '# Step one',
      '',
      '- src/not-a-file',
    ].join('\n');
    expect(parseCriticalFiles(plan)).toEqual(['src/a.ts']);
  });

  it('ignores tokens with no path separator or extension', () => {
    const plan = ['## Critical files', '', '- nothing much here', ''].join('\n');
    expect(parseCriticalFiles(plan)).toEqual([]);
  });
});

describe('checkPlan: open-questions', () => {
  it('passes a plan with no open questions section and no sentinel', () => {
    const verdict = checkPlan(BASE_INPUT);
    const check = verdict.checks.find((c) => c.id === 'open-questions')!;
    expect(check.pass).toBe(true);
  });

  it('fails when the plan contains the needs-input sentinel', () => {
    const input = { ...BASE_INPUT, plan: `${BASE_PLAN}\n\n${NEEDS_INPUT_SENTINEL} which db?` };
    const check = checkPlan(input).checks.find((c) => c.id === 'open-questions')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain(NEEDS_INPUT_SENTINEL);
  });

  it('passes when the Open questions section only lists allowed placeholders', () => {
    const plan = `${BASE_PLAN}\n\n## Open questions\n\n- none`;
    const check = checkPlan({ ...BASE_INPUT, plan }).checks.find((c) => c.id === 'open-questions')!;
    expect(check.pass).toBe(true);
  });

  it('fails when the Open questions section lists a real question', () => {
    const plan = `${BASE_PLAN}\n\n## Open questions\n\n- which database should we use?`;
    const check = checkPlan({ ...BASE_INPUT, plan }).checks.find((c) => c.id === 'open-questions')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('which database should we use');
  });

  it('fails when needsDecision is true', () => {
    const check = checkPlan({ ...BASE_INPUT, needsDecision: true }).checks.find(
      (c) => c.id === 'open-questions',
    )!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('needsDecision');
  });
});

describe('checkPlan: critical-files', () => {
  it('fails with no Critical files section', () => {
    const check = checkPlan({ ...BASE_INPUT, plan: '## Step one\n\nx' }).checks.find(
      (c) => c.id === 'critical-files',
    )!;
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('no Critical files section');
  });

  it('fails when the section lists no files', () => {
    const plan = '## Critical files\n\nnone\n\n## Step one\n\nx';
    const check = checkPlan({ ...BASE_INPUT, plan }).checks.find((c) => c.id === 'critical-files')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('the Critical files section lists no files');
  });

  it('fails when a file overlaps an active card, naming the card and files', () => {
    const input: PlanCheckInput = {
      ...BASE_INPUT,
      activeCards: [{ title: 'Other card', why: 'running', files: ['src/a.ts', 'src/z.ts'] }],
    };
    const check = checkPlan(input).checks.find((c) => c.id === 'critical-files')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('overlaps "Other card" (running): src/a.ts');
  });

  it('passes when no active card overlaps', () => {
    const input: PlanCheckInput = {
      ...BASE_INPUT,
      activeCards: [{ title: 'Other card', why: 'planning', files: ['src/z.ts'] }],
    };
    const check = checkPlan(input).checks.find((c) => c.id === 'critical-files')!;
    expect(check.pass).toBe(true);
  });
});

describe('checkPlan: step-count', () => {
  it('passes at the limit and fails over it', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({ title: `s${i}`, description: 'x' }));
    const atLimit = checkPlan({ ...BASE_INPUT, steps, maxSteps: 6 }).checks.find(
      (c) => c.id === 'step-count',
    )!;
    expect(atLimit.pass).toBe(true);

    const overLimit = checkPlan({
      ...BASE_INPUT,
      steps: [...steps, { title: 's6', description: 'x' }],
      maxSteps: 6,
    }).checks.find((c) => c.id === 'step-count')!;
    expect(overLimit.pass).toBe(false);
    expect(overLimit.detail).toBe('7 steps, the limit is 6');
  });
});

describe('checkPlan: spec-read', () => {
  it('passes when the ticket names no spec', () => {
    const check = checkPlan({ ...BASE_INPUT, ticketText: 'Just do the thing.' }).checks.find(
      (c) => c.id === 'spec-read',
    )!;
    expect(check.pass).toBe(true);
    expect(check.detail).toBe('the ticket names no spec');
  });

  it('passes when the plan quotes the spec with a blockquote', () => {
    const plan = `${BASE_PLAN}\n\n> from docs/foo.md`;
    const check = checkPlan({
      ...BASE_INPUT,
      plan,
      ticketText: 'See docs/foo.md for details.',
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(true);
  });

  it('passes when the plan mentions the md basename', () => {
    const check = checkPlan({
      ...BASE_INPUT,
      ticketText: 'See docs/foo-bar.md for details.',
      plan: `${BASE_PLAN}\n\nThis follows foo-bar closely.`,
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(true);
  });

  it('passes when the plan mentions a referenced anchor as words', () => {
    const check = checkPlan({
      ...BASE_INPUT,
      ticketText: 'See docs/foo.md#some-anchor.',
      plan: `${BASE_PLAN}\n\nWe follow the some anchor section.`,
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(true);
  });

  it('passes when the plan mentions a referenced section token', () => {
    const check = checkPlan({
      ...BASE_INPUT,
      ticketText: 'Follow §3.2 of the spec.',
      plan: `${BASE_PLAN}\n\nImplemented per §3.2.`,
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(true);
  });

  it('fails and names the first unmentioned reference', () => {
    const check = checkPlan({
      ...BASE_INPUT,
      ticketText: 'See docs/foo.md and §3.2.',
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('docs/foo.md');
  });

  it('passes when the plan mentions the Plan: line value', () => {
    const check = checkPlan({
      ...BASE_INPUT,
      ticketText: 'Plan: the rollout plan',
      plan: `${BASE_PLAN}\n\nFollowing the rollout plan exactly.`,
    }).checks.find((c) => c.id === 'spec-read')!;
    expect(check.pass).toBe(true);
  });
});

describe('checkPlan: acceptance', () => {
  it('passes a step with an Acceptance line', () => {
    const check = checkPlan(BASE_INPUT).checks.find((c) => c.id === 'acceptance')!;
    expect(check.pass).toBe(true);
  });

  it('fails a step with no acceptance line', () => {
    const input = { ...BASE_INPUT, steps: [{ title: 'Step one', description: 'Do the thing.' }] };
    const check = checkPlan(input).checks.find((c) => c.id === 'acceptance')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('Step one');
  });

  it('fails a step that relies on a human check', () => {
    const input = {
      ...BASE_INPUT,
      steps: [
        {
          title: 'Step one',
          description: 'Do the thing.\n\nAcceptance: the reviewer checks it looks right.',
        },
      ],
    };
    const check = checkPlan(input).checks.find((c) => c.id === 'acceptance')!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('human check');
  });

  it('does not flag a human-check phrase sitting inside quotes', () => {
    const input = {
      ...BASE_INPUT,
      steps: [
        {
          title: 'Step one',
          description:
            'Do the thing.\n\nAcceptance: the sentinel is never "the reviewer checks" verbatim.',
        },
      ],
    };
    const check = checkPlan(input).checks.find((c) => c.id === 'acceptance')!;
    expect(check.pass).toBe(true);
  });

  it('only looks at a step text before the shared context marker', () => {
    const input = {
      ...BASE_INPUT,
      steps: [
        {
          title: 'Step one',
          description: `Do the thing.\n\n${SHARED_CONTEXT_MARKER}\n\nAcceptance: this belongs to another step.`,
        },
      ],
    };
    const check = checkPlan(input).checks.find((c) => c.id === 'acceptance')!;
    expect(check.pass).toBe(false);
  });
});

describe('checkPlan: overall verdict', () => {
  it('passes only when every check passes', () => {
    expect(checkPlan(BASE_INPUT).pass).toBe(true);
    expect(checkPlan({ ...BASE_INPUT, needsDecision: true }).pass).toBe(false);
  });

  it('reports all five checks in order', () => {
    const verdict = checkPlan(BASE_INPUT);
    expect(verdict.checks.map((c) => c.id)).toEqual([
      'open-questions',
      'critical-files',
      'step-count',
      'spec-read',
      'acceptance',
    ]);
  });
});
