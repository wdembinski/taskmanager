/**
 * Static-markup coverage for `ArchivedTicketBanner` (F14.9) — the hook-free
 * `ArchivedTicketBannerView` is driven directly for the copy/Restore-visibility/refusal
 * cases, the same way `ArchivedPane.render.test.tsx` drives `ArchivedRowView`; the "nothing
 * for a live ticket" case goes through the full `ArchivedTicketBanner` (it is the one that
 * decides `null`), wrapped in `TransportProvider` with a stub, same as
 * `ticketReadOnly.render.test.tsx`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Milestone, Project, Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from '../transport';
import { ArchivedTicketBanner, ArchivedTicketBannerView } from './ArchivedTicketBanner';

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
    projectId: 'p1',
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

let milestoneSeq = 0;
function milestone(overrides: Partial<Milestone> = {}): Milestone {
  milestoneSeq += 1;
  return {
    id: `m${milestoneSeq}`,
    projectId: 'p1',
    name: `Milestone ${milestoneSeq}`,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: milestoneSeq,
    ...overrides,
  };
}

describe('ArchivedTicketBannerView', () => {
  it('shows the Restore button when a target is given', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView
        text="Archived with M2 · Review"
        onRestore={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(html).toContain('Archived with M2 · Review');
    expect(html).toContain('Restore');
  });

  it('shows the epic copy', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView
        text="Archived with epic TM-3"
        onRestore={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(html).toContain('Archived with epic TM-3');
  });

  it('shows the project copy', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView
        text="Archived with project Billing"
        onRestore={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(html).toContain('Archived with project Billing');
  });

  it('shows the self copy, plain "Archived"', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView text="Archived" onRestore={undefined} busy={false} error={null} />,
    );
    expect(html).toContain('Archived');
    expect(html).not.toContain('Restore');
  });

  it('hides Restore when there is no `onRestore` — read-only, or a non-epic self archive', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView text="Archived" onRestore={undefined} busy={false} error={null} />,
    );
    expect(html).not.toContain('Restore');
  });

  it('shows a refusal message inline, in the same bar', () => {
    const html = renderToStaticMarkup(
      <ArchivedTicketBannerView
        text="Archived with M2 · Review"
        onRestore={() => {}}
        busy={false}
        error="M2 · Review is archived"
      />,
    );
    expect(html).toContain('M2 · Review is archived');
    expect(html).toContain('fui-MessageBar');
  });
});

describe('ArchivedTicketBanner', () => {
  function render(props: {
    ticket: Task;
    milestones?: Milestone[];
    tickets?: Task[];
    projects?: Project[];
    readOnly?: boolean;
  }): string {
    return renderToStaticMarkup(
      <TransportProvider transport={stubTransport}>
        <ArchivedTicketBanner
          ticket={props.ticket}
          milestones={props.milestones ?? []}
          tickets={props.tickets ?? []}
          projects={props.projects}
          readOnly={props.readOnly}
        />
      </TransportProvider>,
    );
  }

  it('renders nothing for a live (not archived) ticket', () => {
    const html = render({ ticket: ticket({ id: 't1' }) });
    expect(html).toBe('');
  });

  it('renders the milestone banner, with Restore, for a ticket under an archived milestone', () => {
    const t = ticket({ id: 't1', milestoneId: 'm1' });
    const html = render({
      ticket: t,
      milestones: [milestone({ id: 'm1', name: 'M2 · Review', archivedAt: 1 })],
    });
    expect(html).toContain('Archived with M2 · Review');
    expect(html).toContain('Restore');
  });

  it('hides Restore when readOnly, even though the ticket is archived', () => {
    const t = ticket({ id: 't1', milestoneId: 'm1' });
    const html = render({
      ticket: t,
      milestones: [milestone({ id: 'm1', name: 'M2 · Review', archivedAt: 1 })],
      readOnly: true,
    });
    expect(html).toContain('Archived with M2 · Review');
    expect(html).not.toContain('Restore');
  });

  it('hides Restore for a self archive on a non-epic ticket (no restorable target)', () => {
    const t = ticket({ id: 't1', issueType: 'task', trackerArchivedAt: 1 });
    const html = render({ ticket: t });
    expect(html).toContain('Archived');
    expect(html).not.toContain('Restore');
  });
});
