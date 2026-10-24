/**
 * Proves the property column's click-to-edit: at rest a value is plain text inside a click
 * target and no Dropdown is drawn; with the Status editor open, the State dropdown takes the
 * value's place; and a read-only column draws neither. This package has no DOM to click in,
 * so the click and the Esc are the transitions `nextEditing` makes
 * (`issuePropertyRows.test.ts`), and the two states they move between are rendered here —
 * the rest state being what Esc returns to.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Milestone, type Person, type Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { TransportProvider, type Transport } from '../transport';
import { IssueProperties, type IssuePropertiesProps } from './IssueProperties';
import { nextEditing, type PropertyEditor } from './issuePropertyRows';

const stubTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

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

const card = task({ id: 'c', source: 'ticket', status: 'in-progress', milestoneId: 'm4' });
const blocker = task({ id: 'b', ticketKey: 'TM-68', title: 'IPC channels' });
const links: TaskLink[] = [
  { id: 'l', fromTaskId: 'b', toTaskId: 'c', gate: 'after-merge', createdAt: 1 },
];

function render(over: Partial<IssuePropertiesProps> = {}): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>
      <IssueProperties
        task={card}
        tickets={[]}
        people={[] as Person[]}
        agentProjects={[]}
        labels={[]}
        milestones={[{ id: 'm4', name: 'M4 · Reach' }] as unknown as Milestone[]}
        chainLinks={links}
        chainTasksById={new Map([['b', blocker]])}
        mergeRequests={[]}
        onTaskChanged={() => {}}
        onModelChange={() => {}}
        {...over}
      />
    </TransportProvider>,
  );
}

/** The markup the column shows after a sequence of clicks and keys, from rest. */
function after(events: Parameters<typeof nextEditing>[1][]): string {
  let editing: PropertyEditor | null = null;
  for (const e of events) editing = nextEditing(editing, e);
  return render({ defaultEditing: editing });
}

describe('IssueProperties', () => {
  it('reads label over value, with the Blocked-by card as a link', () => {
    const html = render();
    expect(html).toContain('>Status<');
    expect(html).toContain('In Progress');
    expect(html).toContain('M4 · Reach');
    expect(html).toContain('>Blocked by<');
    expect(html).toContain('TM-68');
    expect(html).toContain('IPC channels');
    expect(html).toContain('More fields');
  });

  it('at rest, Status is a click target and no Dropdown is drawn', () => {
    const html = render();
    expect(html).toMatch(/data-property="status"[^]*?data-property-value/);
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('data-property-editing');
  });

  it('clicking the Status value swaps in the State dropdown, and Esc puts the text back', () => {
    const opened = after([{ type: 'open', editor: 'status' }]);
    expect(opened).toContain('data-property-editing');
    expect(opened).toMatch(/role="combobox"[^>]*title="Status"|title="Status"[^>]*role="combobox"/);

    const escaped = after([{ type: 'open', editor: 'status' }, { type: 'close' }]);
    expect(escaped).not.toContain('role="combobox"');
    expect(escaped).toContain('In Progress');
  });

  it('readOnly draws plain values — no click target, and no editor even when asked', () => {
    const html = render({ readOnly: true, defaultEditing: 'status' });
    expect(html).toContain('In Progress');
    expect(html).not.toContain('data-property-value');
    expect(html).not.toContain('role="combobox"');
  });
});
