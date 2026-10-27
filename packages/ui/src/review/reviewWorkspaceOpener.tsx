/**
 * How a card's Changes pane reaches the host's review workspace (F15.14b).
 *
 * The pane's **Open in review workspace** button needs to switch the HOST's screen — the
 * desktop's tab, the web's screen — which neither `ReviewPane` nor `TaskDetail` above it knows
 * how to do. A context carries the capability instead of a prop for the same reason
 * `gateTrustHost.tsx` does: `ReviewPane` sits several layers under `TaskDetail`, and threading
 * an `onOpenInWorkspace` through every one of them just for this would touch far more files
 * than the fact is worth.
 *
 * The default is `null` — no opener, so no button. Only a host that actually mounts the
 * workspace wraps its tree in a provider; a headless render, a harness or a host that never
 * learnt the screen draws the pane exactly as it was.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface ReviewWorkspaceOpener {
  /** Switch to the review workspace with `subjectId` (e.g. `taskSubjectId(taskId)`) selected. */
  open: (subjectId: string) => void;
}

const ReviewWorkspaceOpenerContext = createContext<ReviewWorkspaceOpener | null>(null);

export function ReviewWorkspaceOpenerProvider({
  value,
  children,
}: {
  value: ReviewWorkspaceOpener | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <ReviewWorkspaceOpenerContext.Provider value={value}>
      {children}
    </ReviewWorkspaceOpenerContext.Provider>
  );
}

/** The host's opener, or `null` when no provider is mounted above — see the module header. */
export function useReviewWorkspaceOpener(): ReviewWorkspaceOpener | null {
  return useContext(ReviewWorkspaceOpenerContext);
}
