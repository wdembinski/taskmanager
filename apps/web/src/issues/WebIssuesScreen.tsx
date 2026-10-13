import { IssuesScreen } from '@tm/ui/issues/IssuesScreen';
import { StatusBusy } from '@tm/ui/shell/StatusBar';
import type { DesktopPresence } from '../board/desktopPresence';
import { UnreachableBanner } from '../board/UnreachableBanner';
import { activityGate } from '../activity/activityGate';

/**
 * The web's Issues tab: the same `IssuesScreen` the desktop renders (F5.10), gated by
 * `activityGate`, reused as-is rather than copied — Issues is read live through a desktop's
 * own tracker connections, exactly the fact `activityGate` already tests for Activity.
 */
export function WebIssuesScreen({
  pollError,
  presence,
  targetClientId,
  onOpenTask,
}: {
  pollError: string | null;
  presence: DesktopPresence;
  targetClientId: string | null;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element {
  const gate = activityGate({ pollError, presence, targetClientId });
  switch (gate.kind) {
    case 'unreachable':
      return (
        <UnreachableBanner
          title="Issues cannot reach a desktop app."
          message={gate.message}
          detail="Issues are read live through your desktop's tracker connections; nothing is shown until it is back."
        />
      );
    case 'checking':
      return <StatusBusy label="Checking for a desktop app…" />;
    case 'ready':
      return <IssuesScreen onOpenTask={onOpenTask} />;
  }
}
