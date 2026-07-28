/**
 * The conversation itself (Phase 12, phase 5): the turns `turns.ts` folded, rendered.
 *
 * One bubble shape throughout — same radius, same padding, whoever wrote it. Side, fill
 * and the `JIRA` tag carry all the meaning; the shape carries none. The agent is the
 * exception on purpose: its turn is full width and unbubbled, because markdown tables
 * and fenced code need the width, and it is marked with the `AgentsRegular` glyph the
 * board card and the agent panel already use, so one symbol means "an agent" everywhere.
 */
import { useState } from 'react';
import {
  Badge,
  Caption1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AgentsRegular, ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { statusNoteColor, type StatusKeyword } from '@shared/statusKeywords';
import { Markdown } from './MarkdownView';
import type { Turn } from './turns';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  row: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
  mine: { alignItems: 'flex-end' },
  theirs: { alignItems: 'flex-start' },
  /** The one bubble shape. */
  bubble: {
    maxWidth: '82%',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusLarge,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minWidth: 0,
  },
  chat: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  /** A note nobody but you will ever read — the same blue, a shade back. */
  note: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  /**
   * A status update: a note with a rule down its edge in the keyword's colour. The
   * rule is always there (in the bubble's own fill when no keyword matched) so an
   * uncoloured update still lines up with a coloured one.
   */
  statusBubble: {
    borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  statusTag: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontSize: '10px',
    fontWeight: 600,
  },
  them: { backgroundColor: tokens.colorNeutralBackground4, color: tokens.colorNeutralForeground1 },
  meta: { color: tokens.colorNeutralForeground3 },
  err: { color: tokens.colorPaletteRedForeground1 },
  agent: { display: 'flex', gap: '8px', minWidth: 0 },
  agentGlyph: { color: tokens.colorBrandForeground1, display: 'flex', paddingTop: '2px' },
  agentBody: { flex: 1, minWidth: 0 },
  tools: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
  },
  toolList: { paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '2px' },
  time: { color: tokens.colorNeutralForeground4, fontSize: '11px' },
  tag: { alignSelf: 'flex-start' },
});

/** Format an epoch-ms timestamp compactly (e.g. "Jul 7, 14:05"). */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A folded run of tool work: one muted line, expandable, never expanded by default. */
function ToolRun({ turn }: { turn: Extract<Turn, { kind: 'tools' }> }): JSX.Element {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const detail = turn.labels.length > 0;
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.tools}
        onClick={() => detail && setOpen((v) => !v)}
        title={detail ? 'Show what it delegated' : undefined}
      >
        {detail && (open ? <ChevronDownRegular /> : <ChevronRightRegular />)}
        <Caption1 italic>
          Worked with {turn.count} tool{turn.count === 1 ? '' : 's'}
        </Caption1>
      </button>
      {open && (
        <div className={styles.toolList}>
          {turn.labels.map((label, i) => (
            <Caption1 key={i} className={styles.meta}>
              ↳ {label}
            </Caption1>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ChatTurnsProps {
  turns: Turn[];
  /** Remove a note (the only turn kind that is yours alone to unsay). */
  onDeleteNote?: (commentId: number) => void;
  /** The user's status-note vocabulary, so a past update reads in the colour it did. */
  statusKeywords?: readonly StatusKeyword[];
}

export function ChatTurns({ turns, onDeleteNote, statusKeywords }: ChatTurnsProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {turns.map((turn) => {
        if (turn.kind === 'you') {
          // A status update wears the keyword's colour as a left rule — the same signal
          // the board card shows, so scrolling back through the card's story reads the
          // way the board did at the time.
          const accent =
            turn.variant === 'status' ? statusNoteColor(turn.body, statusKeywords) : null;
          return (
            <div key={turn.key} className={mergeClasses(styles.row, styles.mine)}>
              <div
                className={mergeClasses(
                  styles.bubble,
                  turn.variant === 'note' || turn.variant === 'status' ? styles.note : styles.chat,
                  turn.variant === 'status' && styles.statusBubble,
                )}
                style={accent ? { borderLeftColor: accent } : undefined}
                onDoubleClick={
                  turn.commentId !== null && onDeleteNote
                    ? () => onDeleteNote(turn.commentId!)
                    : undefined
                }
                title={turn.commentId !== null ? 'Double-click to delete this note' : undefined}
              >
                {turn.variant === 'jira' && (
                  <Badge className={styles.tag} appearance="tint" color="warning" size="small">
                    JIRA
                  </Badge>
                )}
                {turn.variant === 'status' && (
                  <Caption1
                    className={styles.statusTag}
                    style={accent ? { color: accent } : undefined}
                  >
                    Status
                  </Caption1>
                )}
                {turn.body}
              </div>
              <Caption1 className={styles.time}>{fmtTime(turn.createdAt)}</Caption1>
            </div>
          );
        }
        if (turn.kind === 'them') {
          return (
            <div key={turn.key} className={mergeClasses(styles.row, styles.theirs)}>
              <Caption1 className={styles.meta}>{turn.author} · Jira</Caption1>
              <div className={mergeClasses(styles.bubble, styles.them)}>{turn.body}</div>
              <Caption1 className={styles.time}>{fmtTime(turn.createdAt)}</Caption1>
            </div>
          );
        }
        if (turn.kind === 'agent') {
          return (
            <div key={turn.key} className={styles.agent}>
              <span className={styles.agentGlyph} title="The agent">
                <AgentsRegular />
              </span>
              <div className={styles.agentBody}>
                <Markdown source={turn.text} />
              </div>
            </div>
          );
        }
        if (turn.kind === 'tools') return <ToolRun key={turn.key} turn={turn} />;
        return (
          <Text
            key={turn.key}
            className={turn.tone === 'err' ? styles.err : styles.meta}
            size={200}
          >
            {turn.text}
          </Text>
        );
      })}
    </div>
  );
}
