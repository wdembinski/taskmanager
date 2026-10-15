/**
 * Wires `dictationModel.ts`'s pure reducer to a real recognizer (F9.9) — the seam the model's
 * own header calls out as what F9.9 adds. Desktop is off until F9.10: `dictationAvailable`
 * already returns `{ available: false }` for `host === 'desktop'`, so this hook does too.
 *
 * `onCommit` fires exactly once per `insert`/`insert-and-send`, driven off `state.commit`
 * rather than called directly from {@link DictationHandle.insert} — the reducer is the one
 * source of truth for "a commit happened," and the effect is what lets the recognizer be
 * released (unbound, dropped) only after the caller has actually been told about it.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTransport } from '../transport';
import {
  dictationAvailable,
  dictationTooltip,
  type DictationVendor,
} from './dictationAvailability';
import {
  INITIAL_DICTATION,
  bindRecognizer,
  dictationReduce,
  type Recognizer,
} from './dictationModel';

export type DictationHandle =
  | { available: false }
  | {
      available: true;
      phase: 'idle' | 'recording';
      /** What has been finalized so far — shown plain; `interim` is shown muted beside it. */
      final: string;
      interim: string;
      error: string | null;
      blocked: boolean;
      elapsedMs: number;
      vendor: DictationVendor;
      tooltip: string;
      start(): void;
      cancel(): void;
      insert(send: boolean): void;
    };

/** One mic session's worth of state — mount once per control, not shared across controls. */
export function useDictation(
  onCommit: (commit: { text: string; send: boolean }) => void,
): DictationHandle {
  const transport = useTransport();
  const availability = useMemo(
    () =>
      dictationAvailable(
        transport.host ?? 'desktop',
        typeof window === 'undefined' ? undefined : window,
      ),
    [transport.host],
  );

  const [state, dispatch] = useReducer(dictationReduce, INITIAL_DICTATION);
  const recognizerRef = useRef<Recognizer | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  function releaseRecognizer(): void {
    unbindRef.current?.();
    unbindRef.current = null;
    recognizerRef.current = null;
  }

  function start(): void {
    if (!availability.available) return;
    const recognizer = availability.create();
    recognizerRef.current = recognizer;
    unbindRef.current = bindRecognizer(recognizer, dispatch);
    dispatch({ type: 'start' });
    try {
      recognizer.start();
    } catch (e) {
      dispatch({
        type: 'error',
        event: { error: e instanceof Error ? e.message : 'start-failed' },
      });
    }
  }

  function cancel(): void {
    recognizerRef.current?.abort();
    dispatch({ type: 'cancel' });
    releaseRecognizer();
  }

  function insert(send: boolean): void {
    recognizerRef.current?.stop();
    dispatch({ type: send ? 'insert-and-send' : 'insert' });
  }

  // The clock: a start timestamp plus a one-second tick, both torn down the moment the
  // phase leaves 'recording' — `cleanup` runs on every dependency change, including the
  // idle → recording → idle round trip this effect's dependency array tracks.
  useEffect(() => {
    if (state.phase !== 'recording') {
      setStartedAt(null);
      return;
    }
    const started = Date.now();
    setStartedAt(started);
    setNow(started);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.phase]);

  // A commit is consumed exactly once, here — not in `insert` itself — so the recognizer
  // stays alive (and bound) until the caller has actually been told the transcript.
  useEffect(() => {
    if (!state.commit) return;
    onCommitRef.current(state.commit);
    releaseRecognizer();
  }, [state.commit]);

  useEffect(() => {
    return () => {
      recognizerRef.current?.abort();
      releaseRecognizer();
    };
  }, []);

  if (!availability.available) return { available: false };

  return {
    available: true,
    phase: state.phase,
    final: state.final,
    interim: state.interim,
    error: state.error,
    blocked: state.blocked,
    elapsedMs: startedAt !== null ? now - startedAt : 0,
    vendor: availability.vendor,
    tooltip: dictationTooltip(availability.vendor),
    start,
    cancel,
    insert,
  };
}
