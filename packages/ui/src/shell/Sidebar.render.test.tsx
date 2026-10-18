/**
 * Static-markup coverage for the two bits `Sidebar.tsx` added for the tracker-project
 * switcher (F13's "follow the open project" work): the `role="tree"` element dropping out of
 * the DOM for the empty state (an empty tree is an a11y error, per this file's own rule), and
 * the switcher appearing only once both `onSelectProject` and a non-empty `projectOptions` are
 * passed. No DOM testing library in this package (see `TaskSteps.render.test.tsx`), so this
 * only proves what lands in the markup, not clicks or the open popover.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar, type SidebarProps } from './Sidebar';
import type { SidebarSection } from './sidebarModel';

const teamSection = (
  over: Partial<Extract<SidebarSection, { kind: 'team' }>> = {},
): SidebarSection => ({
  kind: 'team',
  name: 'Task Manager',
  tree: [],
  ...over,
});

const baseProps: SidebarProps = {
  sections: [teamSection()],
  selectedView: null,
  onNavigate: () => {},
  onOpenTicket: () => {},
  onNewIssue: () => {},
  folds: [],
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
});
