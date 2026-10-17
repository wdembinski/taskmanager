/**
 * `useArchiveAction` — the one call every archive button in the app goes through
 * (`MilestoneList`, the epic panel in `TicketFieldsSection`, `ProjectAdmin`, the desktop
 * `Projects.tsx`): invoke `archive:apply`, and on success raise a toast on the shared
 * `TOASTER_ID` rather than each caller rolling its own.
 *
 * Undo rides the same toast as a `ToastTrigger`-wrapped `Link`, and only when `choice` was
 * never sent — a one-click archive (no open tickets, nothing to redirect) is exactly what
 * `archive:restore` can put back. A dialog-driven archive that moved open tickets to the
 * Backlog or another milestone cannot be undone by this call: those tickets already left,
 * and restoring the milestone does not pull them back.
 */
import {
  Link,
  Toast,
  ToastBody,
  ToastTitle,
  ToastTrigger,
  useToastController,
} from '@fluentui/react-components';
import type { ArchiveResult, ArchiveTarget, OpenTicketsChoice } from '@tm/shared/trackerArchive';
import { useTransport } from '../transport';
import { TOASTER_ID } from '../theme';

/** What `archive` hands back — the store's own `ArchiveResult` on a round trip, or a bare
 *  message when the transport call itself threw rather than resolving. */
export type ArchiveActionResult = ArchiveResult | { ok: false; message: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useArchiveAction(): {
  /**
   * `onRestored` fires once Undo's own `archive:restore` lands ok — nothing to do with the
   * archive call's own result, since that already resolved (and its caller moved on) well
   * before a human clicks Undo on the toast. `ProjectAdmin` and the desktop `Projects.tsx`
   * use it to re-read `project:list`, the same re-read `archive`'s own success needs and for
   * the same reason: a project row changed and nothing pushes that.
   */
  archive: (
    target: ArchiveTarget,
    label: string,
    choice?: OpenTicketsChoice,
    onRestored?: () => void,
  ) => Promise<ArchiveActionResult>;
} {
  const transport = useTransport();
  const { dispatchToast } = useToastController(TOASTER_ID);

  function raiseErrorToast(message: string): void {
    dispatchToast(
      <Toast>
        <ToastTitle>Couldn&apos;t undo</ToastTitle>
        <ToastBody>{message}</ToastBody>
      </Toast>,
      { intent: 'error' },
    );
  }

  async function restore(target: ArchiveTarget, onRestored?: () => void): Promise<void> {
    try {
      const result = await transport.invoke('archive:restore', target);
      if (result.ok) onRestored?.();
      else raiseErrorToast(result.message);
    } catch (e) {
      raiseErrorToast(errorMessage(e));
    }
  }

  async function archive(
    target: ArchiveTarget,
    label: string,
    choice?: OpenTicketsChoice,
    onRestored?: () => void,
  ): Promise<ArchiveActionResult> {
    let result: ArchiveResult;
    try {
      result = await transport.invoke('archive:apply', target, choice);
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    }

    if (result.ok) {
      dispatchToast(
        <Toast>
          <ToastTitle
            action={
              choice === undefined ? (
                <ToastTrigger>
                  <Link onClick={() => void restore(target, onRestored)}>Undo</Link>
                </ToastTrigger>
              ) : undefined
            }
          >
            Archived {label}
          </ToastTitle>
        </Toast>,
      );
    }

    return result;
  }

  return { archive };
}
