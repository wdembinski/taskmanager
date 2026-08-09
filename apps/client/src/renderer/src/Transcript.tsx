/**
 * Transcript — the live, scrolling view of one session's normalized events.
 *
 * Extracted from the Phase 1 Session view so BOTH the Scratch run and the Phase 3
 * Board render session output identically. Give it a `runId`; it subscribes to
 * `session:event`, keeps only the lines for that run, and auto-scrolls.
 *
 * Phase 6 adds persisted history: pass a `taskId` and it first loads that task's
 * recorded transcript (`task:history`) so past output is shown even when nothing
 * is live, then appends any live events for the current `runId` on top. Without a
 * `taskId` (the Scratch run) it stays live-only and resets whenever the run
 * changes.
 *
 * An optional `onEvent` lets a parent also react to the raw events (the Scratch
 * view uses it to track status/cost) without re-subscribing.
 */
import { useEffect, useRef, useState } from 'react';
import { Body1, makeStyles, tokens } from '@fluentui/react-components';
import type { SessionEvent } from '@shared/session';

const useStyles = makeStyles({
  transcript: {
    flex: 1,
    minHeight: '200px',
    overflowY: 'auto',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
  },
  line: { marginBottom: '2px' },
  meta: { color: tokens.colorNeutralForeground3 },
  assistant: { color: tokens.colorNeutralForeground1 },
  tool: { color: tokens.colorPaletteBlueForeground2 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  err: { color: tokens.colorPaletteRedForeground1 },
});

/** One rendered transcript line, with a style class chosen by kind. */
export interface TranscriptLine {
  cls: 'meta' | 'assistant' | 'tool' | 'warn' | 'err';
  text: string;
}

/** Shorten long thinking snippets so the transcript stays readable. */
function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Translate one normalized session event into the transcript line(s) it produces. */
export function eventToLines(event: SessionEvent): TranscriptLine[] {
  switch (event.kind) {
    case 'started':
      return [
        {
          cls: 'meta',
          text: `▶ session ${event.sessionId} · ${event.model} · ${event.permissionMode}`,
        },
      ];
    case 'thinking':
      return [{ cls: 'meta', text: `  ·thinking· ${truncate(event.text)}` }];
    case 'assistant':
      return [{ cls: 'assistant', text: event.text }];
    case 'tool-use':
      return [{ cls: 'tool', text: `  ⚙ ${event.name}` }];
    case 'tool-result':
      return [{ cls: 'tool', text: `  ⚙ result${event.isError ? ' (error)' : ''}` }];
    case 'usage':
      // Token accounting is surfaced on the Performance dashboard, not inline here.
      return [];
    case 'rate-limit':
      if (event.status === 'allowed') return [];
      return [
        {
          cls: 'warn',
          text: `⏳ usage limit (${event.rateLimitType}) — resets ${
            event.resetsAt ? new Date(event.resetsAt * 1000).toLocaleTimeString() : 'unknown'
          }`,
        },
      ];
    case 'result':
      return [
        {
          cls: event.success ? 'meta' : 'err',
          text: `■ ${event.terminalReason ?? event.stopReason ?? 'done'}${
            event.costUsd != null ? ` · $${event.costUsd.toFixed(4)}` : ''
          }`,
        },
      ];
    case 'stderr':
      return [{ cls: 'err', text: event.text.trimEnd() }];
    case 'exited':
      return [];
  }
}

export interface TranscriptProps {
  /** The run whose LIVE events to display, or null when nothing is running. */
  runId: string | null;
  /**
   * The task whose persisted history to load and replay (Phase 6). When set, past
   * output is shown even with no live run; omit it for the live-only Scratch view.
   */
  taskId?: string | null;
  /** Optional observer for the raw events of the current run (status/cost, etc.). */
  onEvent?: (event: SessionEvent) => void;
  /** Message shown when there is nothing to display yet. */
  emptyHint?: string;
}

export function Transcript({ runId, taskId, onEvent, emptyHint }: TranscriptProps): JSX.Element {
  const styles = useStyles();
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Kept in refs so the single event subscription always sees the latest values
  // without needing to re-subscribe on every render.
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Load a selected task's recorded transcript (Phase 6). If live events arrive
  // while it loads, keep them: history is older, so it is prepended in front.
  useEffect(() => {
    if (!taskId) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLines([]);
    void window.api.invoke('task:history', taskId).then((events) => {
      if (cancelled) return;
      const history = events.flatMap(eventToLines);
      setLines((live) => [...history, ...live]);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Scratch run (no task): reset the log whenever the run changes.
  useEffect(() => {
    if (!taskId) setLines([]);
  }, [runId, taskId]);

  // Auto-scroll to the newest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Subscribe once; route only the current run's live events.
  useEffect(() => {
    return window.api.on('session:event', ({ runId: incoming, event }) => {
      if (incoming !== runIdRef.current) return;
      onEventRef.current?.(event);
      const produced = eventToLines(event);
      if (produced.length > 0) setLines((prev) => [...prev, ...produced]);
    });
  }, []);

  return (
    <div ref={scrollRef} className={styles.transcript}>
      {lines.length === 0 ? (
        <Body1 className={styles.meta}>{emptyHint ?? 'No output yet.'}</Body1>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`${styles.line} ${styles[line.cls]}`}>
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}
