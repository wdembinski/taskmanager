/**
 * The ticket panel's own "this is archived" bar (F14.9) — the thing `TaskDetail` shows a
 * human who reached an archived native ticket some way other than the Archived view (a
 * direct link, a search hit, a cross-project link) and would otherwise see nothing telling
 * them why, or how to put it back.
 *
 * `ArchivedTicketBannerView` is deliberately hook-free, the same reason `ArchivedRowView`
 * (`ArchivedPane.tsx`) is split out from the piece that loads its data: `TaskTicketSection`
 * already has everywhere the transport/milestone/project state lives, so the view itself
 * only needs to be handed the one sentence and the one button, and is driven directly in
 * `ArchivedTicketBanner.render.test.tsx` through `renderToStaticMarkup`.
 *
 * `ArchivedTicketBanner` renders nothing (`null`) for a ticket that isn't archived — the
 * common case, so most panels draw no bar at all — and never needs a reload once a restore
 * lands ok: `archive:restore` already pushes `milestone:changed`/`tasks:changed` for a
 * milestone or epic target, which the host's own registries listen for, so the next render
 * finds `archivedBy` returning `null` and the bar disappears on its own. Restoring a PROJECT
 * target pushes neither (see `archiveHandlers.ts`'s own docstring) — the bar can linger one
 * render behind a project restore, same gap `useArchiveAction`'s `onRestored` callback exists
 * to close elsewhere; not re-opened here without being asked.
 */
import { useCallback, useMemo, useState } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody } from '@fluentui/react-components';
import { ArchiveRegular } from '@fluentui/react-icons';
import type { Milestone, Project, Task } from '@tm/shared/model';
import {
  archivedBanner,
  archivedBy,
  archivedByNamesOf,
  archiveIndexOf,
  archiveRestoreTarget,
  type ArchiveResult,
} from '@tm/shared/trackerArchive';
import { useTransport } from '../transport';

export interface ArchivedTicketBannerViewProps {
  text: string;
  /** Absent hides the Restore button outright — a read-only host, or a `self` archive with
   *  no restorable target (a non-epic ticket archived alongside its milestone/epic). */
  onRestore?: () => void;
  busy: boolean;
  /** The refusal message from a restore call that came back `{ ok: false }` — shown inline
   *  rather than in a second bar, so the ticket panel never shows two archive notices at once. */
  error: string | null;
}

/** The bar itself — hook-free, see this file's own header. */
export function ArchivedTicketBannerView({
  text,
  onRestore,
  busy,
  error,
}: ArchivedTicketBannerViewProps): JSX.Element {
  return (
    <MessageBar intent="info" icon={<ArchiveRegular />}>
      <MessageBarBody>
        {text}
        {error ? ` — ${error}` : null}
      </MessageBarBody>
      {onRestore && (
        <MessageBarActions>
          <Button size="small" appearance="transparent" disabled={busy} onClick={onRestore}>
            {busy ? 'Restoring…' : 'Restore'}
          </Button>
        </MessageBarActions>
      )}
    </MessageBar>
  );
}

export interface ArchivedTicketBannerProps {
  ticket: Task;
  /** This project's milestones, closed and archived ones included — `TaskTicketSection`'s
   *  own `milestones` prop, passed straight through. */
  milestones: Milestone[];
  /** This project's other tickets — epic candidates, doubling here as the epic lookup
   *  `archivedBy` needs. `TaskTicketSection`'s own `tickets` prop. */
  tickets: Task[];
  /** The tracker projects `archivedBy`'s own project check reads — absent on a host that
   *  hasn't wired one through yet, which only means a project-archived banner never fires;
   *  milestone/epic/self banners still work off `milestones`/`tickets` alone. */
  projects?: Project[];
  readOnly?: boolean;
}

export function ArchivedTicketBanner({
  ticket,
  milestones,
  tickets,
  projects = [],
  readOnly = false,
}: ArchivedTicketBannerProps): JSX.Element | null {
  const transport = useTransport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const by = useMemo(
    () => archivedBy(ticket, archiveIndexOf(milestones, tickets, projects)),
    [ticket, milestones, tickets, projects],
  );
  const target = by ? archiveRestoreTarget(ticket, by) : null;

  const restore = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const result: ArchiveResult = await transport.invoke('archive:restore', target);
      if (!result.ok) setError(result.message);
    } finally {
      setBusy(false);
    }
  }, [transport, target]);

  if (!by) return null;

  const text = archivedBanner(by, archivedByNamesOf(milestones, tickets, projects));

  return (
    <ArchivedTicketBannerView
      text={text}
      onRestore={!readOnly && target ? restore : undefined}
      busy={busy}
      error={error}
    />
  );
}
