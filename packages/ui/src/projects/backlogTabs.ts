/**
 * The issue list's Active / Backlog / All tabs (v9-1/v9-3) — which tickets the list shows at
 * all, applied BEFORE `backlogGroups`, so the Status, Epic and Milestone modes all honour the
 * same tab. Pure apart from the storage hook at the bottom, so each tab can be tested without
 * a DOM.
 *
 * - **Active**: everything not finished — every column but Done, a blocked ticket included.
 * - **Backlog**: what nobody has started — the To Do column only.
 * - **All**: every ticket, Done included.
 *
 * An epic is never filtered by its own column: it is a header the Epic and Milestone modes
 * hang rows under, not a row, so dropping a finished epic would orphan its open children
 * under "No epic". The Status mode drops epics itself.
 */
import { useState } from 'react';
import type { Task } from '@tm/shared/model';
import { columnForTask } from '@tm/shared/board';
import { isEpic } from '@tm/shared/tickets';

export type BacklogTab = 'active' | 'backlog' | 'all';

/** The tabs' own text, in tab order. */
export const BACKLOG_TAB_LABEL: Record<BacklogTab, string> = {
  active: 'Active',
  backlog: 'Backlog',
  all: 'All',
};

const BACKLOG_TABS = Object.keys(BACKLOG_TAB_LABEL) as BacklogTab[];

/** A stored tab back as a {@link BacklogTab}; anything else — a never-written key, a value
 *  from some later build — is `'active'`, the mockup's own default. */
export function parseBacklogTab(raw: string | null | undefined): BacklogTab {
  return BACKLOG_TABS.find((tab) => tab === raw) ?? 'active';
}

/** `tickets` as `tab` shows them, in their incoming order. */
export function ticketsForTab(tickets: readonly Task[], tab: BacklogTab): Task[] {
  if (tab === 'all') return [...tickets];
  return tickets.filter((ticket) => {
    if (isEpic(ticket)) return true;
    const column = columnForTask(ticket);
    return tab === 'backlog' ? column === 'todo' : column !== 'done';
  });
}

const BACKLOG_TAB_KEY = 'tm.backlog.tab';

/**
 * The issue list's tab, remembered per DEVICE under `tm.backlog.tab` and read back through
 * {@link parseBacklogTab} — the same best-effort storage as `useBacklogGroupMode`: storage
 * that refuses (private mode, a full quota) only means the choice is not kept.
 */
export function useBacklogTab(): [tab: BacklogTab, setTab: (tab: BacklogTab) => void] {
  const [tab, setTabState] = useState<BacklogTab>(() => {
    try {
      return parseBacklogTab(localStorage.getItem(BACKLOG_TAB_KEY));
    } catch {
      return 'active';
    }
  });

  function setTab(next: BacklogTab): void {
    setTabState(next);
    try {
      localStorage.setItem(BACKLOG_TAB_KEY, next);
    } catch {
      // Storage unavailable — the tab just is not remembered next time.
    }
  }

  return [tab, setTab];
}
