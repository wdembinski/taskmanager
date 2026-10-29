/**
 * Proves the wiring in `TaskDetailHostView.tsx` costs nothing a caller already fully
 * supplies: rendered with every prop a board passes today, its markup must match
 * `TaskDetail` given the same props directly. `renderToStaticMarkup` rather than a DOM
 * testing library — this package has none — which also means none of the host's effects
 * run, so a caller that leaves everything `undefined` renders from `neededLoads`' own
 * fallbacks (empty lists, empty sets) exactly like a caller that passes those same empty
 * values today.
 *
 * The file is `TaskDetailHostView.tsx` rather than `TaskDetailHost.tsx` — the component's
 * exported name stays `TaskDetailHost` — because the package already has a pure
 * `taskDetailHost.ts` one directory entry away, and the two filenames would differ only in
 * the first letter's case. Windows' default case-insensitive filesystem (and `tsc`'s
 * `forceConsistentCasingInFileNames`, which errors on exactly this) resolve an
 * extension-less `./TaskDetailHost` import to whichever of the two sorts first, silently
 * handing a caller the pure module instead of the component.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from './transport';
import { TaskDetail } from './TaskDetail';
import { TaskDetailHost } from './TaskDetailHostView';

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

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

describe('TaskDetailHost', () => {
  it('matches TaskDetail given the same props, when the caller supplies everything', () => {
    const selected = task({ id: 'main', title: 'Ship the thing' });
    const shared = {
      subtasks: [],
      parentTask: null,
      mergeRequests: [],
      attachments: [],
      parentAttachments: [],
      chainLinks: [],
      chainTasksById: new Map([[selected.id, selected]]),
      liveRunTaskIds: new Set<string>(),
      mergingTaskIds: new Set<string>(),
    };

    const host = render(<TaskDetailHost taskId={selected.id} task={selected} {...shared} />);
    const direct = render(<TaskDetail task={selected} {...shared} />);

    expect(host).toBe(direct);
    expect(host).toContain('Ship the thing');
  });

  it('never draws a summary row as the open card — it waits for task:get (F29.2)', () => {
    // A board's chain index holds summaries; the row for the open card is in it, but the
    // pane must not render it as the card while `task:get` (which this stub never answers)
    // is still out.
    const summary = task({ id: 'main', title: 'Ship the thing' });
    const html = render(
      <TaskDetailHost taskId={summary.id} chainTasksById={new Map([[summary.id, summary]])} />,
    );

    expect(html).toBe(render(<TaskDetail task={null} />));
    expect(html).not.toContain('Ship the thing');
  });

  it('renders the empty state for no selection without touching the transport', () => {
    const html = render(<TaskDetailHost taskId={null} />);

    expect(html).toContain('Select a task to see its status and activity.');
  });
});
