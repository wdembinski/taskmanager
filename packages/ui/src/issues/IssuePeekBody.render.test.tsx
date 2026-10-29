/**
 * The Tickets screen's peek is a read-only summary (`TaskDetail`'s `layout="peek"`): v9-1's
 * key · epic line, title, description, the four label/value rows, the "Agent run" checklist
 * with a timer on the running step, the conversation and one Reply box — and none of the
 * editors, which stay on the full page. `IssuePeekBody` is driven directly for the timer (the
 * run snapshot is read in an effect, which static markup never runs); everything else goes
 * through `TaskDetail` itself, so a control leaking back into the peek fails here.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Milestone, Person, Project, Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from '../transport';
import { TaskDetail } from '../TaskDetail';
import { IssuePeekBody } from './IssuePeekBody';
import { issuePropertyRows, peekAssigneeValue } from './issuePropertyRows';

const stubTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

function render(node: JSX.Element): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'card-71',
    projectId: 'proj-1',
    phase: '',
    title: 'Archive a finished milestone',
    status: 'running',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    type: 'feature',
    ticketKey: 'TM-71',
    externalDescription: 'Move **every** finished ticket into the archive.',
    milestoneId: 'm4',
    epicTaskId: 'epic-4',
    assigneeId: 'person-1',
    dueAt: new Date(2026, 9, 17).getTime(),
    ...overrides,
  };
}

const epic = task({ id: 'epic-4', title: 'F14 Milestone archiving', ticketKey: 'TM-4' });
const people: Person[] = [{ id: 'person-1', name: 'Wojciech' } as Person];
const milestones: Milestone[] = [{ id: 'm4', name: 'M4 · Reach' } as Milestone];
const agentProject = { id: 'agent-1', name: 'Fixture' } as Project;

function step(id: string, title: string, status: Task['status']): Task {
  return task({ id, title, status, parentTaskId: 'card-71', agentProjectId: 'agent-1' });
}

const steps: Task[] = [
  step('s1', 'Map the fields', 'done'),
  step('s2', 'Write the sync', 'running'),
  step('s3', 'Test both ways', 'pending'),
];

function peek(overrides: Partial<Task> = {}): string {
  return render(
    <TaskDetail
      task={task({ agentProjectId: 'agent-1', ...overrides })}
      layout="peek"
      subtasks={steps}
      agentProjects={[agentProject]}
      people={people}
      milestones={milestones}
      chainTasksById={new Map([[epic.id, epic]])}
      liveRunTaskIds={new Set(['s2'])}
      onShowOnBoard={() => {}}
      onStatusChanged={() => {}}
    />,
  );
}

/** Text content only, tags stripped — so order checks read what a human reads. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('IssuePeekBody, through TaskDetail layout="peek"', () => {
  const html = peek();
  const words = text(html);

  it('leaves the key to the IssuePeek header, so it is printed once', () => {
    expect(words).not.toContain('TM-71');
  });

  it('reads top to bottom: title, description, rows, steps', () => {
    const order = [
      'Archive a finished milestone',
      'finished ticket into the archive',
      'Status',
      'Assignee',
      'Milestone',
      'Due',
      'Agent run',
      'Map the fields',
      'Write the sync',
      'Test both ways',
    ].map((s) => words.indexOf(s));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders the description as markdown', () => {
    expect(html).not.toContain('**every**');
    expect(html).toMatch(/<span[^>]*>every<\/span>/);
  });

  it('prints the four label/value rows in a <dl>', () => {
    const dl = html.match(/<dl[^>]*data-peek-props[^>]*>.*?<\/dl>/)?.[0] ?? '';
    expect(text(dl)).toContain('Status');
    // No hostname reached a static render (the `app:getInfo` read is an effect), so the
    // agent falls back to its project's name.
    expect(text(dl)).toContain('Wojciech · Agent on Fixture');
    expect(text(dl)).toContain('M4 · Reach');
    expect(text(dl)).toContain('Oct 17, 2026');
    expect(dl.match(/<dt/g)).toHaveLength(4);
    // The full page's extra rows stay there.
    expect(text(dl)).not.toContain('Model');
  });

  it('draws the Status, Assignee and Milestone glyphs, and none on Due', () => {
    const dl = html.match(/<dl[^>]*data-peek-props[^>]*>.*?<\/dl>/)?.[0] ?? '';
    expect(dl).toMatch(/data-property-icon="status-[a-z-]+"/);
    expect(dl).toContain('data-property-icon="agent"');
    expect(dl).toContain('data-property-icon="milestone"');
    expect(dl.match(/data-property-icon=/g)).toHaveLength(3);
  });

  it('draws each step with its done/running/pending glyph', () => {
    expect(html).toContain('data-step-glyph="done"');
    expect(html).toContain('data-step-glyph="running"');
    expect(html).toContain('data-step-glyph="pending"');
  });

  it('offers exactly one Reply field — a one-line input, not a textarea — and a Send button', () => {
    expect(html.match(/<input[^>]*aria-label="Reply"/g)).toHaveLength(1);
    expect(html).not.toMatch(/<textarea/);
    expect(html).toMatch(/<button[^>]*aria-label="Send"/);
  });

  it('has no combobox and none of the editing buttons', () => {
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toMatch(/<select/);
    for (const name of [
      'Delete task',
      'Merge branch',
      'Create PR',
      'Reassign',
      'Apply workflow',
      'Edit title',
      'Show on board',
    ]) {
      expect(html).not.toContain(`aria-label="${name}"`);
      expect(html).not.toMatch(new RegExp(`<button[^>]*>(?:(?!</button>).)*${name}`));
    }
  });

  it('shows the decision banner only when a decision is open', () => {
    expect(html).not.toContain('Which milestones do we archive?');
    const asked = peek({
      decisionQuestion: 'Which milestones do we archive?',
      decisionAskedAt: Date.now(),
    });
    expect(asked).toContain('Which milestones do we archive?');
  });
});

describe('IssuePeekBody', () => {
  it('times the running step from its run start', () => {
    const html = render(
      <IssuePeekBody
        task={task()}
        rows={[]}
        subtasks={steps}
        runStartedAt={new Map([['s2', Date.now() - (4 * 60 + 12) * 1000]])}
        turns={[{ key: 'a1', kind: 'agent', text: 'Mapped the status field.', createdAt: 1 }]}
        attachments={[]}
        activity={[]}
        onNeedsChanges={() => {}}
        reply=""
        onReplyChange={() => {}}
        onSend={() => {}}
        replyToAgent
      />,
    );
    const timer = html.match(/data-step-timer[^>]*>([^<]*)</)?.[1];
    expect(timer).toMatch(/^4m 1[23]s$/);
    // On the running step's row, not another.
    const runningRow = html.match(/<li[^>]*>(?:(?!<\/li>).)*Write the sync(?:(?!<\/li>).)*<\/li>/);
    expect(runningRow?.[0]).toContain('data-step-timer');
    // The timeline — the peek's own, not ChatTurns' bubbles.
    expect(html).toContain('aria-label="Conversation"');
    expect(html).toContain('data-peek-timeline');
    expect(html).not.toContain('data-chat-bubble');
    expect(html).toContain('Mapped the status field.');
  });
});

describe('IssuePeekBody property rows', () => {
  /** The rows exactly as `TaskDetail`'s peek builds them, with the desktop's hostname known. */
  function peekRows(card: Task, hostname?: string) {
    return issuePropertyRows({
      task: card,
      people,
      milestones,
      agentName: 'Fixture',
      modelCaption: '',
      chainLinks: [],
      chainTasksById: new Map(),
      readOnly: true,
    })
      .filter((row) => ['status', 'assignee', 'milestone', 'due'].includes(row.key))
      .map((row) =>
        row.key === 'assignee'
          ? {
              ...row,
              value:
                peekAssigneeValue({ task: card, people, agentName: 'Fixture', hostname }) ??
                row.value,
            }
          : row,
      );
  }

  function body(card: Task, hostname?: string): string {
    return render(
      <IssuePeekBody
        task={card}
        rows={peekRows(card, hostname)}
        people={people}
        agentName="Fixture"
        subtasks={[]}
        turns={[]}
        attachments={[]}
        activity={[]}
        onNeedsChanges={() => {}}
        reply=""
        onReplyChange={() => {}}
        onSend={() => {}}
        replyToAgent
      />,
    );
  }

  it('reads "Agent on <machine>" with the agent glyph for an agent card', () => {
    const html = body(task({ agentProjectId: 'agent-1', assigneeId: null }), 'WD-DESKTOP');
    const dl = html.match(/<dl[^>]*data-peek-props[^>]*>.*?<\/dl>/)?.[0] ?? '';
    expect(text(dl)).toContain('Agent on WD-DESKTOP');
    expect(text(dl)).not.toContain('Fixture');
    expect(dl).toContain('data-property-icon="agent"');
    expect(dl).toMatch(/data-property-icon="status-[a-z-]+"/);
    expect(dl).toContain('data-property-icon="milestone"');
  });

  it("falls back to the agent project's name when no hostname is known", () => {
    const html = body(task({ agentProjectId: 'agent-1', assigneeId: null }));
    expect(text(html)).toContain('Agent on Fixture');
  });
});
