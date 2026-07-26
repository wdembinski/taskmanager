import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_STEPS,
  extractPlanMarkdown,
  splitPlanIntoSteps,
} from './planToSubtasks';

describe('extractPlanMarkdown', () => {
  it('reads the CLI tool input shape', () => {
    expect(extractPlanMarkdown({ plan: '## Phase 1\nDo it' })).toBe('## Phase 1\nDo it');
  });

  it('accepts a bare string and near-miss keys', () => {
    expect(extractPlanMarkdown('  hello  ')).toBe('hello');
    expect(extractPlanMarkdown({ markdown: 'x' })).toBe('x');
    expect(extractPlanMarkdown({ content: 'y' })).toBe('y');
  });

  it('returns null when there is nothing usable', () => {
    expect(extractPlanMarkdown(undefined)).toBeNull();
    expect(extractPlanMarkdown({})).toBeNull();
    expect(extractPlanMarkdown({ plan: '   ' })).toBeNull();
    expect(extractPlanMarkdown({ plan: 42 })).toBeNull();
  });
});

describe('splitPlanIntoSteps', () => {
  it('splits on the shallowest heading level with two or more sections', () => {
    const steps = splitPlanIntoSteps(
      [
        '# Add keyboard shortcuts',
        '',
        '## Phase 1 — Key handling',
        'Wire a keydown listener.',
        '',
        '### Detail',
        'Ignore events from inputs.',
        '',
        '## Phase 2 — Docs',
        'Document the shortcuts.',
      ].join('\n'),
    );
    expect(steps.map((s) => s.title)).toEqual(['Key handling', 'Docs']);
    // A deeper heading stays inside its phase's brief rather than becoming a step.
    expect(steps[0].description).toContain('### Detail');
    expect(steps[0].description).toContain('Ignore events from inputs.');
    expect(steps[1].description).toBe('Document the shortcuts.');
  });

  it('descends past a lone top-level title', () => {
    const steps = splitPlanIntoSteps('# Plan\n\n## A\nfirst\n\n## B\nsecond');
    expect(steps.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('drops framing sections but keeps real work', () => {
    const steps = splitPlanIntoSteps(
      [
        '## Context',
        'Why we are doing this.',
        '## Approach',
        'Broad strokes.',
        '## Build the parser',
        'Write it.',
        '## Add tests',
        'Cover it.',
        '## Out of scope',
        'Not this.',
      ].join('\n'),
    );
    expect(steps.map((s) => s.title)).toEqual(['Build the parser', 'Add tests']);
  });

  it('strips ordinal prefixes and emphasis from titles', () => {
    const steps = splitPlanIntoSteps('## Phase 3: Ship it\nx\n\n## **Step 4 — Clean up**\ny');
    expect(steps.map((s) => s.title)).toEqual(['Ship it', 'Clean up']);
  });

  it('falls back to top-level list items, folding indented lines into the brief', () => {
    const steps = splitPlanIntoSteps(
      ['- [ ] Add the column', '  - migrate old rows', '  - backfill nulls', '- [ ] Wire the UI'].join(
        '\n',
      ),
    );
    expect(steps.map((s) => s.title)).toEqual(['Add the column', 'Wire the UI']);
    expect(steps[0].description).toBe('  - migrate old rows\n  - backfill nulls');
    expect(steps[1].description).toBe('');
  });

  it('handles a numbered list', () => {
    const steps = splitPlanIntoSteps('1. First thing\n2. Second thing');
    expect(steps.map((s) => s.title)).toEqual(['First thing', 'Second thing']);
  });

  it('degrades to a single step for an unstructured plan', () => {
    const steps = splitPlanIntoSteps('Just refactor the thing and move on.');
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('Just refactor the thing and move on.');
    expect(steps[0].description).toBe('Just refactor the thing and move on.');
  });

  it('degrades to a single step when only one work section exists', () => {
    const steps = splitPlanIntoSteps('# Title\n\n## Context\nframing\n\n## Do the work\nbody');
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('Title');
  });

  it('returns nothing for an empty plan', () => {
    expect(splitPlanIntoSteps('   \n  ')).toEqual([]);
  });

  it('caps runaway plans', () => {
    const plan = Array.from({ length: 40 }, (_, i) => `## Step ${i + 1}\nbody`).join('\n\n');
    expect(splitPlanIntoSteps(plan)).toHaveLength(MAX_PLAN_STEPS);
  });
});
