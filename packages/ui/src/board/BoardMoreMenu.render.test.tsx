/**
 * Proves the board header's "…" (v9-7): opened, it lists Show Done (N), Focus this card's
 * chain, the commit graph and the detail pane — plus Current sprint, Removed cards and Sync
 * when the host offers them — and each entry calls its own handler. No DOM testing library in
 * this package, so the menu is rendered open and in place (`open`, `inline`) and each entry's
 * `onSelect` from `boardMoreMenuEntries` — the very function the component draws from — is
 * called directly.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { describe, expect, it, vi } from 'vitest';
import { BoardMoreMenu, boardMoreMenuEntries, type BoardMoreMenuProps } from './BoardMoreMenu';

function props(over: Partial<BoardMoreMenuProps> = {}): BoardMoreMenuProps {
  return {
    doneLabel: 'Show Done (3)',
    doneTitle: '3 finished cards are hidden',
    doneChecked: false,
    onToggleDone: vi.fn(),
    chainFocus: false,
    chainFocusDisabled: false,
    onToggleChainFocus: vi.fn(),
    showGraph: false,
    onToggleGraph: vi.fn(),
    showDetail: true,
    onToggleDetail: vi.fn(),
    archivedCount: 0,
    onOpenArchived: vi.fn(),
    ...over,
  };
}

function render(p: BoardMoreMenuProps, open = true): string {
  return renderToStaticMarkup(
    <FluentProvider theme={webLightTheme}>
      <BoardMoreMenu {...p} open={open} inline />
    </FluentProvider>,
  );
}

/** Each drawn entry, as `data-board-menu` id → its opening tag and text. */
function drawn(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<div[^>]*data-board-menu="(\w+)"[^>]*>.*?<\/span><\/div>/g)) {
    out.set(m[1], m[0]);
  }
  return out;
}

const text = (s: string | undefined): string => (s ?? '').replace(/<[^>]+>/g, '').trim();

describe('BoardMoreMenu', () => {
  it('is a single "…" button while shut', () => {
    const html = render(props(), false);
    expect(html).toContain('aria-label="More board options"');
    expect(html).not.toContain('data-board-menu');
  });

  it('lists Show Done (N), chain focus, the commit graph and the detail pane', () => {
    const items = drawn(render(props()));
    expect([...items.keys()]).toEqual(['done', 'chain', 'graph', 'detail']);
    expect(text(items.get('done'))).toBe('Show Done (3)');
    expect(text(items.get('chain'))).toBe('Focus this card’s chain');
    expect(text(items.get('graph'))).toBe('Commit graph');
    expect(text(items.get('detail'))).toBe('Detail pane');
  });

  it('ticks exactly the toggles that are on', () => {
    const items = drawn(render(props({ showDetail: true, chainFocus: true })));
    expect(items.get('detail')).toContain('aria-checked="true"');
    expect(items.get('chain')).toContain('aria-checked="true"');
    expect(items.get('done')).toContain('aria-checked="false"');
    expect(items.get('graph')).toContain('aria-checked="false"');
  });

  it('holds chain focus disabled with nothing selected', () => {
    const items = drawn(render(props({ chainFocusDisabled: true })));
    expect(items.get('chain')).toContain('aria-disabled="true"');
    expect(items.get('chain')).toContain('Pick a card first');
  });

  it('offers sprint, Removed cards and Sync only when the host does', () => {
    const items = drawn(
      render(
        props({
          sprint: { checked: true, onToggle: vi.fn() },
          archivedCount: 2,
          sync: { syncing: false, onSync: vi.fn() },
        }),
      ),
    );
    expect([...items.keys()]).toEqual([
      'done',
      'sprint',
      'chain',
      'graph',
      'detail',
      'archived',
      'sync',
    ]);
    expect(text(items.get('archived'))).toBe('Removed cards (2)');
    expect(text(items.get('sync'))).toBe('Sync now');
  });

  it('calls each entry’s own handler', () => {
    const p = props({
      sprint: { checked: false, onToggle: vi.fn() },
      archivedCount: 1,
      sync: { syncing: false, onSync: vi.fn() },
    });
    const handlers = {
      done: p.onToggleDone,
      sprint: p.sprint!.onToggle,
      chain: p.onToggleChainFocus,
      graph: p.onToggleGraph,
      detail: p.onToggleDetail,
      archived: p.onOpenArchived,
      sync: p.sync!.onSync,
    };
    const calls = (): number =>
      Object.values(handlers).reduce((n, h) => n + vi.mocked(h).mock.calls.length, 0);
    boardMoreMenuEntries(p).forEach((entry, i) => {
      entry.onSelect();
      // Its own handler, and nobody else's.
      expect(handlers[entry.id]).toHaveBeenCalledOnce();
      expect(calls()).toBe(i + 1);
    });
    expect(calls()).toBe(7);
  });
});
