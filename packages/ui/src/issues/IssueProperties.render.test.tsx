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

/** One row's markup, from its opening tag to the next row's (or the list's end). */
function rowOf(html: string, key: string): string {
  const start = html.indexOf(`data-property="${key}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('data-property="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe('IssueProperties', () => {
  it('lays each row out label-left: the label, then the value cell, in one grid row', () => {
    const status = rowOf(render(), 'status');
    const label = status.indexOf('>Status<');
    const cell = status.indexOf('data-property-cell');
    expect(label).toBeGreaterThan(0);
    expect(cell).toBeGreaterThan(label);
    // The value sits inside the cell, not beside the label in the row itself.
    expect(status.indexOf('In Progress')).toBeGreaterThan(cell);
  });

  it('draws the column glyph on Status, the flag on Milestone, and no icon on Model', () => {
    const html = render();
    expect(rowOf(html, 'status')).toContain('data-property-icon="status-in-progress"');
    expect(rowOf(html, 'milestone')).toContain('data-property-icon="milestone"');
    expect(rowOf(html, 'model')).not.toContain('data-property-icon');
  });

  it('draws the agent glyph for a card delegated to an agent', () => {
    const html = render({
      task: { ...card, agentProjectId: 'p1' },
      agentProjects: [{ id: 'p1', name: 'retry-queue' }] as never,
    });
    const assignee = rowOf(html, 'assignee');
    expect(assignee).toContain('data-property-icon="agent"');
    expect(assignee).toContain('retry-queue');
  });

  it('opens an editor in the value cell, leaving the label where it was', () => {
    const status = rowOf(after([{ type: 'open', editor: 'status' }]), 'status');
    const label = status.indexOf('>Status<');
    expect(label).toBeGreaterThan(0);
    expect(status.indexOf('data-property-editing')).toBeGreaterThan(
      status.indexOf('data-property-cell'),
    );
    expect(status.indexOf('data-property-cell')).toBeGreaterThan(label);
  });

  it('reads label and value, with the Blocked-by card as plain text, not a link', () => {
    const html = render();
    expect(html).toContain('>Status<');
    expect(html).toContain('In Progress');
    expect(html).toContain('M4 · Reach');
    expect(html).toContain('>Blocked by<');
    const blockedBy = rowOf(html, 'blockedBy');
    expect(blockedBy).toContain('data-blocked-by="b"');
    expect(blockedBy).toContain('>TM-68<');
    expect(blockedBy).toContain('>IPC channels<');
    // v9-2 draws a muted key and a plain title — the Links section is what opens the card.
    expect(blockedBy).not.toContain('fui-Link');
    expect(blockedBy).not.toContain('<a ');
    expect(html).toContain('More fields');
  });

  it('carries the whole value in a title, so a value cut to one line can still be read', () => {
    expect(rowOf(render(), 'milestone')).toContain('title="M4 · Reach"');
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
