import { useCallback, useEffect, useState } from 'react';
import type { ActivityCursor } from '@tm/shared/activity';
import { readWebLastSeen, saveWebLastSeen } from './webLastSeen';

/**
 * The web's half of the `lastSeen`/`onSeen` pair `ActivityScreen` takes (F2.13), backed by
 * localStorage through `webLastSeen.ts` instead of the desktop's `app_state` key.
 *
 * Re-reads whenever `targetClientId` changes — switching the target Client (`ClientPicker`)
 * must show THAT desktop's own baseline, not whichever desktop this tab was pointed at a
 * moment ago. `onSeen` stores whatever `saveWebLastSeen` actually persisted, the same
 * forward-only value the desktop's own `onSeen` holds after `activity:setLastSeen`.
 */
export function useWebLastSeen(targetClientId: string | null): {
  lastSeen: ActivityCursor | null;
  onSeen: (cursor: ActivityCursor) => void;
} {
  const [lastSeen, setLastSeen] = useState<ActivityCursor | null>(() =>
    readWebLastSeen(window.localStorage, targetClientId),
  );

  useEffect(() => {
    setLastSeen(readWebLastSeen(window.localStorage, targetClientId));
  }, [targetClientId]);

  const onSeen = useCallback(
    (cursor: ActivityCursor) => {
      setLastSeen(saveWebLastSeen(window.localStorage, targetClientId, cursor));
    },
    [targetClientId],
  );

  return { lastSeen, onSeen };
}
