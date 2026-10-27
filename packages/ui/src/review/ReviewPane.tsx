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
import {
  taskSubjectId,
  type DiffSide,
  type DiffStale,
  type ReviewComment,
  type ReviewCommentInput,
  type ReviewCommentSent,
} from '@tm/shared/review';
import { useTransport } from '../transport';
import {
  cancelSelection,
  clickLine,
  closeEditor,
  commentDeleted,
  commentOnSelection,
  commentSaved,
  commentsArrived,
  commentsLoadStarted,
  editDraft,
  editNote,
  EMPTY_REVIEW,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  openExistingDraft,
  reviewSent,
  saveRefused,
  saveStarted,
  selectFile,
  sendStarted,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  tapLine,
  toggleExpanded,
  type ReviewState,
} from './reviewState';
import { defaultExpanded, fetchablePaths } from './reviewView';
import { ReviewPaneView } from './ReviewPaneView';
import { useReviewWorkspaceOpener } from './reviewWorkspaceOpener';

export interface ReviewPaneProps {
  taskId: string;
  /**
   * Set when the desktop host cannot be reached — `TaskDetail`'s own `hostUnreachable`
   * (F6.13). While set: the file-fetch effect and the `task:changed` reload both stop, so
   * whatever `state` is already on screen is the last thing this pane actually loaded, not a
   * fetch stuck mid-flight. Clearing it reloads the summary once, the same way a fresh mount
   * would.
   */
  unreachable?: string;
  /** `'compact'` for the compact full-screen card screen's own Changes tab (F3.8); `undefined`
   * (wide) everywhere else — carried straight through to {@link ReviewPaneView}. */
  layout?: 'wide' | 'compact';
}

