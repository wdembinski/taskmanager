/**
 * Static-markup coverage for the two bits `Sidebar.tsx` added for the tracker-project
 * switcher (F13's "follow the open project" work): the `role="tree"` element dropping out of
 * the DOM for the empty state (an empty tree is an a11y error, per this file's own rule), and
 * the switcher appearing only once both `onSelectProject` and a non-empty `projectOptions` are
 * passed. No DOM testing library in this package (see `TaskSteps.render.test.tsx`), so this
 * only proves what lands in the markup, not clicks or the open popover — the Archived row
 * block below proves it is now a real `<button>` wired to `onNavigate`, the same ceiling.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar, type SidebarProps } from './Sidebar';
import type { SidebarSection, SidebarTreeNode } from './sidebarModel';

const teamSection = (
  over: Partial<Extract<SidebarSection, { kind: 'team' }>> = {},
): SidebarSection => ({
  kind: 'team',
  name: 'Task Manager',
  tree: [],
  ...over,
});

const archivedSection = (count = 3): SidebarSection => ({ kind: 'archived', count });

const ticketNode = (over: Partial<SidebarTreeNode> = {}): SidebarTreeNode => ({
  id: 'ticket:t1',
  kind: 'ticket',
  label: 'Fix the thing',
  taskId: 't1',
  status: 'pending',
  count: 0,
  folded: false,
  children: [],
  ...over,
});

const baseProps: SidebarProps = {
  sections: [teamSection()],
  selectedView: null,
  onNavigate: () => {},
  onOpenTicket: () => {},
  onNewIssue: () => {},
  onToggleFold: () => {},
};

describe('Sidebar', () => {
  it('renders the empty-tree row instead of role="tree" when the tree is empty', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} />);
    expect(markup).not.toContain('role="tree"');
    expect(markup).toContain('Task Manager has no tickets yet');
  });

  it('falls back to "No ticket project yet" when the team has no name', () => {
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection({ name: undefined })]} />,
    );
    expect(markup).toContain('No ticket project yet');
  });

  it('heads the sidebar with the workspace and its subtitle, never "This machine"', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        {...baseProps}
        sections={[
          {
            kind: 'workspace',
            workspaces: [{ id: 'w1', name: 'Personal', sub: 'Local' }],
            activeWorkspaceId: 'w1',
          },
          teamSection(),
        ]}
      />,
    );
    expect(markup).toContain('>Personal<');
    expect(markup).toContain('>Local<');
    expect(markup).not.toContain('This machine');
  });

  it('falls back to "Personal" when no workspace is active', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        {...baseProps}
        sections={[{ kind: 'workspace', workspaces: [], activeWorkspaceId: null }, teamSection()]}
      />,
    );
    expect(markup).toContain('>Personal<');
    expect(markup).not.toContain('This machine');
  });

  it('shows no ticket key on a tree row', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        {...baseProps}
        sections={[teamSection({ tree: [ticketNode({ ticketKey: 'TM-42' })] })]}
      />,
    );
    expect(markup).toContain('Fix the thing');
    expect(markup).not.toContain('TM-42');
  });

  it('keeps the plain caption when there is nothing to switch between', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} />);
    expect(markup).not.toContain('aria-label="Switch ticket project"');
  });

  it('renders the switcher once onSelectProject and projectOptions are both passed', () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        {...baseProps}
        projectOptions={[{ id: 'p1', name: 'Task Manager' }]}
        selectedProjectId="p1"
        onSelectProject={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Switch ticket project"');
  });

  it('renders the Archived row as a clickable button, with its count', () => {
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection(), archivedSection(3)]} />,
    );
    // Non-greedy up to the nearest `</button>` — proves THIS button's own content carries
    // "Archived", not merely that a button and the word both appear somewhere in the page
    // (the team header's own Issues/Projects links are buttons too).
    expect(markup).toMatch(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*Archived(?:(?!<\/button>)[\s\S])*<\/button>/,
    );
    expect(markup).toContain('>3<');
  });

  it('marks the Archived row current once it is the selected view, not otherwise', () => {
    const sections = [teamSection(), archivedSection()];
    const notSelected = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={sections} selectedView={null} />,
    );
    expect(notSelected).not.toContain('aria-current="true"');

    const selected = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={sections} selectedView={{ kind: 'archived' }} />,
    );
    expect(selected).toContain('aria-current="true"');
  });

  it("hides a finished milestone's tickets by default, folded like the model resolved it", () => {
    const finishedMilestone: SidebarTreeNode = {
      id: 'milestone:m1',
      kind: 'milestone',
      label: 'Shipped milestone',
      count: 1,
      finished: true,
      defaultFolded: true,
      folded: true,
      children: [ticketNode({ label: 'Already done', status: 'done' })],
    };
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection({ tree: [finishedMilestone] })]} />,
    );
    expect(markup).toContain('Shipped milestone');
    expect(markup).not.toContain('Already done');
  });

  it("gives a running ticket's glyph the Running label, not a colour-only cue", () => {
    const runningTicket = ticketNode({ label: 'Mid-flight', status: 'running' });
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection({ tree: [runningTicket] })]} />,
    );
    expect(markup).toContain('Mid-flight');
    expect(markup).toContain('aria-label="Running"');
  });

  it("dims a finished epic/milestone header's title the same way a done ticket's is", () => {
    const doneEpic: SidebarTreeNode = {
      id: 'epic:m1:e1',
      kind: 'epic',
      label: 'Finished epic',
      count: 1,
      finished: true,
      defaultFolded: true,
      folded: true,
      children: [ticketNode({ label: 'Already done', status: 'done' })],
    };
    const openEpic: SidebarTreeNode = {
      ...doneEpic,
      id: 'epic:m1:e2',
      label: 'Open epic',
      finished: false,
      defaultFolded: false,
      folded: false,
    };
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection({ tree: [doneEpic, openEpic] })]} />,
    );
    const doneClass = /class="([^"]*)">Finished epic</.exec(markup)?.[1];
    const openClass = /class="([^"]*)">Open epic</.exec(markup)?.[1];
    expect(doneClass).toBeTruthy();
    expect(openClass).toBeTruthy();
    expect(doneClass).not.toBe(openClass);
  });

  it("shows a milestone's count as open/total, not a bare total", () => {
    const milestoneNode: SidebarTreeNode = {
      id: 'milestone:m1',
      kind: 'milestone',
      label: 'Mixed milestone',
      count: 2,
      openCount: 1,
      finished: false,
      defaultFolded: false,
      folded: false,
      children: [],
    };
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection({ tree: [milestoneNode] })]} />,
    );
    expect(markup).toContain('>1/2<');
  });

  it("shows each This machine row's location after its name, from the model", () => {
    const machine: SidebarSection = {
      kind: 'machine',
      label: 'This machine',
      location: 'local',
      projects: [{ id: 'p1', name: 'Personal' }],
    };
    const markup = renderToStaticMarkup(
      <Sidebar {...baseProps} sections={[teamSection(), machine]} />,
    );
    expect(markup).toContain('>This machine<');
    expect(markup).toMatch(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*Personal(?:(?!<\/button>)[\s\S])*>local<(?:(?!<\/button>)[\s\S])*<\/button>/,
    );
  });

  it('marks only the open ticket selected in the tree', () => {
    const tree = [
      ticketNode(),
      ticketNode({ id: 'ticket:t2', taskId: 't2', label: 'Another thing' }),
    ];
    const markup = renderToStaticMarkup(
      <Sidebar
        {...baseProps}
        sections={[teamSection({ tree })]}
        selectedView={{ kind: 'ticket', taskId: 't1' }}
      />,
    );
    expect(markup).toMatch(/id="sidebar-tree-ticket:t1"[^>]*aria-selected="true"/);
    expect(markup).not.toMatch(/id="sidebar-tree-ticket:t2"[^>]*aria-selected/);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it('keeps the Issues and Projects quick links in the markup, found by name', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} />);
    expect(markup).toContain('aria-label="Issues"');
    expect(markup).toContain('aria-label="Projects"');
    // The icon row hides at rest but is not removed — still in the DOM and the tab order.
    expect(markup).not.toMatch(/aria-label="Issues"[^>]*tabindex="-1"/);
  });
});
