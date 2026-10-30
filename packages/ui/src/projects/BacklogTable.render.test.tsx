/**
 * Static-markup coverage for the Backlog's foldable group headers (TM-450). `BacklogTable`
 * itself needs a transport for its live-run pill, so — like `ArchivedPane.render.test.tsx`'s
 * `ArchivedRowView` — this goes straight at the hook-free `BacklogRowView` over the rows
 * `flattenBacklog` makes (F29.3 draws the list flat, for windowing), driving its
 * `folded` set directly rather than clicking (no DOM testing library in this package), and at
 * `onSectionHeaderKeyDown` with a fake event for the Space-never-reaches-the-pane rule.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@tm/shared/model';
import { IssueRow } from '../issues/IssueRow';
import {
  BacklogHeader,
  type BacklogHeaderProps,
  BacklogRowView,
  type BacklogRowViewProps,
  onSectionHeaderKeyDown,
} from './BacklogTable';
import { type BacklogSection, flattenBacklog } from './backlogGrouping';

function ticket(id: string, title: string): Task {
  return {
    id,
    projectId: 'p1',
    phase: '',
    title,
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
  };
}

function section(overrides: Partial<BacklogSection> = {}): BacklogSection {
  return {
    id: 'milestone:m1',
    label: 'M1 · Launch',
    level: 1,
    tickets: [ticket('t1', 'Ship the switch')],
    sections: [
      {
        id: 'milestone:m1/epic:e1',
        label: 'Grouping epic',
        level: 2,
        addChildEpicId: 'e1',
        tickets: [ticket('t2', 'Fold the headers')],
        sections: [],
      },
    ],
    ...overrides,
  };
}

/** The section as the list draws it: flattened, then one `BacklogRowView` per row. */
function render(overrides: Partial<BacklogRowViewProps> = {}): string {
  const folded = overrides.folded ?? new Set<string>();
  return renderToStaticMarkup(
    <>
      {flattenBacklog([section()], folded).map((row) => (
        <BacklogRowView
          key={row.key}
          row={row}
          folded={folded}
          onToggleFold={() => {}}
          onAddChild={() => {}}
          renderTicket={(r) => <div>{r.task.title}</div>}
          {...overrides}
        />
      ))}
    </>,
  );
}

describe('BacklogRowView', () => {
  it('shows its rows, its sub-headers and the total count while unfolded', () => {
    const html = render();
    expect(html).toContain('M1 · Launch');
    expect(html).toContain('Ship the switch');
    expect(html).toContain('Grouping epic');
    expect(html).toContain('Fold the headers');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>2</span>');
  });

  it('hides its rows and sub-headers once folded, keeping the header and count', () => {
    const html = render({ folded: new Set(['milestone:m1']) });
    expect(html).toContain('M1 · Launch');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>2</span>');
    expect(html).not.toContain('Ship the switch');
    expect(html).not.toContain('Grouping epic');
  });

  it('folds a sub-header on its own', () => {
    const html = render({ folded: new Set(['milestone:m1/epic:e1']) });
    expect(html).toContain('Ship the switch');
    expect(html).toContain('Grouping epic');
    expect(html).not.toContain('Fold the headers');
  });

  it('offers "Add child" on a real epic header only', () => {
    const html = render();
    expect(html).toContain('aria-label="Add child to Grouping epic"');
    expect(html).not.toContain('aria-label="Add child to M1 · Launch"');
  });

  it('marks the milestone and its epic sub-header with their levels', () => {
    // The sub-header's spaced, indented style keys on level 2 — the shots prove the spacing.
    const html = render();
    expect(html).toContain('data-backlog-section-level="1"');
    expect(html).toContain('data-backlog-section-level="2"');
    expect(html.indexOf('data-backlog-section-level="1"')).toBeLessThan(
      html.indexOf('data-backlog-section-level="2"'),
    );
  });
});

