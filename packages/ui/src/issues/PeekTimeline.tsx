/**
 * The peek's conversation, after `v9-1-issues-list-light.svg`: an 18px initials circle, the
 * name in semibold and a faint age ("12m"), then the body as plain text underneath — no
 * bubble, no fill, no border. The board pane and the full page keep `ChatTurns`' bubbles; the
 * peek is a narrow column read beside the list, where a stack of blue bubbles was the loudest
 * thing on screen.
 *
 * Read-only: deleting a note stays on the full page. Tool runs and transcript lines (`tools`,
 * `system`) fold to one muted caption each — what happened, not a turn of its own.
 */
import { Avatar, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { seedInitials } from '@tm/shared/tickets';
import { AgentGlyph } from '../AgentGlyph';
import { Markdown } from '../chat/MarkdownView';
import { RichComment } from '../chat/RichComment';
import type { Turn } from '../chat/turns';
import { formatAge } from '../countdown';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 },
  turn: {
    display: 'grid',
    gridTemplateColumns: '18px minmax(0, 1fr)',
    columnGap: '8px',
    rowGap: '2px',
    minWidth: 0,
  },
  avatar: {
    gridColumn: '1',
    gridRow: '1',
    alignSelf: 'center',
    width: '18px',
    height: '18px',
    fontSize: '9px',
  },
  agentAvatar: {
    gridColumn: '1',
    gridRow: '1',
    alignSelf: 'center',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
  },
  head: { gridColumn: '2', display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 },
  name: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  age: { color: tokens.colorNeutralForeground4, flexShrink: 0 },
  body: {
    gridColumn: '2',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: '12.5px',
  },
  /** The agent's prose is markdown — its own block layout, not pre-wrapped text. */
  markdown: { gridColumn: '2', minWidth: 0, overflowWrap: 'anywhere' },
  caption: { color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})` },
});

export interface PeekTimelineProps {
  /** The conversation, already folded (`foldTurns`). */
  turns: readonly Turn[];
  /** The clock the ages are measured against — the peek's own ticking `now`. */
  now?: number;
}

/** Who wrote a turn, as the peek names them. */
function authorOf(turn: Extract<Turn, { kind: 'you' | 'them' | 'agent' }>): string {
  if (turn.kind === 'them') return turn.author;
  return turn.kind === 'you' ? 'You' : 'Agent';
}

export function PeekTimeline({ turns, now = Date.now() }: PeekTimelineProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root} data-peek-timeline>
      {turns.map((turn) => {
        if (turn.kind === 'tools') {
          return (
            <Caption1 key={turn.key} className={styles.caption} data-peek-turn="tools">
              Worked with {turn.count} tool{turn.count === 1 ? '' : 's'}
            </Caption1>
          );
        }
        if (turn.kind === 'system') {
          return (
            <Caption1 key={turn.key} className={styles.caption} data-peek-turn="system">
              {turn.text}
            </Caption1>
          );
        }
        const author = authorOf(turn);
        return (
          <div key={turn.key} className={styles.turn} data-peek-turn={turn.kind}>
            {turn.kind === 'agent' ? (
              <span className={styles.agentAvatar} aria-hidden>
                <AgentGlyph size="12px" />
              </span>
            ) : (
              <Avatar
                className={styles.avatar}
                name={author}
                initials={seedInitials(author)}
                color="neutral"
                size={20}
                aria-hidden
              />
            )}
            <div className={styles.head}>
              <Text size={200} className={styles.name}>
                {author}
              </Text>
              <Caption1 className={styles.age}>{formatAge(turn.createdAt, now)}</Caption1>
            </div>
            {turn.kind === 'agent' ? (
              <div className={styles.markdown}>
                <Markdown source={turn.text} />
              </div>
            ) : turn.rich?.length ? (
              <div className={styles.markdown}>
                <RichComment blocks={turn.rich} attachments={turn.attachments} />
              </div>
            ) : (
              <Text className={styles.body}>{turn.body}</Text>
            )}
          </div>
        );
      })}
    </div>
  );
}
