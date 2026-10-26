import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Milestone, type Person, type Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import {
  blockingCards,
  formatDue,
  issuePropertyRows,
  nextEditing,
  peekAssigneeValue,
  type IssuePropertiesInput,
} from './issuePropertyRows';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const link = (from: string, to: string, gate: TaskLink['gate'] = 'after-merge'): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate,
  createdAt: 1,
});

const people = [{ id: 'p1', name: 'Wojciech' }] as unknown as Person[];
const milestones = [{ id: 'm4', name: 'M4 · Reach' }] as unknown as Milestone[];

function rows(over: Partial<IssuePropertiesInput> & { task: Task }) {
  return issuePropertyRows({
    people,
    milestones,
    modelCaption: 'Opus 5.5',
    chainLinks: [],
    chainTasksById: new Map(),
    ...over,
  });
}

describe('issuePropertyRows', () => {
  it("prints the mockup's order for a fully populated native ticket", () => {
    const blocker = task({ id: 'b', ticketKey: 'TM-68', title: 'IPC channels' });
    const card = task({
      id: 'c',
      source: 'ticket',
      status: 'in-progress',
      assigneeId: 'p1',
      milestoneId: 'm4',
      estimateDays: 3,
      dueAt: new Date(2026, 9, 17).getTime(),
    });
    const out = rows({
      task: card,
      runner: 'WD-DESKTOP',
      chainLinks: [link('b', 'c')],
      chainTasksById: new Map([['b', blocker]]),
    });
    expect(out.map((r) => r.label)).toEqual([
      'Status',
      'Assignee',
      'Runner',
      'Model',
      'Milestone',
      'Estimate',
      'Due',
      'Blocked by',
    ]);
    expect(out.map((r) => r.value)).toEqual([
      'In Progress',
      'Wojciech',
      'WD-DESKTOP',
      'Opus 5.5',
      'M4 · Reach',
      '3 days',
      'Oct 17, 2026',
      null,
    ]);
    expect(out.map((r) => r.editor)).toEqual([
      'status',
      'assignee',
      undefined,
      'model',
      'milestone',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('omits Runner, Estimate, Due and Blocked by when there is nothing to say', () => {
    const out = rows({ task: task({ id: 'c', source: 'ticket' }) });
    expect(out.map((r) => r.key)).toEqual(['status', 'assignee', 'model', 'milestone']);
    // Empty but editable: the empty value is the thing to click.
    expect(out.find((r) => r.key === 'assignee')?.value).toBe('Unassigned');
    expect(out.find((r) => r.key === 'milestone')?.value).toBe('None');
  });

  it('drops the empty ticket fields of a card that is not a native ticket', () => {
    const out = rows({ task: task({ id: 'c', source: 'jira' }) });
    expect(out.map((r) => r.key)).toEqual(['status', 'model']);
  });

  it('keeps a non-native ticket field that has a value, read-only', () => {
    const out = rows({ task: task({ id: 'c', source: 'jira', milestoneId: 'm4' }) });
    const milestone = out.find((r) => r.key === 'milestone');
    expect(milestone?.value).toBe('M4 · Reach');
    expect(milestone?.editor).toBeUndefined();
  });

  it('names the delegated agent beside the person, or alone', () => {
    const card = task({ id: 'c', source: 'ticket', assigneeId: 'p1' });
    expect(rows({ task: card, agentName: 'Agent' })[1].value).toBe('Wojciech / Agent');
    expect(rows({ task: { ...card, assigneeId: null }, agentName: 'Agent' })[1].value).toBe(
      'Agent',
    );
  });

  it('reads Status as where the card rests, not the run that borrowed it', () => {
    const out = rows({ task: task({ id: 'c', status: 'running', preRunStatus: 'in-review' }) });
    expect(out[0].value).toBe('In Review');
  });

  it('readOnly leaves every value and no editor', () => {
    const out = rows({
      task: task({ id: 'c', source: 'ticket', milestoneId: 'm4' }),
      readOnly: true,
    });
    expect(out.map((r) => r.key)).toEqual(['status', 'model', 'milestone']);
    expect(out.every((r) => r.editor === undefined)).toBe(true);
  });
});

describe('blockingCards', () => {
  const a = task({ id: 'a', ticketKey: 'TM-68', title: 'IPC channels' });
  const b = task({ id: 'b', externalKey: 'FX-2', title: 'Two' });
  const byId = new Map([
    ['a', a],
    ['b', b],
  ]);

  it('reads the after-merge links INTO the card, in link order', () => {
    expect(blockingCards('c', [link('a', 'c'), link('b', 'c')], byId)).toEqual([
      { taskId: 'a', key: 'TM-68', title: 'IPC channels' },
      { taskId: 'b', key: 'FX-2', title: 'Two' },
    ]);
  });

  it('ignores links out of the card, stacked links and cards the index lacks', () => {
    expect(
      blockingCards('c', [link('c', 'a'), link('b', 'c', 'stacked'), link('gone', 'c')], byId),
    ).toEqual([]);
  });
});

describe('formatDue', () => {
  it('prints the short US date the mockup uses', () => {
    expect(formatDue(new Date(2026, 9, 17).getTime())).toBe('Oct 17, 2026');
  });
});

describe('nextEditing', () => {
  it('opens one editor at a time and closes on Esc, blur or save', () => {
    let editing = nextEditing(null, { type: 'open', editor: 'status' });
    expect(editing).toBe('status');
    editing = nextEditing(editing, { type: 'open', editor: 'model' });
    expect(editing).toBe('model');
    expect(nextEditing(editing, { type: 'close' })).toBeNull();
  });

  it('never opens one while read-only', () => {
    expect(nextEditing(null, { type: 'open', editor: 'status' }, true)).toBeNull();
  });
});

describe('peekAssigneeValue', () => {
  const card = { assigneeId: null };

  it('names the machine the agent runs on', () => {
    expect(
      peekAssigneeValue({ task: card, people, agentName: 'Fixture', hostname: 'WD-DESKTOP' }),
    ).toBe('Agent on WD-DESKTOP');
  });

  it("falls back to the agent project's name when the hostname is unknown", () => {
    expect(peekAssigneeValue({ task: card, people, agentName: 'Fixture' })).toBe(
      'Agent on Fixture',
    );
    expect(peekAssigneeValue({ task: card, people, agentName: 'Fixture', hostname: '  ' })).toBe(
      'Agent on Fixture',
    );
  });

  it('leads with the person when one is assigned as well', () => {
    expect(
      peekAssigneeValue({
        task: { assigneeId: 'p1' },
        people,
        agentName: 'Fixture',
        hostname: 'WD-DESKTOP',
      }),
    ).toBe('Wojciech · Agent on WD-DESKTOP');
  });

  it('is the person alone without an agent, and null with nobody', () => {
    expect(peekAssigneeValue({ task: { assigneeId: 'p1' }, people, hostname: 'WD-DESKTOP' })).toBe(
      'Wojciech',
    );
    expect(peekAssigneeValue({ task: card, people, hostname: 'WD-DESKTOP' })).toBeNull();
  });
});
