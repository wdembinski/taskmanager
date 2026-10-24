/**
 * Static-markup coverage for the Backlog's foldable group headers (TM-450). `BacklogTable`
 * itself needs a transport for its live-run pill, so — like `ArchivedPane.render.test.tsx`'s
 * `ArchivedRowView` — this goes straight at the hook-free `BacklogSectionView`, driving its
 * `folded` set directly rather than clicking (no DOM testing library in this package), and at
 * `onSectionHeaderKeyDown` with a fake event for the Space-never-reaches-the-pane rule.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@tm/shared/model';
import {
  BacklogSectionView,
  type BacklogSectionViewProps,
  onSectionHeaderKeyDown,
} from './BacklogTable';
import type { BacklogSection } from './backlogGrouping';

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

function render(overrides: Partial<BacklogSectionViewProps> = {}): string {
  return renderToStaticMarkup(
    <BacklogSectionView
      section={section()}
      folded={new Set()}
      onToggleFold={() => {}}
      onAddChild={() => {}}
      renderRow={(t) => <div key={t.id}>{t.title}</div>}
      {...overrides}
    />,
  );
}

describe('BacklogSectionView', () => {
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
