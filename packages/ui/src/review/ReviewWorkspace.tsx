/**
 * The review workspace (F15.14): a full-screen place to read a pull request or an agent card's
 * diff. Wires `reviewState.ts`'s pure transitions to the subject-keyed `review:*` channels
 * (F15.10), then hands the result to {@link ReviewWorkspaceView} to draw — the same split
 * `ReviewPane` makes for a card's Changes pane, and modelled on it line for line.
 *
 * **`ReviewState.taskId` holds the selected row's `subjectId`.** `reviewState.ts` keys every
 * guard on `taskId`, but only ever compares it for equality, so any string works as the
 * frontier key — here it is the `subjectId` (`task:…` or `pr:…`), which is what lets one state
 * machine serve both kinds of subject without changing it. The one visible consequence:
 * `setViewed`'s optimistic mark is built with `subjectId: taskSubjectId(s.taskId)`, so it reads
 * `task:<subjectId>` in memory. That is harmless — `viewedState` never reads `mark.subjectId`,
 * and the `review:setViewed` answer replaces the marks wholesale through `viewedArrived` right
 * after. Every call over the wire carries the REAL `subjectId`; comments, which are still
 * task-keyed (F15.4 not done), carry the row's real `taskId`.
 *
 * **Marks are filtered here.** `viewedArrived` expects the caller to have filtered marks down to
 * its own subject (`viewedState`'s contract), so every answer goes through {@link ownMarks}
 * first.
 *
 * **Comments only for a card.** A row with a `taskId` loads `review:list(taskId)` and sends its
 * comment calls to the task channels; a PR row has no comments here and is read only.
 *
 * **One counter, every race**, as in `ReviewPane`: `seq` is shared by the summary, every file,
 * the viewed marks, the comments and every context read.
 *
 * **Switching subjects resets in the same render that starts showing the new one** — the same
 * `renderedTaskId` trick `ReviewPane` uses, so the old subject's diff never shows for a frame
 * under the new subject's header.
 *
 * **The file-fetch effect re-runs on every `state` change**, self-limiting through
 * `fetchablePaths` exactly as `ReviewPane`'s does.
 *
 * **A host can steer a mounted workspace** (F15.14b): a changed `initialSubjectId` selects that
 * row — now when the queues hold it, else as soon as an answer does — and each new
 * `actionRequest.seq` runs one key action exactly as its key would (the palette's commands).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { makeStyles } from '@fluentui/react-components';
import {
  formatReviewMessage,
  type DiffSide,
  type DiffStale,
  type ReviewComment,
  type ReviewCommentInput,
  type ReviewCommentPatch,
  type ReviewCommentSent,
  type ReviewQueue,
  type ReviewQueueItem,
  type ReviewQueuesSnapshot,
  type ReviewViewedMark,
} from '@tm/shared/review';
import { useTransport } from '../transport';
import { applyReviewKey, reviewKeyAction, type ReviewKeyAction } from './reviewKeys';
import {
  clickLine,
  closeEditor,
  commentDeleted,
  commentSaved,
  commentsArrived,
  commentsLoadStarted,
  contextArrived,
  contextFailed,
  contextLoadStarted,
  contextRequest,
  draftDecided,
  editDraft,
  EMPTY_REVIEW,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  gapBounds,
  openExistingDraft,
  reviewSent,
  saveRefused,
  saveStarted,
  selectFile,
  sendableDrafts,
  sendStarted,
  setViewed,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  toggleExpanded,
  toggleShowDismissed,
  viewedArrived,
  viewedLoadStarted,
  viewedStatuses,
  type ReviewState,
} from './reviewState';
import { defaultExpanded, fetchablePaths } from './reviewView';
import { forgeUrlFor, QUEUE_ORDER, queuesAsOfNotice } from './reviewWorkspaceModel';
import { ReviewWorkspaceView } from './ReviewWorkspaceView';
import { useDiffLayout } from './useDiffLayout';

const useStyles = makeStyles({
  // The one keydown listener's element: fills the host, takes focus without drawing a ring.
  root: { height: '100%', minHeight: 0, outlineStyle: 'none' },
});

export interface ReviewWorkspaceProps {
  /** The row to open first; the first row in `QUEUE_ORDER` when unset or not in the queues.
   *  Changing it later selects the new row — see the module header. */
  initialSubjectId?: string;
  /** Set when the desktop host cannot be reached — `ReviewPane`'s own `unreachable`: file
   *  fetches and queue-driven reloads stop, the view draws its warning and reads only, and
   *  clearing it reloads once. */
  unreachable?: string;
  /** Escape with no comment editor open. */
  onClose?: () => void;
  /** Overrides {@link forgeUrlFor} for *Open on forge* (F15.14b knows a GitLab host). */
  forgeUrl?: (item: ReviewQueueItem) => string | null;
  /** Runs `action` as if its key were pressed, once per new `seq` (the palette's commands). */
  actionRequest?: ReviewActionRequest;
}

