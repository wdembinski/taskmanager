import type { ActivityCursor } from '@tm/shared/activity';
import { ActivityScreen } from '@tm/ui/activity/ActivityScreen';
import { StatusBusy } from '@tm/ui/shell/StatusBar';
import type { DesktopPresence } from '../board/desktopPresence';
import { UnreachableBanner } from '../board/UnreachableBanner';
import { activityGate } from './activityGate';

/**
 * The web's Activity tab: the same `ActivityScreen` the desktop renders (F2.13), gated by
 * `activityGate`'s three-way read of whether there is a desktop to read it from.
 *
 * A wrapper rather than mounting `ActivityScreen` directly, for the same reason
 * `AutomationsScreen` exists beside `AutomationsView`: `ActivityScreen` is host-agnostic
 * (`packages/ui`, shared with the desktop) and `shell-parity.test.ts` forbids copying it into
 * a host tree, so anything web-only — here, the gate below — has to live in a wrapper instead
 * of inside the shared component.
 *
 * Unlike `AutomationsScreen`'s banner (which sits ABOVE a view that still renders), a gate
 * failure here REPLACES the view: there is nothing true this screen could show once its one
 * source — a live desktop — is unreachable, so `unreachable`/`checking` return early rather
 * than rendering `ActivityScreen` underneath a warning.
 *
 * `lastSeen`/`onSeen` are taken as props rather than owned here — same host-agnostic pair
 * `ActivityScreen` itself already takes, just passed through. The per-desktop, localStorage
 * cursor backing them is a separate concern from this gate and is not part of this file.
 */
export function WebActivityScreen({
  pollError,
  presence,
  targetClientId,
  lastSeen,
  onSeen,
  onOpenTask,
}: {
  pollError: string | null;
  presence: DesktopPresence;
  targetClientId: string | null;
  lastSeen: ActivityCursor | null;
  onSeen: (cursor: ActivityCursor) => void;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element {
  const gate = activityGate({ pollError, presence, targetClientId });
  switch (gate.kind) {
    case 'unreachable':
      return (
        <UnreachableBanner
          title="Activity cannot reach a desktop app."
          message={gate.message}
          detail="Activity is read live from your desktop; nothing is shown until it is back."
        />
      );
    case 'checking':
      return <StatusBusy label="Checking for a desktop app…" />;
    case 'ready':
      return <ActivityScreen lastSeen={lastSeen} onSeen={onSeen} onOpenTask={onOpenTask} />;
  }
}
