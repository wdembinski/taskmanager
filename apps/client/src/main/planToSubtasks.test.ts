import { describe, expect, it } from 'vitest';
import { checkPlan } from '@shared/planCheck';
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

  describe('framing headings the exact list missed', () => {
    // Every one of these became a step on a real card (TM-207, TM-227, TM-177, TM-149,
    // TM-173, TM-140) and ran a whole session that had nothing to build. TM-207's "Critical
    // files" step then found the card's mockups and asked whether to build two other
    // tickets' screens; TM-227's "Out of scope" step sat pending, waiting to do the very
    // work it said was out of scope.
    it.each([
      'Critical files',
      'Key files',
      'Facts checked',
      'Facts already checked',
      'Decisions taken without asking (flag if wrong)',
      'Decisions taken without the human',
      'Decisions taken',
      'Research findings the new steps rely on',
      'Out of scope (other F15 steps)',
      'Step 8 (renumbered from the original step 5) — Out of scope (other F15 steps)',
      '**Open questions**',
    ])('does not make a step of "%s"', (heading) => {
      const steps = splitPlanIntoSteps(
        [`## ${heading}`, '- some context', '## Build the parser', 'x', '## Add tests', 'y'].join(
          '\n',
        ),
      );
      expect(steps.map((s) => s.title)).toEqual(['Build the parser', 'Add tests']);
    });

    it.each([
      'Design',
      'Verification (end to end)',
      'Background sync worker',
      'Contextual menu for cards',
      'Decide the layout toggle',
      'Fact-check the glossary',
    ])('keeps "%s", which names work', (heading) => {
      const steps = splitPlanIntoSteps([`## ${heading}`, 'x', '## Add tests', 'y'].join('\n'));
      expect(steps.map((s) => s.title)).toContain(heading);
    });

    it("splits TM-227's plan into only the steps that build something", () => {
      // The shape of the real F15.12 plan: four of its six sections were framing.
      const steps = splitPlanIntoSteps(
        [
          '# F15.12 — Add the side-by-side layout to DiffView',
          '## Context',
          'Why.',
          '## Facts checked',
          '- splitRows exists',
          '## Design',
          'The contract.',
          '## Add the split-row comment mapping helpers to reviewView',
          'TDD.',
          '## Verification (end to end)',
          'Run the gates.',
          '## Out of scope (other F15 steps)',
          'F15.11, F15.13, F15.14.',
        ].join('\n'),
      );
      expect(steps.map((s) => s.title)).toEqual([
        'Design',
        'Add the split-row comment mapping helpers to reviewView',
        'Verification (end to end)',
      ]);
    });
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
    // The work section names the step; the framing rides along in its brief.
    expect(steps[0].title).toBe('Do the work');
    expect(steps[0].description).toContain('framing');
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

  describe('one work section beside framing', () => {
    // TM-459's approved plan: Context, Out of scope, and ONE work section. Fewer than two
    // work sections fell through to the list split, which made a step of every bullet in
    // the whole plan — 17 of them, Context facts and Out-of-scope items included.
    const tm459 = [
      '# Stop the phone tab bar truncating its labels',
      '## Context',
      'At 390px the active label is clipped to "Inb".',
      '- Each tile is 78px (5 tabs).',
      '- The attention marker is a small orange dot.',
      '## Out of scope',
      '- The large Inbox title: that is F23.6 (TM-358).',
      '- The final tab set: that is F23.5 (TM-357).',
      "## Fix the phone tab bar's stacked layout",
      '1. **Stack the grid instead of flexing it.** Replace flexDirection.',
      '2. **Put the label on row 2.**',
      '### Verification',
      '- Run the gates.',
    ].join('\n');

    it('is one step, not one step per bullet', () => {
      const steps = splitPlanIntoSteps(tm459);
      expect(steps.map((s) => s.title)).toEqual(["Fix the phone tab bar's stacked layout"]);
      expect(steps[0].description).toContain('Put the label on row 2');
      expect(steps[0].description).toContain('### Verification');
    });

    it('still splits a framing-free single section by its list', () => {
      const steps = splitPlanIntoSteps(['# Title', '1. Do a', '2. Do b'].join('\n'));
      expect(steps.map((s) => s.title)).toEqual(['Do a', 'Do b']);
    });
  });

  describe('framing text reaches every step', () => {
    // A step's prompt carries only its own brief. TM-460's first step was told to
    // "implement the Decisions above" and never saw them, because Decisions is framing.
    const plan = [
      '# Plan',
      '## Context',
      'The watcher rebased under a live step.',
      '## Decisions',
      '- One helper: worktreeBusy(ownerId).',
      '## Fix the busy check',
      'Implement the Decisions above.',
      '## Verify it',
      'Prove the test can fail.',
      '## Out of scope',
      '- The stale-rebase abort.',
    ].join('\n');

    it('appends the framing sections to each work step', () => {
      const steps = splitPlanIntoSteps(plan);
      expect(steps.map((s) => s.title)).toEqual(['Fix the busy check', 'Verify it']);
      for (const step of steps) {
        expect(step.description).toContain('One helper: worktreeBusy(ownerId).');
        expect(step.description).toContain('## Context');
        expect(step.description).toContain('## Out of scope');
      }
      expect(steps[0].description.startsWith('Implement the Decisions above.')).toBe(true);
    });

    it('leaves a framing-free plan untouched', () => {
      const steps = splitPlanIntoSteps('## Build it\nbody one\n\n## Test it\nbody two');
      expect(steps.map((s) => s.description)).toEqual(['body one', 'body two']);
    });

    it('caps the shared text', () => {
      const huge = `## Context\n${'x'.repeat(20_000)}\n## Do a\na\n## Do b\nb`;
      const [first] = splitPlanIntoSteps(huge);
      expect(first.description.length).toBeLessThan(9_000);
      expect(first.description).toContain('framing was cut');
    });
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

describe('splitPlanIntoSteps feeding checkPlan', () => {
  const CLEAN_PLAN = [
    '# Add request retries',
    '',
    '## Context',
    '',
    'The sync client drops a request on first failure; this adds a bounded retry.',
    '',
    '## Critical files',
    '',
    '- src/main/syncClient.ts',
    '- src/main/syncClient.test.ts',
    '',
    '## Open questions',
    '',
    '- None',
    '',
    '## Add the retry loop',
    '',
    'Wrap the fetch call in a bounded retry with backoff.',
    '',
    '**Acceptance:** `pnpm --filter client test -- syncClient` passes.',
    '',
    '## Cover it with a test',
    '',
    'Add a test that forces two failures then a success.',
    '',
    '**Acceptance:** the new test fails before the fix and passes after.',
  ].join('\n');

  it('passes every check on a realistic clean plan', () => {
    const steps = splitPlanIntoSteps(CLEAN_PLAN);
    const verdict = checkPlan({
      plan: CLEAN_PLAN,
      steps,
      maxSteps: MAX_PLAN_STEPS,
      ticketText: null,
      activeCards: [],
    });
    expect(verdict.pass).toBe(true);
  });
});
