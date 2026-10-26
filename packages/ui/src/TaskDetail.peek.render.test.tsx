/**
 * Proves the stacked pane's header — the board's own detail pane (`layout` unset; the Tickets
 * screen's peek is `IssuePeekBody` now, see `issues/IssuePeekBody.render.test.tsx`) — leaves the title
 * the row's width: Edit and Show on board are icon-only buttons named by `aria-label`, and
 * the tracker key sits on the meta line under the title rather than beside it. At 1100px the
 * peek is ~300px wide, and two text buttons plus the badge squeezed the title to one word
 * per line.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
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

const card: Task = {
  id: 'card-1',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'Wire the retry queue to the dashboard',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  type: 'feature',
  externalKey: 'FX-1',
};

/** The opening tag of the `<button>` whose `aria-label` is `label`, plus its contents. */
function button(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>.*?</button>`))?.[0];
}

describe('TaskDetail, peek header', () => {
  const html = render(<TaskDetail task={card} onShowOnBoard={() => {}} />);

  it('draws Edit and Show on board as icon-only buttons named by aria-label', () => {
    const edit = button(html, 'Edit title');
    const show = button(html, 'Show on board');
    expect(edit).toBeDefined();
    expect(show).toBeDefined();
    expect(edit).toContain('<svg');
    expect(show).toContain('<svg');
    // No visible text label: strip the icon and nothing readable is left.
    expect(edit!.replace(/<svg.*?<\/svg>/g, '').replace(/<[^>]+>/g, '')).toBe('');
    expect(show!.replace(/<svg.*?<\/svg>/g, '').replace(/<[^>]+>/g, '')).toBe('');
    expect(html).not.toMatch(/>Edit<\/button>/);
    expect(html).not.toContain('>Show on board<');
  });

  it('puts the key on the meta line, after the title and its buttons', () => {
    const title = html.indexOf('Wire the retry queue to the dashboard');
    const show = html.indexOf('aria-label="Show on board"');
    const key = html.indexOf('>FX-1<');
    const meta = html.indexOf('>feature<');
    expect(title).toBeGreaterThan(-1);
    expect(key).toBeGreaterThan(show);
    expect(key).toBeLessThan(meta);
  });

  it('keeps the linked key variant on the meta line too', () => {
    const linked = render(
      <TaskDetail
        task={{ ...card, externalUrl: 'https://tracker.example/FX-1' }}
        onShowOnBoard={() => {}}
      />,
    );
    const anchor = linked.indexOf('href="https://tracker.example/FX-1"');
    expect(anchor).toBeGreaterThan(linked.indexOf('aria-label="Show on board"'));
    expect(anchor).toBeLessThan(linked.indexOf('>feature<'));
  });
});