export function ReviewPane({ taskId, unreachable, layout }: ReviewPaneProps): JSX.Element {
  const transport = useTransport();
  // The host's way into the review workspace (F15.14b) — `null` with no provider, which is
  // what keeps the button off a host that never mounts the workspace.
  const opener = useReviewWorkspaceOpener();
  const [state, setState] = useState<ReviewState>(EMPTY_REVIEW);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Whether the diff shows syntax colour at all (F15.11) — read once and kept live, the
  // same shape `TaskAgentPanel`'s own `appAutoIntegrate` uses for a global switch an open
  // pane must not show yesterday's answer to.
  const [monochrome, setMonochrome] = useState(false);
  useEffect(() => {
    let alive = true;
    void transport
      .invoke('settings:get')
      .then((s) => alive && setMonochrome(s.monochromeCode))
      .catch(() => undefined);
    const off = transport.on('settings:changed', (next) => setMonochrome(next.monochromeCode));
    return () => {
      alive = false;
      off();
    };
  }, [transport]);

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
  // `GitGraphPane.tsx`'s own note on why a diff reloads on it rather than on a timer. Skipped
  // while `unreachable` is set: a card the desktop cannot hear from has nothing new to reload,
  // and the whole point is to keep the last loaded state on screen rather than refetch against
  // a host that will not answer.
  useEffect(
    () =>
      transport.on('task:changed', (change) => {
        if (unreachable !== undefined) return;
        if (change.task.id === taskId) void loadSummary();
      }),
    [transport, taskId, loadSummary, unreachable],
  );

  // Reload once the host becomes reachable again — the same read a fresh mount would do, now
  // that there is reason to believe it will actually land.
  const wasUnreachable = useRef(unreachable !== undefined);
  useEffect(() => {
    const isUnreachable = unreachable !== undefined;
    if (wasUnreachable.current && !isUnreachable) void loadSummary();
    wasUnreachable.current = isUnreachable;
  }, [unreachable, loadSummary]);

  useEffect(() => {
    if (unreachable !== undefined) return;
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
  }, [state, taskId, transport, unreachable]);

  const loadComments = useCallback(async () => {
    const mySeq = ++seq.current;
    setState((s) => commentsLoadStarted(s, taskId, mySeq));
    try {
      const comments = await transport.invoke('review:list', taskId);
      setState((s) => commentsArrived(s, taskId, mySeq, comments));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [transport, taskId]);

  // On mount, on a new diffId (the server recomputes `outdated` against whatever is
  // current, regardless of which diffId is passed — see `ReviewService.list`), and after
  // `review:send` below.
  useEffect(() => {
    void loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, state.diffId]);

  function onClickLine(path: string, side: DiffSide, line: number, shift: boolean): void {
    setState((s) => clickLine(s, { path, side, line }, shift));
  }

  function onTapLine(path: string, side: DiffSide, line: number): void {
    setState((s) => tapLine(s, { path, side, line }));
  }

  function onCancelSelection(): void {
    setState((s) => cancelSelection(s));
  }

  function onCommentSelection(): void {
    setState((s) => commentOnSelection(s));
  }

  function onEditDraft(text: string): void {
    setState((s) => editDraft(s, text));
  }

  function onCancel(): void {
    setState((s) => closeEditor(s));
  }

  function onEdit(comment: ReviewComment): void {
    setState((s) => openExistingDraft(s, comment));
  }

  function onDelete(id: string): void {
    void transport.invoke('review:delete', taskId, id).then((result) => {
      if (result.status === 'ok') setState((s) => commentDeleted(s, taskId, id));
    });
  }

  function onSave(): void {
    const editor = state.editor;
    if (editor === null) return;
    setState((s) => saveStarted(s));

    function accept(comment: ReviewComment): void {
      setState((s) => commentSaved(s, taskId, comment));
    }
    function refuse(result: DiffStale | ReviewCommentSent | { error: string }): void {
      setState((s) => saveRefused(s, taskId, result));
    }
    function onError(e: unknown): void {
      refuse({ error: e instanceof Error ? e.message : String(e) });
    }

    if (editor.commentId !== undefined) {
      void transport
        .invoke('review:update', taskId, editor.commentId, { body: editor.draft })
        .then(
          (result) => (result.status === 'ok' ? accept(result.comment) : refuse(result)),
          onError,
        );
      return;
    }
    if (state.diffId === null) return;
    const input: ReviewCommentInput = {
      taskId,
      diffId: state.diffId,
      path: editor.path,
      side: editor.anchor.side,
      line: editor.anchor.line,
      body: editor.draft,
      ...(editor.start ? { start: editor.start } : {}),
    };
    void transport
      .invoke('review:add', input)
      .then(
        (result) => (result.status === 'ok' ? accept(result.comment) : refuse(result)),
        onError,
      );
  }

  function onEditNote(text: string): void {
    setState((s) => editNote(s, text));
  }

  function onSend(): void {
    setState((s) => sendStarted(s));
    const note = state.note.trim() ? state.note : undefined;
    void transport.invoke('review:send', taskId, note).then(
      (result) => {
        setState((s) => reviewSent(s, taskId, result));
        void loadComments();
      },
      (e: unknown) => {
        setState((s) => (s.taskId === taskId ? { ...s, sending: false } : s));
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }

  return (
    <ReviewPaneView
      taskId={taskId}
      state={state}
      error={error}
      unreachable={unreachable}
      layout={layout}
      monochrome={monochrome}
      onReload={() => void loadSummary()}
      onOpenInWorkspace={opener ? () => opener.open(taskSubjectId(taskId)) : undefined}
      onSelectFile={(path) => setState((s) => selectFile(s, path))}
      onToggleExpanded={(path) => setState((s) => toggleExpanded(s, path))}
      onClickLine={onClickLine}
      onTapLine={onTapLine}
      onCancelSelection={onCancelSelection}
      onCommentSelection={onCommentSelection}
      onEditDraft={onEditDraft}
      onSave={onSave}
      onCancel={onCancel}
      onEdit={onEdit}
      onDelete={onDelete}
      onEditNote={onEditNote}
      onSend={onSend}
    />
  );
}
