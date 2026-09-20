/**
 * What Add actually writes, worked out from the form alone (`addTaskPlan`), and what it
 * holds on to until there is somewhere to write it (`stageAttachments`).
 *
 * The rule under test is that the merged "Project / Board" picker answers two questions at
 * once — where the card lives and what it's filed under — by routing on one capability,
 * `boardOwnsTickets`: a project that owns tickets gets a native one (`ticket:create`);
 * Personal or a keyless project gets an ordinary card (`task:create`), tagged with the
 * project picked. Asking for a description or a JIRA ticket on top must never quietly drop
 * that routing. The JIRA ticket in particular is an ADDITION to the card — it used to
 * replace it, which is how a card created "in JIRA" ended up with no description of its own.
 *
 * Files are the last answer and the one that cannot be written when it is given, so what
 * is pinned there is the invariant that lets a brief cite a file that does not exist yet:
 * the provisional name equals what `attachmentName` will produce in main, against the empty
 * taken-list a brand-new task has on both sides.
 */
import { describe, expect, it } from 'vitest';
import { attachmentName } from '@tm/shared/attachments';
import { PERSONAL_PROJECT_ID } from '@tm/shared/model';
import { addTaskPlan, stageAttachments, type AddTaskForm } from './AddTaskDialog';

const form = (over: Partial<AddTaskForm> = {}): AddTaskForm => ({
  title: 'Ship the thing',
  description: '',
  type: 'feature',
  issueType: 'task',
  epicTaskId: '',
  phase: '',
  parentId: '',
  asJira: false,
  jiraProjectKey: '',
  jiraTypeId: '',
  boardId: PERSONAL_PROJECT_ID,
  boardOwnsTickets: false,
  ...over,
});

describe('addTaskPlan', () => {
  it('says nothing while the title is empty — the disabled button already does', () => {
    expect(addTaskPlan(form({ title: '   ' }))).toEqual({ kind: 'incomplete', error: null });
  });

  it('writes an ordinary card on Personal, with the type and description carried onto it', () => {
    const plan = addTaskPlan(
      form({
        title: '  Ship the thing  ',
        description: '  Two paragraphs of context.  ',
        type: 'bug',
        phase: ' Phase 1 ',
      }),
    );
    expect(plan).toEqual({
      kind: 'card',
      board: PERSONAL_PROJECT_ID,
      card: {
        title: 'Ship the thing',
        phase: 'Phase 1',
        type: 'bug',
        description: 'Two paragraphs of context.',
        projectTagId: null,
      },
      ticket: null,
    });
  });

  it('writes a card, tagged with the board itself, for a keyless project', () => {
    const plan = addTaskPlan(form({ boardId: 'p-repo', boardOwnsTickets: false }));
    expect(plan).toMatchObject({
      kind: 'card',
      board: 'p-repo',
      card: { projectTagId: 'p-repo' },
    });
  });

  it('routes a ticket-owning board to a native ticket instead of a card', () => {
    const plan = addTaskPlan(
      form({
        boardId: 'p-billing',
        boardOwnsTickets: true,
        description: 'What it is about.',
        phase: ' Phase 1 ',
        issueType: 'story',
        epicTaskId: 'epic-1',
      }),
    );
    expect(plan).toEqual({
      kind: 'ticket',
      board: 'p-billing',
      ticket: {
        title: 'Ship the thing',
        phase: 'Phase 1',
        description: 'What it is about.',
        issueType: 'story',
        epicTaskId: 'epic-1',
      },
    });
  });

  it('gives a ticket-board plan a null epicTaskId, not an empty one', () => {
    const plan = addTaskPlan(form({ boardId: 'p-billing', boardOwnsTickets: true }));
    expect(plan.kind === 'ticket' && plan.ticket.epicTaskId).toBe(null);
  });

  it('never carries type onto a ticket-board plan — issueType is its replacement', () => {
    const plan = addTaskPlan(
      form({ boardId: 'p-billing', boardOwnsTickets: true, type: 'bug', issueType: 'epic' }),
    );
    expect(plan.kind).toBe('ticket');
    if (plan.kind !== 'ticket') return;
    expect(plan.ticket.issueType).toBe('epic');
    expect((plan.ticket as Record<string, unknown>).type).toBeUndefined();
  });

  it('adds a JIRA ticket to a Personal card rather than replacing it', () => {
    const plan = addTaskPlan(
      form({
        description: 'What it is about.',
        asJira: true,
        jiraProjectKey: 'ABC',
        jiraTypeId: '10001',
      }),
    );
    expect(plan.kind).toBe('card');
    if (plan.kind !== 'card') return;
    // The card keeps everything it would have had without the switch…
    expect(plan.card.description).toBe('What it is about.');
    expect(plan.card.projectTagId).toBe(null);
    // …and the ticket says the same thing in JIRA's words.
    expect(plan.ticket).toEqual({
      projectKey: 'ABC',
      issueTypeId: '10001',
      summary: 'Ship the thing',
      description: 'What it is about.',
    });
  });

  it('refuses a JIRA ticket the instance cannot place, before the card is written', () => {
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
        boardId: 'p-billing',
        boardOwnsTickets: true,
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

describe('stageAttachments', () => {
  it('stages a file once however often it is picked', () => {
    const once = stageAttachments([], ['C:\\shots\\shot.png']);
    expect(stageAttachments(once, ['C:\\shots\\shot.png'])).toEqual(once);
    expect(once).toHaveLength(1);
  });

  it('keeps what was already staged when more arrives', () => {
    const staged = stageAttachments(stageAttachments([], ['C:\\a\\one.png']), ['C:\\a\\two.log']);
    expect(staged.map((s) => s.path)).toEqual(['C:\\a\\one.png', 'C:\\a\\two.log']);
    expect(staged.map((s) => s.name)).toEqual(['one.png', 'two.log']);
  });

  it('tells two files with the same basename apart, before the extension', () => {
    const staged = stageAttachments([], ['C:\\before\\shot.png', 'C:\\after\\shot.png']);
    expect(staged.map((s) => s.name)).toEqual(['shot.png', 'shot-2.png']);
  });

  it('names a file exactly as main will, against the empty list a new task has', () => {
    const paths = ['C:\\Users\\me\\Screenshot 2026-08-03 at 11.04 (1).png', '/home/me/../log.txt'];
    // The invariant staging rests on: the same pure function, the same growing taken-list,
    // starting empty — so the `@name` typed into the description before the task exists is
    // the name `attachment:add` gives the file afterwards.
    const taken: string[] = [];
    const expected = paths.map((p) => {
      const name = attachmentName(p, taken);
      taken.push(name);
      return name;
    });
    expect(stageAttachments([], paths).map((s) => s.name)).toEqual(expected);
  });

  it('gives back the dedupe suffix when the file that caused it is un-staged', () => {
    const staged = stageAttachments([], ['C:\\before\\shot.png', 'C:\\after\\shot.png']);
    const left = staged.filter((s) => s.path !== 'C:\\before\\shot.png');
    // Re-derived rather than filtered: main will run over the remaining path alone and call
    // it `shot.png`, so a chip still saying `shot-2.png` would be a ref pointing at nothing.
    expect(
      stageAttachments(
        [],
        left.map((s) => s.path),
      ).map((s) => s.name),
    ).toEqual(['shot.png']);
  });

  it('stages nothing for a pick that was cancelled', () => {
    expect(stageAttachments([], [])).toEqual([]);
  });
});
