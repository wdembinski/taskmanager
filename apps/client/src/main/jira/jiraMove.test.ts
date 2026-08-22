import { describe, expect, it } from 'vitest';
import { pickTransition, shouldLearnStatus } from './jiraMove';
import type { JiraTransition } from './jiraClient';

// `resolveMove` itself is tested in `@shared/moveResolve.test.ts` now that it lives there
// (Phase 25 — cloud web independence); this file re-exports it, so its own tests are
// covering the same function under the same name.

const T = (id: string, name: string, categoryKey: string): JiraTransition => ({
  id,
  name,
  to: { name, statusCategory: { key: categoryKey, name } },
});

/** A transition whose BUTTON is named one thing and whose destination status another. */
const TX = (id: string, name: string, toName: string, categoryKey: string): JiraTransition => ({
  id,
  name,
  to: { name: toName, statusCategory: { key: categoryKey, name: toName } },
});

describe('pickTransition', () => {
  const transitions = [T('11', 'Start Progress', 'indeterminate'), T('31', 'Resolve', 'done')];

  it('matches In Progress by destination category', () => {
    expect(pickTransition(transitions, 'toInProgress', {})?.transition.id).toBe('11');
  });
  it('matches Done by destination category', () => {
    expect(pickTransition(transitions, 'toDone', {})?.transition.id).toBe('31');
  });
  it('honors an exact-name override', () => {
    const withExtra = [...transitions, T('99', 'Kickoff', 'indeterminate')];
    expect(
      pickTransition(withExtra, 'toInProgress', { inProgressTransitionName: 'Kickoff' })?.transition
        .id,
    ).toBe('99');
  });
  it('returns null when no transition fits', () => {
    expect(pickTransition([T('5', 'Close', 'done')], 'toInProgress', {})).toBeNull();
  });

  // In Review lives in the same `indeterminate` category as In Progress, so the map
  // (or the name) is the only thing that can tell the two apart.
  describe('In Review', () => {
    const workflow = [
      T('11', 'Start Progress', 'indeterminate'),
      T('21', 'Code Review', 'indeterminate'),
      T('31', 'Resolve', 'done'),
    ];
    const map = { statusCategoryOverrides: { 'code review': 'in-review' as const } };

    it('picks the transition whose destination the user mapped to In Review', () => {
      expect(pickTransition(workflow, 'toInReview', map)?.transition.id).toBe('21');
    });

    it('matches the map case-insensitively', () => {
      const upper = { statusCategoryOverrides: { 'CODE REVIEW': 'in-review' as const } };
      expect(pickTransition(workflow, 'toInReview', upper)?.transition.id).toBe('21');
    });

    it('falls back to an indeterminate transition named "…review…" with no map', () => {
      expect(pickTransition(workflow, 'toInReview', {})?.transition.id).toBe('21');
    });

    it('prefers an exact-name override over the map', () => {
      const withExtra = [...workflow, T('99', 'Hand off', 'indeterminate')];
      expect(
        pickTransition(withExtra, 'toInReview', { ...map, inReviewTransitionName: 'Hand off' })
          ?.transition.id,
      ).toBe('99');
    });

    it('returns null when the workflow has no review step', () => {
      expect(
        pickTransition([T('11', 'Start Progress', 'indeterminate')], 'toInReview', {}),
      ).toBeNull();
    });

    // The regression that motivated the map: "Code Review" comes first in this
    // workflow, so a bare category match would send an IN PROGRESS drag to review.
    it('In Progress never grabs a transition mapped to In Review', () => {
      const reviewFirst = [
        T('21', 'Code Review', 'indeterminate'),
        T('11', 'Start Progress', 'indeterminate'),
      ];
      expect(pickTransition(reviewFirst, 'toInProgress', map)?.transition.id).toBe('11');
    });

    it('In Progress still matches by category when nothing is mapped', () => {
      expect(pickTransition(workflow, 'toInProgress', {})?.transition.id).toBe('11');
    });

    it('picks a transition whose destination we learned from an earlier drag', () => {
      const qaWorkflow = [
        T('11', 'Start Progress', 'indeterminate'),
        T('41', 'QA', 'indeterminate'),
      ];
      expect(
        pickTransition(qaWorkflow, 'toInReview', { learnedStatusColumns: { QA: 'in-review' } })
          ?.transition.id,
      ).toBe('41');
    });

    it('prefers the user map over what was learned', () => {
      const both = [T('21', 'Code Review', 'indeterminate'), T('41', 'QA', 'indeterminate')];
      expect(
        pickTransition(both, 'toInReview', {
          statusCategoryOverrides: { QA: 'in-review' },
          learnedStatusColumns: { 'Code Review': 'in-review' },
        })?.transition.id,
      ).toBe('41');
    });
  });

  // Tier by tier, not first-match-wins down the transition list: a workflow returns its
  // transitions in whatever order it declares them, so scanning once would let a
  // category guess listed first beat the status the user explicitly mapped.
  it('takes an explicitly mapped destination over one that only matches by category', () => {
    const workflow = [T('11', 'Ship It', 'done'), T('12', 'Sign Off', 'done')];
    expect(
      pickTransition(workflow, 'toDone', { statusCategoryOverrides: { 'Sign Off': 'done' } })
        ?.transition.id,
    ).toBe('12');
  });

  /**
   * The reported bug: "When I move a task to INPROGRESS, in the JIRA it moves to BLOCKED".
   *
   * Both of these transitions land in JIRA's `indeterminate` category, so both used to
   * match an IN PROGRESS drag equally — and the workflow declares "Block" first, so the
   * scan took it. Nothing about the tier was wrong; the tie-break was the workflow's own
   * declaration order, which knows nothing about what the user dragged.
   */
  describe('a workflow that declares Block first', () => {
    const workflow = [
      TX('61', 'Block', 'Blocked', 'indeterminate'),
      TX('11', 'Start Progress', 'In Progress', 'indeterminate'),
    ];

    it('moves to In Progress, not Blocked', () => {
      expect(pickTransition(workflow, 'toInProgress', {})?.transition.id).toBe('11');
    });

    it('is unmoved by a To-Do-category Blocked', () => {
      const todoWorkflow = [
        TX('61', 'Block', 'Blocked', 'new'),
        TX('1', 'Back to To Do', 'To Do', 'new'),
      ];
      expect(pickTransition(todoWorkflow, 'toTodo', {})?.transition.id).toBe('1');
    });

    // Every installation that hit the bug is carrying `{"Blocked": "in-progress"}`,
    // written by the drag that went wrong. The resolver refuses to read it back.
    it('is unmoved by a learned map poisoned by the bug itself', () => {
      expect(
        pickTransition(workflow, 'toInProgress', {
          learnedStatusColumns: { Blocked: 'in-progress' },
        })?.transition.id,
      ).toBe('11');
    });

    // The user typed it into Settings, so it is not a guess to be second-guessed.
    it('lets an explicit map say Blocked means In Progress', () => {
      expect(
        pickTransition(workflow, 'toInProgress', {
          statusCategoryOverrides: { Blocked: 'in-progress' },
        })?.transition.id,
      ).toBe('61');
    });

    it('lets an exact transition name say so too, and reports the mismatch', () => {
      expect(
        pickTransition(workflow, 'toInProgress', { inProgressTransitionName: 'Block' }),
      ).toMatchObject({
        transition: { id: '61' },
        via: 'name',
        destinationColumn: 'blocked',
        mismatch: true,
      });
    });

    it('reports no mismatch when the named transition lands where it should', () => {
      expect(
        pickTransition(workflow, 'toInProgress', { inProgressTransitionName: 'Start Progress' }),
      ).toMatchObject({ transition: { id: '11' }, via: 'name', mismatch: false });
    });
  });

  // Within a tier every match is equally justified, so SOMETHING has to break the tie —
  // and a destination named after the column beats whichever one the workflow happened
  // to declare first.
  describe('the label tie-break', () => {
    const doing = TX('41', 'Work on it', 'Doing', 'indeterminate');
    const inProgress = TX('11', 'Start Progress', 'In Progress', 'indeterminate');

    it('prefers the destination literally named after the column', () => {
      expect(pickTransition([doing, inProgress], 'toInProgress', {})?.transition.id).toBe('11');
    });

    it('prefers it whichever order the workflow declares them in', () => {
      expect(pickTransition([inProgress, doing], 'toInProgress', {})?.transition.id).toBe('11');
    });

    it('falls back to declaration order when nothing is named after the column', () => {
      const neither = [doing, TX('42', 'Pick up', 'Active', 'indeterminate')];
      expect(pickTransition(neither, 'toInProgress', {})?.transition.id).toBe('41');
    });
  });

  // The other direction of the same tie the workflow above lost: a drag into BLOCKED must
  // reach the step that used to be taken only by accident.
  describe('Blocked', () => {
    const workflow = [
      TX('11', 'Start Progress', 'In Progress', 'indeterminate'),
      TX('61', 'Block', 'Blocked', 'indeterminate'),
    ];

    it('finds the blocked-ish destination', () => {
      expect(pickTransition(workflow, 'toBlocked', {})).toMatchObject({
        transition: { id: '61' },
        via: 'heuristic',
        destinationColumn: 'blocked',
        mismatch: false,
      });
    });

    // The one target allowed to come back empty: plenty of workflows have no way to say
    // "stuck", and the caller blocks the card locally rather than refusing the drag.
    it('returns null when the workflow has no blocked step', () => {
      const plain = [T('11', 'Start Progress', 'indeterminate'), T('31', 'Resolve', 'done')];
      expect(pickTransition(plain, 'toBlocked', {})).toBeNull();
    });

    // A workflow whose blocked step is named nothing like "blocked" is exactly what the
    // name box is for — an "On Hold"-ish destination the heuristic cannot see.
    it('honours blockedTransitionName', () => {
      const custom = [
        TX('11', 'Start Progress', 'In Progress', 'indeterminate'),
        TX('71', 'Send to triage', 'Triage', 'new'),
      ];
      expect(
        pickTransition(custom, 'toBlocked', { blockedTransitionName: 'Send to triage' }),
      ).toMatchObject({ transition: { id: '71' }, via: 'name', destinationColumn: 'todo' });
    });

    it('takes the named transition over the one the heuristic would have found', () => {
      expect(
        pickTransition(workflow, 'toBlocked', { blockedTransitionName: 'Start Progress' }),
      ).toMatchObject({ transition: { id: '11' }, via: 'name', mismatch: true });
    });

    it('lets the user map say which status means blocked', () => {
      const custom = [
        TX('11', 'Start Progress', 'In Progress', 'indeterminate'),
        TX('71', 'Send to triage', 'Triage', 'new'),
      ];
      expect(
        pickTransition(custom, 'toBlocked', { statusCategoryOverrides: { Triage: 'blocked' } }),
      ).toMatchObject({ transition: { id: '71' }, via: 'explicit', destinationColumn: 'blocked' });
    });
  });

  // "Waiting" is a blocked-ish word, but review wins over blocked — and In Review exists
  // precisely so this transition is reachable.
  it('still reaches "Waiting for review" for In Review', () => {
    const workflow = [
      TX('61', 'Block', 'Blocked', 'indeterminate'),
      TX('21', 'Hand off', 'Waiting for review', 'indeterminate'),
    ];
    expect(pickTransition(workflow, 'toInReview', {})).toMatchObject({
      transition: { id: '21' },
      via: 'heuristic',
      destinationColumn: 'in-review',
      mismatch: false,
    });
  });
});

