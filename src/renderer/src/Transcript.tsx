/**
 * Transcript — the live, scrolling view of one session's normalized events.
 *
 * Extracted from the Phase 1 Session view so BOTH the Scratch run and the Phase 3
 * Board render session output identically. Give it a `runId`; it subscribes to
 * `session:event`, keeps only the lines for that run, and auto-scrolls. When the
 * `runId` changes (e.g. the Board selects a different task) it starts fresh.
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
  /** The run whose events to display, or null when nothing is selected/running. */
  runId: string | null;
  /** Optional observer for the raw events of the current run (status/cost, etc.). */
  onEvent?: (event: SessionEvent) => void;
  /** Message shown when there is nothing to display yet. */
  emptyHint?: string;
}

export function Transcript({ runId, onEvent, emptyHint }: TranscriptProps): JSX.Element {
  const styles = useStyles();
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Kept in refs so the single event subscription always sees the latest values
  // without needing to re-subscribe on every render.
  const runIdRef = useRef(runId);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Reset the log whenever we switch to a different run.
  useEffect(() => {
    runIdRef.current = runId;
    setLines([]);
  }, [runId]);

  // Auto-scroll to the newest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Subscribe once; route only the current run's events.
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
