/**
 * Proves `readOnly` actually suppresses the Ticket and Links sections' write controls,
 * rather than just being a prop that compiles. Rendered with `renderToStaticMarkup`
 * instead of a DOM testing library — this package has none, and this is enough to see
 * which markup a boolean prop produces without adding one.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TicketLink } from '@tm/shared/model';
import { TransportProvider, type Transport } from '../transport';
import { TaskLinksSection } from './TaskLinksSection';
import { TicketFieldsSection } from './TicketFieldsSection';

const stubTransport: Transport = {
  invoke: () => Promise.resolve(undefined) as never,
  on: () => () => {},
  pathForFile: () => '',
};

let seq = 0;
function ticket(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    projectId: 'proj',
    phase: '',
    title: 'Untitled',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

function renderLinks(readOnly: boolean): string {
  const main = ticket({ id: 'main', ticketKey: 'TM-1' });
  const other = ticket({ id: 'other', ticketKey: 'TM-2', title: 'Other ticket' });
  const link: TicketLink = {
    id: 'l1',
    fromTaskId: 'main',
    toTaskId: 'other',
    type: 'blocks',
    createdAt: 0,
  };
  const tasksById = new Map([[other.id, other]]);
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>
      <TaskLinksSection
        task={main}
        ticketLinks={[link]}
        tasksById={tasksById}
        candidates={[main, other]}
        readOnly={readOnly}
      />
    </TransportProvider>,
  );
}

function renderFields(readOnly: boolean): string {
  const main = ticket({ id: 'main' });
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>
      <TicketFieldsSection
        ticket={main}
        tickets={[main]}
        people={[]}
        agentProjects={[]}
        labels={[]}
        milestones={[]}
        readOnly={readOnly}
      />
    </TransportProvider>,
  );
}

describe('TaskLinksSection readOnly', () => {
  it('hides Remove and disables the add row when read-only', () => {
    const html = renderLinks(true);
    expect(html).not.toContain('Remove link to TM-2');
    expect(html).toMatch(/Add link[^<]*<\/button>/);
    expect(html).toContain('disabled=""');
  });

  it('shows Remove and an enabled add row otherwise', () => {
    const html = renderLinks(false);
    expect(html).toContain('Remove link to TM-2');
  });
});

describe('TicketFieldsSection readOnly', () => {
  it('disables every field and hides the manager popovers when read-only', () => {
    const html = renderFields(true);
    expect(html).not.toContain('Manage milestones');
    expect(html).not.toContain('Manage labels');
    expect(html).toContain('disabled=""');
  });

  it('shows the manager popovers otherwise', () => {
    const html = renderFields(false);
    expect(html).toContain('Manage milestones');
    expect(html).toContain('Manage labels');
  });
});
