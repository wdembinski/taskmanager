/**
 * Proves `TaskDetail`'s `layout="full"` — the Tickets screen's full-screen issue — draws the
 * two-column page after `v9-2-issue-detail-light.svg`: the key above the title, Run for a
 * startable card, the description as text, the step checklist, Built, and a property column;
 * and that the stacked pane's full-width State dropdown is gone from it. The stacked pane is
 * rendered alongside as the control, so a passing "not there" means something.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeStyles, tokens } from '@fluentui/react-components';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { TransportProvider, type Transport } from './transport';
import { TaskDetail } from './TaskDetail';

const stubTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

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

const mr = {
  id: 'gl-1-191',
  taskId: 'card-1',
  provider: 'gitlab',
  number: 191,
  state: 'opened',
  draft: false,
  pipelineStatus: 'success',
  pipelineStages: [],
  updatedAt: 1,
} as unknown as MergeRequest;

const card = task({
  id: 'card-1',
  title: 'Show Linear identifiers and comments on cards',
  ticketKey: 'TM-71',
  externalDescription: 'Cards from Linear should carry their identifier.',
  agentProjectId: 'proj',
  agentBranch: 'tm-71-linear-identifiers',
});
const steps = [
  task({ id: 'step-1', parentTaskId: 'card-1', title: 'Read the identifier', order: 1 }),
  task({ id: 'step-2', parentTaskId: 'card-1', title: 'Draw it on the card', order: 2 }),
];

describe('TaskDetail, layout="full"', () => {
  const full = render(
    <TaskDetail task={card} subtasks={steps} mergeRequests={[mr]} layout="full" />,
  );
  const stacked = render(<TaskDetail task={card} subtasks={steps} mergeRequests={[mr]} />);

  it('puts the key above a large title', () => {
    expect(full).toContain('data-issue-key');
    expect(full).toContain('TM-71');
    expect(full).toMatch(/<h1[^>]*>Show Linear identifiers and comments on cards<\/h1>/);
    expect(full.indexOf('TM-71')).toBeLessThan(full.indexOf('<h1'));
  });

  it('offers Run for a startable card, and the agent panel does not repeat it as Start', () => {
    expect(full).toMatch(/>Run<\/button>/);
    expect(full).not.toMatch(/>Start<\/button>/);
    expect(stacked).toMatch(/>Start<\/button>/);
    expect(stacked).not.toMatch(/>Run<\/button>/);
  });

  it('shows the description as text, the steps list and Built', () => {
    expect(full).toContain('data-issue-description');
    expect(full).toContain('Cards from Linear should carry their identifier.');
    expect(full).toContain('>Steps<');
    expect(full).toContain('Read the identifier');
    expect(full).toContain('data-issue-built');
    expect(full).toContain('tm-71-linear-identifiers');
    expect(full).toContain('!191 open · pipeline passed');
  });

  it('drops the full-width State dropdown and the Description fold', () => {
    expect(stacked).toContain('title="Status"');
    expect(full).not.toContain('title="Status"');
    expect(stacked).toContain('>Description<');
    expect(full).not.toContain('>Description<');
  });

  it('keeps the Links heading, the conversation log and a property column', () => {
    expect(full).toContain('data-links-heading');
    expect(full).toContain('role="log"');
    expect(full).toContain('data-issue-properties');
  });

  it('puts Run, Edit and Show on board on the key row above the title, not beside it', () => {
    const page = render(
      <TaskDetail
        task={card}
        subtasks={steps}
        mergeRequests={[mr]}
        layout="full"
        onShowOnBoard={() => {}}
      />,
    );
    const top = page.indexOf('data-issue-top-row');
    const h1 = page.indexOf('<h1');
    expect(top).toBeGreaterThan(-1);
    for (const action of [
      '>Run</button>',
      'aria-label="Edit title"',
      'aria-label="Show on board"',
    ]) {
      const at = page.indexOf(action);
      expect(at, action).toBeGreaterThan(top);
      expect(at, action).toBeLessThan(h1);
    }
    // The h1 is alone in its row: nothing follows it before that row closes.
    expect(page).toMatch(/<h1[^>]*>[^<]*<\/h1><\/div>/);
    // Icon-only: no visible "Edit" / "Show on board" text label.
    expect(page).not.toMatch(/>Edit<\/button>/);
    expect(page).not.toMatch(/>Show on board<\/button>/);
  });

  it('sets the title at Hero700 (28px), not Hero800', () => {
    const useProbe = makeStyles({
      hero700: { fontSize: tokens.fontSizeHero700 },
      hero800: { fontSize: tokens.fontSizeHero800 },
    });
    let probe: { hero700: string; hero800: string } = { hero700: '', hero800: '' };
    function Probe(): null {
      probe = useProbe();
      return null;
    }
    render(<Probe />);
    const h1Class = /<h1 class="([^"]*)"/.exec(full)?.[1]?.split(' ') ?? [];
    // Griffel classes are atomic: the h1 carries the very class a probe gets for the property.
    const atomic = (cls: string) => cls.split(' ').filter((c) => c.startsWith('f'));
    expect(atomic(probe.hero700).length).toBeGreaterThan(0);
    expect(atomic(probe.hero700).every((c) => h1Class.includes(c))).toBe(true);
    expect(atomic(probe.hero800).some((c) => h1Class.includes(c))).toBe(false);
  });

  it('draws no Run once the card has worked', () => {
    const worked = render(
      <TaskDetail task={{ ...card, workedAt: 5 }} subtasks={steps} layout="full" />,
    );
    expect(worked).not.toMatch(/>Run<\/button>/);
  });
});