/** See {@link ReviewWorkspaceProps.actionRequest}: bump `seq` to run the same action again. */
export interface ReviewActionRequest {
  action: ReviewKeyAction;
  seq: number;
}

/** How often the "Queues as of …" caption re-reads the clock. */
const AS_OF_TICK_MS = 30_000;

/** The marks that belong to `subjectId` — see the module header. */
function ownMarks(marks: readonly ReviewViewedMark[], subjectId: string): ReviewViewedMark[] {
  return marks.filter((m) => m.subjectId === subjectId);
}

/** The row to open when nothing is selected yet. */
function defaultSubject(snapshot: ReviewQueuesSnapshot, initial?: string): string | null {
  if (initial !== undefined && snapshot.items.some((i) => i.subjectId === initial)) return initial;
  for (const queue of QUEUE_ORDER) {
    const first = snapshot.items.find((i) => i.queue === queue);
    if (first) return first.subjectId;
  }
  return null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ReviewWorkspace({
  initialSubjectId,
  unreachable,
  onClose,
  forgeUrl,
  actionRequest,
}: ReviewWorkspaceProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [queues, setQueues] = useState<ReviewQueuesSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<readonly ReviewQueue[]>([]);
  const [keysOpen, setKeysOpen] = useState(false);
  const [state, setState] = useState<ReviewState>(EMPTY_REVIEW);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useDiffLayout('split');
  const seq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = queues?.items.find((i) => i.subjectId === selectedId) ?? null;
  const subjectId = selected?.subjectId ?? null;
  const taskId = selected?.taskId ?? null;

  // Whether the diff shows syntax colour at all (F15.11) — exactly as `ReviewPane` reads it.
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

  // The clock the "Queues as of …" caption compares against, re-read every half minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AS_OF_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ── Queues ────────────────────────────────────────────────────────────────────────────────

  // A host-requested subject not yet in the queues, taken by the first answer that holds it.
  const pendingSubject = useRef<string | null>(null);

  const acceptQueues = useCallback(
    (snapshot: ReviewQueuesSnapshot) => {
      setQueues(snapshot);
      const pending = pendingSubject.current;
      if (pending !== null && snapshot.items.some((i) => i.subjectId === pending)) {
        pendingSubject.current = null;
        setSelectedId(pending);
        return;
      }
      setSelectedId((current) => current ?? defaultSubject(snapshot, initialSubjectId));
    },
    [initialSubjectId],
  );

  // Follow a changed `initialSubjectId` — the first value is `defaultSubject`'s to use.
  const lastInitial = useRef(initialSubjectId);
  useEffect(() => {
    if (lastInitial.current === initialSubjectId) return;
    lastInitial.current = initialSubjectId;
    if (initialSubjectId === undefined) return;
    if (queues?.items.some((i) => i.subjectId === initialSubjectId)) {
      pendingSubject.current = null;
      setSelectedId(initialSubjectId);
    } else {
      pendingSubject.current = initialSubjectId;
    }
  }, [initialSubjectId, queues]);

  const loadQueues = useCallback(
    async (refresh: boolean) => {
      try {
        const snapshot = await transport.invoke(refresh ? 'review:refreshQueues' : 'review:queues');
        acceptQueues(snapshot);
      } catch (e: unknown) {
        setError(message(e));
      }
    },
    [transport, acceptQueues],
  );

  useEffect(() => {
    void loadQueues(false);
  }, [loadQueues]);

  useEffect(
    () =>
      transport.on('review:queues:changed', (snapshot) => {
        if (unreachable !== undefined) return;
        acceptQueues(snapshot);
      }),
    [transport, acceptQueues, unreachable],
  );

  // ── The selected subject's summary and viewed marks ──────────────────────────────────────

  const loadSummary = useCallback(async () => {
    if (subjectId === null) return;
    const mySeq = ++seq.current;
    setError(null);
    setState((s) => summaryLoadStarted(s, subjectId, mySeq));
    try {
      const result = await transport.invoke('review:subjectSummary', subjectId);
      setState((s) => {
        const prevDiffId = s.diffId;
        const next = summaryArrived(s, subjectId, mySeq, result);
        if (next === s || next.summary?.status !== 'ok') return next;
        const files = next.summary.summary.files;
        // A fresh diffId: seed the lazy-load set with the files that open by default.
        const seeded =
          next.diffId === prevDiffId
            ? next
            : defaultExpanded(next.summary.summary).reduce(
                (acc, path) => toggleExpanded(acc, path),
                next,
              );
        // Nothing selected yet: the first file the DIFF draws (summary order), so the tree's
        // highlight names the file on screen — the tree sorts its groups by path, so its own
        // first row can be a file the diff draws much further down. After the seeding, or its
        // toggle would collapse the file this just opened.
        if (seeded.selectedPath !== null) return seeded;
        const first = files[0]?.path;
        return first === undefined ? seeded : selectFile(seeded, first);
      });
    } catch (e: unknown) {
      setState((s) => summaryFailed(s, subjectId, mySeq));
      setError(message(e));
    }
  }, [transport, subjectId]);

  const loadViewed = useCallback(async () => {
    if (subjectId === null) return;
    const mySeq = ++seq.current;
    setState((s) => viewedLoadStarted(s, subjectId, mySeq));
    try {
      const marks = await transport.invoke('review:viewed', subjectId);
      setState((s) => viewedArrived(s, subjectId, mySeq, ownMarks(marks, subjectId)));
    } catch (e: unknown) {
      setError(message(e));
    }
  }, [transport, subjectId]);

  // See the module header: reseeded on the SAME render the subject changes.
  const [renderedSubjectId, setRenderedSubjectId] = useState(subjectId);
  if (subjectId !== renderedSubjectId) {
    setRenderedSubjectId(subjectId);
    setState((s) =>
      subjectId === null ? EMPTY_REVIEW : summaryLoadStarted(s, subjectId, s.applied),
    );
    setError(null);
  }

  useEffect(() => {
    void loadSummary();
    void loadViewed();
  }, [loadSummary, loadViewed]);

  // The queues are this screen's `task:changed`: a row whose head moved has a new diff to read.
  const headSha = selected?.headSha ?? null;
  const lastHead = useRef<{ subjectId: string | null; headSha: string | null }>({
    subjectId,
    headSha,
  });
  useEffect(() => {
    const last = lastHead.current;
    lastHead.current = { subjectId, headSha };
    if (last.subjectId === subjectId && last.headSha !== headSha) void loadSummary();
  }, [subjectId, headSha, loadSummary]);

  // Reload once the host becomes reachable again — the read a fresh mount would do.
  const wasUnreachable = useRef(unreachable !== undefined);
  useEffect(() => {
    const isUnreachable = unreachable !== undefined;
    if (wasUnreachable.current && !isUnreachable) {
      void loadQueues(false);
      void loadSummary();
      void loadViewed();
    }
    wasUnreachable.current = isUnreachable;
  }, [unreachable, loadQueues, loadSummary, loadViewed]);

  useEffect(() => {
    if (unreachable !== undefined || subjectId === null) return;
    const diffId = state.diffId;
    if (diffId === null) return;
    for (const path of fetchablePaths(state)) {
      const mySeq = ++seq.current;
      setState((s) => fileLoadStarted(s, subjectId, diffId, path, mySeq));
      void transport.invoke('review:subjectFile', subjectId, diffId, path).then(
        (result) => setState((s) => fileArrived(s, subjectId, diffId, path, mySeq, result)),
        (e: unknown) => setState((s) => fileFailed(s, subjectId, diffId, path, mySeq, message(e))),
      );
    }
  }, [state, subjectId, transport, unreachable]);

  // ── Comments (a card only) ────────────────────────────────────────────────────────────────

  const loadComments = useCallback(async () => {
    if (subjectId === null || taskId === null) return;
    const mySeq = ++seq.current;
    setState((s) => commentsLoadStarted(s, subjectId, mySeq));
    try {
      const comments = await transport.invoke('review:list', taskId);
      setState((s) => commentsArrived(s, subjectId, mySeq, comments));
    } catch (e: unknown) {
      setError(message(e));
    }
  }, [transport, subjectId, taskId]);

  // On a new subject, on a new diffId, and after `review:send` below — as `ReviewPane`.
  useEffect(() => {
    void loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId, taskId, state.diffId]);

  function onClickLine(path: string, side: DiffSide, line: number, shift: boolean): void {
    if (taskId === null || unreachable !== undefined) return;
    setState((s) => clickLine(s, { path, side, line }, shift));
  }

  function onDelete(id: string): void {
    if (subjectId === null || taskId === null) return;
    void transport.invoke('review:delete', taskId, id).then((result) => {
      if (result.status === 'ok') setState((s) => commentDeleted(s, subjectId, id));
    });
  }

  /** Keep/Dismiss/Restore on an AI draft: stamped locally first, then reconciled with the
   * server's answer — or, when it refuses or fails, with a fresh read of the comments. */
  function onDecide(id: string, decision: NonNullable<ReviewCommentPatch['decision']>): void {
    if (subjectId === null || taskId === null || unreachable !== undefined) return;
    const key = subjectId;
    setState((s) => draftDecided(s, key, id, decision, Date.now()));
    void transport.invoke('review:update', taskId, id, { decision }).then(
      (result) => {
        if (result.status === 'ok') setState((s) => commentSaved(s, key, result.comment));
        else void loadComments();
      },
      () => void loadComments(),
    );
  }

  function onSave(): void {
    const editor = state.editor;
    if (editor === null || subjectId === null || taskId === null) return;
    const key = subjectId;
    setState((s) => saveStarted(s));

    function accept(comment: ReviewComment): void {
      setState((s) => commentSaved(s, key, comment));
    }
    function refuse(result: DiffStale | ReviewCommentSent | { error: string }): void {
      setState((s) => saveRefused(s, key, result));
    }
    function onError(e: unknown): void {
      refuse({ error: message(e) });
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

  function onSend(): void {
    if (subjectId === null || taskId === null || unreachable !== undefined) return;
    const key = subjectId;
    setState((s) => sendStarted(s));
    const note = state.note.trim() ? state.note : undefined;
    void transport.invoke('review:send', taskId, note).then(
      (result) => {
        setState((s) => reviewSent(s, key, result));
        void loadComments();
      },
      (e: unknown) => {
        setState((s) => (s.taskId === key ? { ...s, sending: false } : s));
        setError(message(e));
      },
    );
  }

  // ── Copy review as Markdown and Open on forge (a PR only) ─────────────────────────────────

  const summary = state.summary?.status === 'ok' ? state.summary.summary : null;
  const markdown = summary === null ? '' : formatReviewMessage([...sendableDrafts(state)], summary);

  function onCopyMarkdown(): void {
    if (markdown === '') return;
    void navigator.clipboard.writeText(markdown).catch((e: unknown) => setError(message(e)));
  }

  const forgeHref = selected === null ? null : (forgeUrl ?? forgeUrlFor)(selected);

  // ── Viewed ────────────────────────────────────────────────────────────────────────────────

  /** Sends one viewed toggle — already applied locally — and reconciles with the answer. */
  function saveViewed(path: string, viewed: boolean): void {
    if (subjectId === null || summary === null) return;
    const entry = summary.files.find((f) => f.path === path);
    if (entry === undefined) return;
    if (viewed && entry.newBlobSha === undefined) return;
    const blobSha = viewed ? (entry.newBlobSha ?? null) : null;
    const key = subjectId;
    const mySeq = ++seq.current;
    setState((s) => viewedLoadStarted(s, key, mySeq));
    void transport.invoke('review:setViewed', key, path, blobSha).then(
      (marks) => setState((s) => viewedArrived(s, key, mySeq, ownMarks(marks, key))),
      (e: unknown) => setError(message(e)),
    );
  }

  function onToggleViewed(path: string): void {
    const viewed = viewedStatuses(state).byPath[path] !== 'viewed';
    setState((s) => setViewed(s, path, viewed, Date.now()));
    saveViewed(path, viewed);
  }

  // ── Context expansion (the `e` key) ───────────────────────────────────────────────────────

  function expandSelectedContext(): void {
    if (subjectId === null || summary === null) return;
    if (summary.capabilities?.expandContext === false) return;
    const path = state.selectedPath;
    const diffId = state.diffId;
    if (path === null || diffId === null) return;
    const load = state.files[path];
    if (load?.status !== 'loaded' || load.file.hunks.length === 0) return;
    // The gap right before the current hunk — the context a reader on that hunk wants first.
    const gap = Math.min(state.hunkIndex ?? 0, load.file.hunks.length - 1);
    const { low, high } = gapBounds(load.file, gap);
    if (low >= high) return;
    const { side, from, to } = contextRequest(load.file, gap, 'step');
    if (from > to) return;
    const key = subjectId;
    const mySeq = ++seq.current;
    setState((s) => contextLoadStarted(s, key, diffId, path, gap, mySeq));
    void transport.invoke('review:context', key, diffId, path, side, from, to).then(
      (result) => setState((s) => contextArrived(s, key, diffId, path, low, mySeq, result)),
      (e: unknown) => setState((s) => contextFailed(s, key, diffId, path, low, mySeq, message(e))),
    );
  }

  /** The `c` key: opens the editor on the current hunk's first changed line. */
  function commentOnCurrentHunk(): void {
    if (taskId === null || state.selectedPath === null) return;
    const load = state.files[state.selectedPath];
    if (load?.status !== 'loaded') return;
    const hunk = load.file.hunks[state.hunkIndex ?? 0];
    const line = hunk?.lines.find((l) => l.kind !== 'context') ?? hunk?.lines[0];
    if (line === undefined) return;
    const path = state.selectedPath;
    if (line.newLine !== undefined) onClickLine(path, 'new', line.newLine, false);
    else if (line.oldLine !== undefined) onClickLine(path, 'old', line.oldLine, false);
  }

  // ── Keys: one listener, on this screen's root ─────────────────────────────────────────────

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** One key action — a key press or a host's {@link ReviewActionRequest}. */
  function runAction(action: ReviewKeyAction): void {
    switch (action) {
      case 'toggleLayout':
        setLayout(layout === 'split' ? 'unified' : 'split');
        return;
      case 'expandContext':
        expandSelectedContext();
        return;
      case 'comment':
        commentOnCurrentHunk();
        return;
      case 'showKeys':
        setKeysOpen(true);
        return;
      case 'escape':
        if (state.editor === null) {
          onClose?.();
          return;
        }
        break;
      case 'toggleViewed': {
        const path = state.selectedPath;
        if (path === null) return;
        const viewed = viewedStatuses(state).byPath[path] !== 'viewed';
        setState((s) => applyReviewKey(s, action, Date.now()));
        saveViewed(path, viewed);
        return;
      }
    }
    setState((s) => applyReviewKey(s, action, Date.now()));
  }

  // The latest `runAction`, so the request effect below keys on `seq` alone.
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  const handledSeq = useRef<number | null>(null);
  useEffect(() => {
    if (actionRequest === undefined || handledSeq.current === actionRequest.seq) return;
    handledSeq.current = actionRequest.seq;
    runActionRef.current(actionRequest.action);
  }, [actionRequest]);

  function onKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>): void {
    if (keysOpen) return;
    const action = reviewKeyAction(
      {
        key: evt.key,
        ctrlKey: evt.ctrlKey,
        metaKey: evt.metaKey,
        shiftKey: evt.shiftKey,
        altKey: evt.altKey,
        isComposing: evt.nativeEvent.isComposing,
        repeat: evt.repeat,
        target: evt.target as HTMLElement,
      },
      { editorOpen: state.editor !== null },
    );
    if (action === null) return;
    evt.preventDefault();
    runAction(action);
  }

  return (
    <div ref={rootRef} className={styles.root} tabIndex={-1} onKeyDown={onKeyDown}>
      <ReviewWorkspaceView
        queues={queues}
        selected={selected}
        state={state}
        error={error}
        layout={layout}
        monochrome={monochrome}
        collapsedGroups={collapsedGroups}
        copyEnabled={markdown !== ''}
        forgeUrl={forgeHref}
        keysOpen={keysOpen}
        unreachable={unreachable}
        asOfNotice={queues === null ? null : queuesAsOfNotice(queues, now)}
        onSelectSubject={(item) => setSelectedId(item.subjectId)}
        onToggleGroup={(queue) =>
          setCollapsedGroups((groups) =>
            groups.includes(queue) ? groups.filter((q) => q !== queue) : [...groups, queue],
          )
        }
        onRefresh={() => void loadQueues(true)}
        onReload={() => void loadSummary()}
        onSelectFile={(path) => setState((s) => selectFile(s, path))}
        onToggleExpanded={(path) => setState((s) => toggleExpanded(s, path))}
        onToggleViewed={onToggleViewed}
        onLayoutChange={setLayout}
        onSend={onSend}
        onCopyMarkdown={onCopyMarkdown}
        onCloseKeys={() => setKeysOpen(false)}
        onClickLine={onClickLine}
        onEditDraft={(text) => setState((s) => editDraft(s, text))}
        onSave={onSave}
        onCancel={() => setState((s) => closeEditor(s))}
        onEdit={(comment) => setState((s) => openExistingDraft(s, comment))}
        onDelete={onDelete}
        onAccept={(id) => onDecide(id, 'accept')}
        onDismiss={(id) => onDecide(id, 'dismiss')}
        onRestore={(id) => onDecide(id, 'restore')}
        onToggleShowDismissed={() => setState((s) => toggleShowDismissed(s))}
      />
    </div>
  );
}
