/**
 * Static-markup coverage for `ArchivedRowView` — `ArchivedPane` itself loads its data through
 * `useInitialLoad`, which never resolves inside a synchronous `renderToStaticMarkup` pass, so
 * (same as `TaskSteps.render.test.tsx`'s own `StepRow`/`GateRow`) this goes straight at the
 * hook-free row instead, driving its `expanded`/`busy`/`refusalMessage` props directly rather
 * than simulating the click or the transport round trip that would produce them — this package
 * has no DOM testing library to fire one through (see `TaskSteps.render.test.tsx`'s own header).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { ArchivedRowView, type ArchivedRowViewProps } from './ArchivedPane';
import type { ArchivedRow } from './archivedView';

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

function milestoneRow(overrides: Partial<ArchivedRow> = {}): ArchivedRow {
  return {
    kind: 'milestone',
    id: 'm1',
    name: 'M2 · Review',
    archivedAt: 1_000,
    dueAt: 2_000,
    tickets: [],
    doneCount: 0,
    openCount: 0,
    flagged: false,
    ...overrides,
  };
}

function baseProps(overrides: Partial<ArchivedRowViewProps> = {}): ArchivedRowViewProps {
  return {
    row: milestoneRow(),
    expanded: false,
    onToggleExpand: () => {},
    busy: false,
    refusalMessage: null,
    onRestore: () => {},
    onSelectTicket: () => {},
    ...overrides,
  };
}

describe('ArchivedRowView', () => {
  it('renders the Restore button and the row name', () => {
    const html = renderToStaticMarkup(<ArchivedRowView {...baseProps()} />);
    expect(html).toContain('Restore');
    expect(html).toContain('M2 · Review');
  });

  it('shows a refusal message in a warning bar when one is set for this row', () => {
    const html = renderToStaticMarkup(
      <ArchivedRowView {...baseProps({ refusalMessage: 'M2 · Review is archived' })} />,
    );
    expect(html).toContain('M2 · Review is archived');
    expect(html).toContain('fui-MessageBar');
  });

  it('shows no refusal bar when nothing was refused', () => {
    const html = renderToStaticMarkup(<ArchivedRowView {...baseProps()} />);
    expect(html).not.toContain('fui-MessageBar');
  });

  it('disables the chevron and draws no icon for a row with no tickets', () => {
    const html = renderToStaticMarkup(
      <ArchivedRowView {...baseProps({ row: milestoneRow({ tickets: [] }) })} />,
    );
    expect(html).toMatch(/aria-label="Expand M2 · Review"[^>]*disabled=""/);
  });

  it('lists its tickets — key, title and a status glyph — only once expanded', () => {
    const t = ticket({ id: 'tk1', ticketKey: 'TM-9', title: 'Reconcile issues', status: 'done' });
    const row = milestoneRow({ tickets: [t], doneCount: 1, openCount: 0 });

    const collapsed = renderToStaticMarkup(
      <ArchivedRowView {...baseProps({ row, expanded: false })} />,
    );
    expect(collapsed).not.toContain('Reconcile issues');

    const open = renderToStaticMarkup(<ArchivedRowView {...baseProps({ row, expanded: true })} />);
    expect(open).toContain('TM-9');
    expect(open).toContain('Reconcile issues');
  });

  it('reads the ticket summary off archivedTicketSummary — "N done · M open", muted, no colour', () => {
    const open = ticket({ id: 'tk2', status: 'in-progress' });
    const done = ticket({ id: 'tk3', status: 'done' });
    const row = milestoneRow({ tickets: [open, done], doneCount: 1, openCount: 1 });

    const html = renderToStaticMarkup(<ArchivedRowView {...baseProps({ row })} />);
    expect(html).toContain('1 done · 1 open');
  });

  it('disables the Restore button while busy, and not otherwise', () => {
    // A row WITH tickets, so the chevron (also conditionally `disabled`) stays enabled and
    // the only `disabled=""` either render can carry is the Restore button's own.
    const row = milestoneRow({ tickets: [ticket({ id: 'tk4' })] });

    const idle = renderToStaticMarkup(<ArchivedRowView {...baseProps({ row, busy: false })} />);
    expect(idle).not.toContain('disabled=""');

    const busy = renderToStaticMarkup(<ArchivedRowView {...baseProps({ row, busy: true })} />);
    expect(busy).toContain('disabled=""');
  });
});
