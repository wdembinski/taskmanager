/**
 * The Changes pane (F6.11): what a card's agent changed, read without leaving the app.
 * Wires `reviewState.ts`'s pure transitions to a card's own `task:diffSummary`/
 * `task:diffFile` reads, then hands the result to {@link ReviewPaneView} to draw.
 *
 * This component owns every effect and `useTransport` call; {@link ReviewPaneView} owns
 * none — it is a `state` in, JSX out function, which is what lets a headless script seed a
 * `ReviewState` by hand and render exactly what a human would see with no engine behind it.
 *
 * **One counter, both races.** `reviewState.ts`'s own header names two races — the
 * summary load and each file's own patch load — and says the caller mints every `seq`
 * "from one ever-increasing counter". `seq` below is that one ref, shared by the summary
 * fetch and every file fetch: a global monotonic counter is always also a valid per-path
 * one, so there is no reason to keep two.
 *
 * **Switching cards resets in the same render that starts showing the new one**, the same
 * trick `TaskDetail.tsx`'s own `renderedTaskId` uses for its timeline: an effect fires
 * after paint, which would be one frame of the OLD card's diff under the NEW card's
 * header. `summaryLoadStarted` is reseeded with the state's own `applied` (not a new
 * `seq`) precisely so it is a no-op the moment the real load — minted a moment later, in
 * the effect below — supersedes it.
 *
 * **The file-fetch effect re-runs on every `state` change** and that is deliberate rather
 * than expensive: `fetchablePaths` only ever returns a path that is still `idle`, and the
 * very first thing this effect does for a path is flip it to `loading` — so a path already
 * in flight drops out of the next render's list on its own, the same self-limiting shape
 * `filesToLoad` was built for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useTransport } from '../transport';
import {
  EMPTY_REVIEW,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  selectFile,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  toggleExpanded,
  type ReviewState,
} from './reviewState';
import { defaultExpanded, fetchablePaths } from './reviewView';
import { ReviewPaneView } from './ReviewPaneView';

export interface ReviewPaneProps {
  taskId: string;
}

export function ReviewPane({ taskId }: ReviewPaneProps): JSX.Element {
  const transport = useTransport();
  const [state, setState] = useState<ReviewState>(EMPTY_REVIEW);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const loadSummary = useCallback(async () => {
    const mySeq = ++seq.current;
    setError(null);
    setState((s) => summaryLoadStarted(s, taskId, mySeq));
    try {
      const result = await transport.invoke('task:diffSummary', taskId);
      setState((s) => {
        const prevDiffId = s.diffId;
        const next = summaryArrived(s, taskId, mySeq, result);
        if (next === s || next.summary?.status !== 'ok' || next.diffId === prevDiffId) return next;
        // A fresh diffId: seed the lazy-load set with the files that open by default
        // (`defaultExpanded`) — everything else stays collapsed until clicked.
        return defaultExpanded(next.summary.summary).reduce(
          (acc, path) => toggleExpanded(acc, path),
          next,
        );
      });
    } catch (e: unknown) {
      setState((s) => summaryFailed(s, taskId, mySeq));
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [transport, taskId]);

  // See the module header: reseeded on the SAME render the card id changes, not a tick
  // later in an effect, so the old card's diff never shows under the new card's header.
  const [renderedTaskId, setRenderedTaskId] = useState(taskId);
  if (taskId !== renderedTaskId) {
    setRenderedTaskId(taskId);
    setState((s) => summaryLoadStarted(s, taskId, s.applied));
    setError(null);
  }

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // A commit, a merge or a released tag all land through this one event — see
  // `GitGraphPane.tsx`'s own note on why a diff reloads on it rather than on a timer.
  useEffect(
    () =>
      transport.on('task:changed', (change) => {
        if (change.task.id === taskId) void loadSummary();
      }),
    [transport, taskId, loadSummary],
  );

  useEffect(() => {
    const diffId = state.diffId;
    if (diffId === null) return;
    for (const path of fetchablePaths(state)) {
      const mySeq = ++seq.current;
      setState((s) => fileLoadStarted(s, taskId, diffId, path, mySeq));
      void transport.invoke('task:diffFile', taskId, diffId, path).then(
        (result) => setState((s) => fileArrived(s, taskId, diffId, path, mySeq, result)),
        (e: unknown) =>
          setState((s) =>
            fileFailed(s, taskId, diffId, path, mySeq, e instanceof Error ? e.message : String(e)),
          ),
      );
    }
  }, [state, taskId, transport]);

  return (
    <ReviewPaneView
      taskId={taskId}
      state={state}
      error={error}
      onReload={() => void loadSummary()}
      onSelectFile={(path) => setState((s) => selectFile(s, path))}
      onToggleExpanded={(path) => setState((s) => toggleExpanded(s, path))}
    />
  );
}
