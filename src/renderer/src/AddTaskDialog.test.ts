/**
 * What Add actually writes, worked out from the form alone (`addTaskPlan`).
 *
 * The rule under test is that the dialog's three questions compose: filing a card under a
 * project, giving it a description and raising a JIRA ticket for it are separate answers,
 * and asking for one must never quietly drop the others. The ticket in particular is an
 * ADDITION to the card — it used to replace it, which is how a card created "in JIRA"
 * ended up with no project and no description of its own.
 */
import { describe, expect, it } from 'vitest';
import { addTaskPlan, type AddTaskForm } from './AddTaskDialog';

const form = (over: Partial<AddTaskForm> = {}): AddTaskForm => ({
  title: 'Ship the thing',
  description: '',
  type: 'feature',
  phase: '',
  projectTagId: '',
  parentId: '',
  asJira: false,
  jiraProjectKey: '',
  jiraTypeId: '',
  ...over,
});

describe('addTaskPlan', () => {
  it('says nothing while the title is empty — the disabled button already does', () => {
    expect(addTaskPlan(form({ title: '   ' }))).toEqual({ kind: 'incomplete', error: null });
  });

  it('carries the project, the description and the type onto the card', () => {
    const plan = addTaskPlan(
      form({
        title: '  Ship the thing  ',
        description: '  Two paragraphs of context.  ',
        projectTagId: 'p-billing',
        type: 'bug',
        phase: ' Phase 1 ',
      }),
    );
    expect(plan).toEqual({
      kind: 'card',
      card: {
        title: 'Ship the thing',
        phase: 'Phase 1',
        type: 'bug',
        description: 'Two paragraphs of context.',
        projectTagId: 'p-billing',
      },
      ticket: null,
    });
  });

  it('files nothing when no project was picked', () => {
    const plan = addTaskPlan(form());
    expect(plan.kind === 'card' && plan.card.projectTagId).toBe(null);
    expect(plan.kind === 'card' && plan.card.description).toBeUndefined();
  });

  it('adds a ticket to the card rather than replacing it', () => {
    const plan = addTaskPlan(
      form({
        description: 'What it is about.',
        projectTagId: 'p-billing',
        asJira: true,
        jiraProjectKey: 'ABC',
        jiraTypeId: '10001',
      }),
    );
    expect(plan.kind).toBe('card');
    if (plan.kind !== 'card') return;
    // The card keeps everything it would have had without the switch…
    expect(plan.card.projectTagId).toBe('p-billing');
    expect(plan.card.description).toBe('What it is about.');
    // …and the ticket says the same thing in JIRA's words.
    expect(plan.ticket).toEqual({
      projectKey: 'ABC',
      issueTypeId: '10001',
      summary: 'Ship the thing',
      description: 'What it is about.',
    });
  });

  it('refuses a ticket the instance cannot place, before the card is written', () => {
    expect(addTaskPlan(form({ asJira: true, jiraProjectKey: 'ABC' }))).toEqual({
      kind: 'incomplete',
      error: 'Pick a JIRA project and issue type first.',
    });
    expect(addTaskPlan(form({ asJira: true, jiraTypeId: '10001' }))).toEqual({
      kind: 'incomplete',
      error: 'Pick a JIRA project and issue type first.',
    });
  });

  it('makes a step of a card, with its brief and nothing else', () => {
    const plan = addTaskPlan(
      form({
        parentId: 'c1',
        description: 'Deliver the migration.',
        // Everything a step does not get, set anyway.
        projectTagId: 'p-billing',
        asJira: true,
        jiraProjectKey: 'ABC',
        jiraTypeId: '10001',
      }),
    );
    expect(plan).toEqual({
      kind: 'step',
      parentId: 'c1',
      step: { title: 'Ship the thing', description: 'Deliver the migration.' },
    });
  });

  it('gives a brief-less step a null brief, not an empty one', () => {
    const plan = addTaskPlan(form({ parentId: 'c1', description: '  ' }));
    expect(plan.kind === 'step' && plan.step.description).toBe(null);
  });
});
