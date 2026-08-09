import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_STEPS,
  extractPlanMarkdown,
  normalizeStepTitle,
  splitPlanIntoSteps,
  stepsToAppend,
  toSubtaskTitle,
} from './planToSubtasks';

/** A step, as `stepsToAppend` takes them. */
const step = (title: string, description = ''): { title: string; description: string } => ({
  title,
  description,
});

describe('toSubtaskTitle', () => {
  it('strips inline markdown and a trailing colon', () => {
    expect(toSubtaskTitle('**`Add auth`**:', '')).toBe('Add auth');
    expect(toSubtaskTitle('Read [the docs](https://x.dev)', '')).toBe('Read the docs');
  });

  it('strips an ordinal prefix', () => {
    expect(toSubtaskTitle('Phase 2 — Add auth', '')).toBe('Add auth');
    expect(toSubtaskTitle('3. Add auth', '')).toBe('Add auth');
    expect(toSubtaskTitle('Milestone B: Add auth', '')).toBe('Add auth');
  });

  it('strips filler that says nothing', () => {
    expect(toSubtaskTitle('Implementation of caching', '')).toBe('Caching');
    expect(toSubtaskTitle('Work on the parser', '')).toBe('The parser');
  });

  describe('falling back to the body when the heading is pure scaffolding', () => {
    // THE fix. `splitPlanIntoSteps` splits on `## Phase 1` / `## Phase 2` headings and
    // then used them as titles, so a well-structured plan named none of its steps.
    it.each(['Phase 2', 'Step 3', 'Part B', 'Section 4', 'Milestone', 'stage 1'])(
      'rescues %s from its body',
      (heading) => {
        expect(toSubtaskTitle(heading, '- Add the auth guard\n- and a test')).toBe(
          'Add the auth guard',
        );
      },
    );

    it('prefers a real heading over the body', () => {
      expect(toSubtaskTitle('Add the auth guard', '- something else entirely')).toBe(
        'Add the auth guard',
      );
    });

    it('does not mistake a heading that merely STARTS with a structural word', () => {
      expect(toSubtaskTitle('Phase out the legacy client', '')).toBe('Phase out the legacy client');
      expect(toSubtaskTitle('Step through the migration', '')).toBe('Step through the migration');
    });
  });

  it('sentence-cases the first letter only, so acronyms survive', () => {
    expect(toSubtaskTitle('add the JIRA API client', '')).toBe('Add the JIRA API client');
    expect(toSubtaskTitle('bump pnpm', '')).toBe('Bump pnpm');
  });

  it('truncates on a word boundary, not mid-word', () => {
    const long =
      'Add the authentication guard and wire it through every single one of the router paths ' +
      'before the release';
    const title = toSubtaskTitle(long, '');

    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    // The kept text is a whole-word prefix of the original: the character following it
    // upstream is a space, so no word was cut in half.
    const kept = title.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
  });

  it('leaves a title that already fits alone', () => {
    expect(toSubtaskTitle('Add the auth guard', '')).toBe('Add the auth guard');
  });

  it('keeps a terse heading rather than dropping the step it names', () => {
    // Losing a step to avoid an ugly title would lose the work it describes.
    expect(toSubtaskTitle('A', '')).toBe('A');
  });

  it('is empty only for genuinely empty input', () => {
    expect(toSubtaskTitle('', '')).toBe('Implement the plan');
    expect(toSubtaskTitle('   ', '')).toBe('Implement the plan');
  });
});

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

  it('names steps a bare-Phase plan left unnamed', () => {
    // A structurally perfect plan whose headings said nothing. It split correctly and then
    // produced a Steps list reading "Phase 1 / Phase 2", which named none of the work.
    const steps = splitPlanIntoSteps(
      [
        '## Phase 1',
        '- Add the auth guard to the router',
        '- and cover it with a test',
        '',
        '## Phase 2',
        'Wire the /auth/callback route.',
      ].join('\n'),
    );
    expect(steps.map((s) => s.title)).toEqual([
      'Add the auth guard to the router',
      'Wire the /auth/callback route.',
    ]);
  });

  it('de-duplicates repeated titles so the Steps list can be read', () => {
    // A plan that ends every phase with "### Update the tests" produced three identical
    // rows, with no way to tell which one the chain had reached.
    const steps = splitPlanIntoSteps(
      ['## Update the tests', 'a', '## Update the tests', 'b', '## Update the tests', 'c'].join(
        '\n',
      ),
    );
    expect(steps.map((s) => s.title)).toEqual([
      'Update the tests',
      'Update the tests (2)',
      'Update the tests (3)',
    ]);
  });

  it('falls back to top-level list items, folding indented lines into the brief', () => {
    const steps = splitPlanIntoSteps(
      [
        '- [ ] Add the column',
        '  - migrate old rows',
        '  - backfill nulls',
        '- [ ] Wire the UI',
      ].join('\n'),
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

  // The bound is a runaway guard, not a product rule: a plan that argued for thirty steps
  // was approved by a human, and thirty steps are what the card gets.
  it('keeps every step of a long plan', () => {
    const plan = Array.from({ length: 30 }, (_, i) => `## Wire panel ${i + 1}\nbody`).join('\n\n');
    const steps = splitPlanIntoSteps(plan);
    expect(steps).toHaveLength(30);
    expect(steps[29].title).toBe('Wire panel 30');
  });

  it('caps runaway plans', () => {
    const plan = Array.from(
      { length: MAX_PLAN_STEPS + 40 },
      (_, i) => `## Wire panel ${i + 1}\nbody`,
    ).join('\n\n');
    expect(splitPlanIntoSteps(plan)).toHaveLength(MAX_PLAN_STEPS);
  });
});

describe('normalizeStepTitle', () => {
  it('ignores case, markdown and trailing punctuation', () => {
    expect(normalizeStepTitle('**Wire the IPC**')).toBe(normalizeStepTitle('wire the ipc'));
    expect(normalizeStepTitle('Wire the IPC.')).toBe(normalizeStepTitle('Wire the IPC'));
    expect(normalizeStepTitle('Wire   the\tIPC')).toBe('wire the ipc');
  });

  // `finalize` disambiguates repeats WITHIN one plan by appending a counter, so a second
  // round re-proposing an existing step can arrive already wearing one.
  it('strips the (2) disambiguator, so a re-proposed step still matches', () => {
    expect(normalizeStepTitle('Update the tests (2)')).toBe(normalizeStepTitle('Update the tests'));
  });

  it('keeps a number that is part of the title', () => {
    expect(normalizeStepTitle('Migrate to v2')).toBe('migrate to v2');
  });
});

describe('stepsToAppend', () => {
  it('keeps everything when the card has no steps yet', () => {
    const fresh = stepsToAppend([], [step('Scaffold the store'), step('Wire the IPC')]);
    expect(fresh.map((s) => s.title)).toEqual(['Scaffold the store', 'Wire the IPC']);
  });

  it('drops steps the card already carries, in any casing', () => {
    const fresh = stepsToAppend(
      ['Scaffold the store', 'Wire the IPC'],
      [step('**wire the ipc**'), step('Add JIRA sync')],
    );
    expect(fresh.map((s) => s.title)).toEqual(['Add JIRA sync']);
  });

  it('drops a step the incoming plan repeats within itself', () => {
    const fresh = stepsToAppend([], [step('Add JIRA sync'), step('Add JIRA sync (2)')]);
    expect(fresh.map((s) => s.title)).toEqual(['Add JIRA sync']);
  });

  it('preserves plan order and each step brief', () => {
    const fresh = stepsToAppend([], [step('First', 'do this'), step('Second', 'then this')]);
    expect(fresh).toEqual([
      { title: 'First', description: 'do this' },
      { title: 'Second', description: 'then this' },
    ]);
  });

  // The cap is on the CARD, not the plan: counting per round would let a card re-planned
  // five times sail past the bound the cap exists to enforce.
  it('caps on the total, not on this round', () => {
    const existing = Array.from({ length: MAX_PLAN_STEPS - 2 }, (_, i) => `Old ${i + 1}`);
    const proposed = Array.from({ length: 5 }, (_, i) => step(`New ${i + 1}`));
    expect(stepsToAppend(existing, proposed).map((s) => s.title)).toEqual(['New 1', 'New 2']);
  });

  it('returns nothing when the card is already full', () => {
    const existing = Array.from({ length: MAX_PLAN_STEPS }, (_, i) => `Old ${i + 1}`);
    expect(stepsToAppend(existing, [step('New')])).toEqual([]);
  });

  it('returns nothing when every proposed step is a duplicate', () => {
    expect(stepsToAppend(['Wire the IPC'], [step('Wire the IPC')])).toEqual([]);
  });
});