describe('shouldLearnStatus', () => {
  it('learns a status whose column we could not otherwise have known', () => {
    expect(shouldLearnStatus('QA', 'In Progress', 'in-review', {})).toBe(true);
  });

  it('says nothing about a blank name', () => {
    expect(shouldLearnStatus('   ', 'In Progress', 'in-review', {})).toBe(false);
  });

  it('never overwrites what the user mapped in Settings', () => {
    expect(
      shouldLearnStatus('QA', 'In Progress', 'in-review', {
        statusCategoryOverrides: { QA: 'done' },
      }),
    ).toBe(false);
  });

  // Also why the reported bug never poisoned anyone's map before this branch: "Blocked"
  // sits in JIRA's In Progress category, so a drag to IN PROGRESS found the status
  // already resolving there and wrote nothing. The bug was in the picking, not the map.
  it('writes no entry for a status that already resolves to that column', () => {
    expect(shouldLearnStatus('In Development', 'In Progress', 'in-progress', {})).toBe(false);
  });

  // The one destination the picker can most easily reach by accident — and an entry
  // reading "Blocked means IN REVIEW" would then be shown to the user as a learned fact.
  it('refuses to learn anything from a blocked-ish destination', () => {
    expect(shouldLearnStatus('Blocked', 'In Progress', 'in-review', {})).toBe(false);
    expect(shouldLearnStatus('On hold', 'To Do', 'in-progress', {})).toBe(false);
  });
});
