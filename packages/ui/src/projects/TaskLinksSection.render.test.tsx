/**
 * Proves the Links section's "Blocked by" / "Blocks" lists are read off the order ARROWS —
 * the same arrows that hold the card — and that a leftover `blocks` ticket link no longer
 * shows up beside them. Rendered with `renderToStaticMarkup`, as `ticketReadOnly.render.test`
 * is: this package has no DOM testing library, and markup is enough to see what a row says.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { TransportProvider, type Transport } from '../transport';
import { TaskLinksSection } from './TaskLinksSection';
import { ADD_LINK_KINDS, addLinkKindLabel } from './TicketLinksEditor';

const stubTransport: Transport = {
  invoke: () => Promise.resolve(undefined) as never,
  on: () => () => {},
  pathForFile: () => '',
};

function card(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'proj',
    phase: '',
    title: overrides.id,
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

const arrow = (fromTaskId: string, toTaskId: string): TaskLink => ({
  id: `arrow-${fromTaskId}-${toTaskId}`,
  fromTaskId,
  toTaskId,
  gate: 'after-merge',
  createdAt: 0,
});

const ticketLink = (
  fromTaskId: string,
  toTaskId: string,
  type: TicketLink['type'],
): TicketLink => ({
  id: `tl-${fromTaskId}-${toTaskId}-${type}`,
  fromTaskId,
  toTaskId,
  type,
  createdAt: 0,
});

const me = card({ id: 'me', ticketKey: 'TM-10', title: 'The card on screen' });
const landed = card({
  id: 'landed',
  ticketKey: 'TM-3',
  title: 'Already landed',
  status: 'done',
  landedAt: 1,
});
const open = card({
  id: 'open',
  ticketKey: 'TM-4',
  title: 'Still in review',
  status: 'in-review',
});
const waiting = card({ id: 'waiting', ticketKey: 'TM-20', title: 'Waits for me' });
const related = card({ id: 'related', ticketKey: 'TM-30', title: 'Merely related' });
const stale = card({ id: 'stale', ticketKey: 'TM-40', title: 'Old blocks link' });

const all = [me, landed, open, waiting, related, stale];
const tasksById = new Map(all.map((t) => [t.id, t]));

function render(): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>
      <TaskLinksSection
        task={me}
        ticketLinks={[ticketLink('me', 'related', 'relates'), ticketLink('stale', 'me', 'blocks')]}
        chainLinks={[arrow('landed', 'me'), arrow('open', 'me'), arrow('me', 'waiting')]}
        tasksById={tasksById}
        candidates={all}
      />
    </TransportProvider>,
  );
}

/** The markup of the element carrying `attr`, up to the next group's opening. */
function groupMarkup(html: string, attr: string): string {
  const start = html.indexOf(attr);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-links-', start + attr.length);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('TaskLinksSection', () => {
  it('lists both incoming arrows under "Blocked by", with status and merged state', () => {
    const blockedBy = groupMarkup(render(), 'data-links-blocked-by');
    expect(blockedBy).toContain('Blocked by');
    expect(blockedBy).toContain('TM-3');
    expect(blockedBy).toContain('TM-4');
    expect(blockedBy).toContain('Done');
    expect(blockedBy).toContain('In Review');
    expect(blockedBy).toContain('>merged<');
    expect(blockedBy).toContain('>not merged<');
    expect(blockedBy.match(/data-dependency-row=/g)).toHaveLength(2);
    expect(blockedBy).toContain('Remove dependency on TM-3');
  });

  it('lists an outgoing arrow under "Blocks"', () => {
    const blocks = groupMarkup(render(), 'data-links-blocks');
    expect(blocks).toContain('Blocks');
    expect(blocks).toContain('TM-20');
    expect(blocks).not.toContain('Already landed');
  });

  it('still shows a relates ticket link, and no longer lists a leftover blocks ticket link', () => {
    const html = render();
    expect(html).toContain('relates to');
    expect(html).toContain('TM-30');
    expect(html).not.toContain('Remove link to TM-40');
    expect(html).not.toContain('is blocked by</span>');
  });

  it('drops the old "see Chain" pointer', () => {
    expect(render()).not.toContain('see Chain');
  });

  it('offers "blocks" and "is blocked by" in the add row, "blocks" only once', () => {
    // A closed Dropdown portals its options, so static markup only ever shows the selected
    // one — the default, "blocks". The full list is what the row maps its options from.
    expect(render()).toMatch(/Add link/);
    const labels = ADD_LINK_KINDS.map(addLinkKindLabel);
    expect(labels.slice(0, 2)).toEqual(['blocks', 'is blocked by']);
    expect(labels.filter((l) => l === 'blocks')).toHaveLength(1);
    expect(labels).toContain('relates to');
  });
});