function headerProps(over: Partial<BacklogHeaderProps> = {}): BacklogHeaderProps {
  return {
    leading: <button type="button">Tickets chip</button>,
    tab: 'active',
    onTabChange: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    searchOpen: false,
    onSearchOpenChange: vi.fn(),
    groupMode: 'status',
    onGroupModeChange: vi.fn(),
    includeArchived: false,
    onIncludeArchivedChange: vi.fn(),
    viewMenu: {
      view: 'backlog',
      onViewChange: vi.fn(),
      peekOpen: false,
      peekDisabled: true,
      onTogglePeek: vi.fn(),
    },
    onNewTicket: vi.fn(),
    ...over,
  };
}

function renderHeader(over: Partial<BacklogHeaderProps> = {}): string {
  return renderToStaticMarkup(
    <FluentProvider theme={webLightTheme}>
      <BacklogHeader {...headerProps(over)} />
    </FluentProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ');

describe('BacklogHeader', () => {
  it('draws one row: chip, Issues, the three tabs, search, "…" and "+", in that order', () => {
    const html = renderHeader();
    const order = [
      'Tickets chip',
      '>Issues<',
      'role="tablist"',
      'aria-label="Search issues"',
      'aria-label="More options"',
      'aria-label="New ticket"',
    ].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says "Backlog" exactly once while "…" is shut — the tab, not a view switch', () => {
    const html = renderHeader();
    expect(textOf(html).match(/Backlog/g)).toHaveLength(1);
    expect(html).toMatch(/role="tab"[^>]*>Backlog</);
  });

  it('draws search as a button until it is opened, then as a textbox', () => {
    const shut = renderHeader();
    expect(shut).toMatch(/<button[^>]*aria-label="Search issues"/);
    expect(shut).not.toContain('<input');

    const open = renderHeader({ searchOpen: true });
    expect(open).toMatch(/<input[^>]*aria-label="Search issues"/);
    expect(open).not.toMatch(/<button[^>]*aria-label="Search issues"/);
  });

  it('keeps the box open while it still holds a query', () => {
    const html = renderHeader({ searchOpen: false, query: 'relay' });
    expect(html).toMatch(/<input[^>]*value="relay"/);
  });

  it('offers Backlog, Timeline and Graph under "…", with the open view checked', () => {
    const html = renderHeader({ menuOpen: true });
    const radios = [...html.matchAll(/<div[^>]*role="menuitemradio"[^>]*>.*?<\/div>/g)].map(
      (m) => m[0],
    );
    const view = radios.filter((r) => r.includes('data-issue-menu="view-'));
    expect(view.map((r) => textOf(r).trim())).toEqual(['Backlog', 'Timeline', 'Graph']);
    expect(view[0]).toContain('aria-checked="true"');
    expect(view[1]).toContain('aria-checked="false"');
    expect(html).toContain('data-issue-menu="group-epic"');
    expect(html).toContain('data-issue-menu="peek"');
    expect(html).toContain('data-issue-menu="archived"');
  });
});

describe('IssueRow assignee', () => {
  it('shows the avatar but not the delegated agent’s name', () => {
    const html = renderToStaticMarkup(
      <FluentProvider theme={webLightTheme}>
        <IssueRow
          task={{ ...ticket('t1', 'Ship the switch'), ticketKey: 'FX-1' }}
          ctx={{
            now: 0,
            assignee: { name: 'Wojciech Dembinski', initials: 'WD', color: '#0F6CBD' },
            agentName: 'Fixture',
          }}
        />
      </FluentProvider>,
    );
    expect(textOf(html)).toContain('WD');
    expect(textOf(html)).not.toContain('Fixture');
  });
});

describe('onSectionHeaderKeyDown', () => {
  it.each([' ', 'Enter'])('toggles on %j and defaults it, so the pane never peeks', (key) => {
    const toggle = vi.fn();
    const preventDefault = vi.fn();
    onSectionHeaderKeyDown({ key, preventDefault }, toggle);
    expect(toggle).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('lets every other key through untouched', () => {
    const toggle = vi.fn();
    const preventDefault = vi.fn();
    onSectionHeaderKeyDown({ key: 'Escape', preventDefault }, toggle);
    expect(toggle).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
