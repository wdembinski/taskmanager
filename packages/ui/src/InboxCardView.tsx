/**
 * One row of the phone Inbox (`CompactInbox`), drawn as v9-4/v9-5's rich card rather than a
 * title-plus-pill row: a kind line (a dot, the kind word, the age), the task's mono key and
 * title, the question itself as the card's title, and the inline actions that answer it
 * without opening anything (`inboxCard.ts` decides which).
 *
 * The header — kind line, key + title, question — is one button that opens the full-screen
 * detail view, the same tap target the old row was, so it still clears the 44px floor. The
 * actions sit outside it (a button can't nest buttons) and clear the same floor themselves.
 *
 * Colour stays in the dot: no `KindBadge` pill, and the only filled control is the one primary
 * action — colour is for what needs you, not for a label.
 *
 * `InboxCardBody` is hook-free on purpose: it takes its class names and handlers as props, so
 * `CompactInbox.render.test.tsx` can find a rendered action's own `onClick` and tap it without a
 * DOM. `InboxCard` is the thin stateful wrapper the inbox mounts.
 */
import { useState } from 'react';
import { Button, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { AttentionItem } from '@tm/shared/attention';
import { questionDeadline } from './attentionUrgency';
import { formatAge, formatCountdown } from './countdown';
import {
  inboxCardActions,
  inboxCardTitle,
  inboxKindTone,
  inboxKindWord,
  type InboxCardAction,
} from './inboxCard';
import { GlassPane } from './shell/GlassPane';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px 16px' },
  // A bare button: no chrome of its own, just the tap target over the card's text.
  head: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minHeight: '44px',
    width: '100%',
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'none',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '4px',
    },
  },
  kindLine: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  dotAttention: {
    backgroundColor: `var(--tm-attention, ${tokens.colorPaletteDarkOrangeForeground1})`,
  },
  dotDanger: { backgroundColor: tokens.colorStatusDangerForeground1 },
  kindWord: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  meta: { flexShrink: 0, color: tokens.colorNeutralForeground4 },
  keyLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    minWidth: 0,
    width: '100%',
  },
  key: {
    flexShrink: 0,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
  },
  taskTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  // The question is the card's headline — three lines at most, the rest is in the detail view.
  title: {
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    overflowWrap: 'anywhere',
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  // 44px: the touch-target floor every other Inbox control clears (`CompactAnswerView`).
  action: { minHeight: '44px', minWidth: '44px' },
  link: { color: tokens.colorBrandForeground1 },
  error: { color: tokens.colorStatusDangerForeground1 },
});

export type InboxCardClasses = ReturnType<typeof useStyles>;

export interface InboxCardBodyProps {
  item: AttentionItem;
  /** The task's display key (`taskDisplayKey`), or null when the board has none for it. */
  taskKey: string | null;
  now: number;
  /** True while this card's own answer is in flight — every action is disabled. */
  busy: boolean;
  /** The last inline answer's failure, shown under the actions until the next tap. */
  error: string | null;
  onOpen: () => void;
  onAction: (action: InboxCardAction) => void;
  classes: InboxCardClasses;
}

export function InboxCardBody({
  item,
  taskKey,
  now,
  busy,
  error,
  onOpen,
  onAction,
  classes,
}: InboxCardBodyProps): JSX.Element {
  const deadline = questionDeadline(item, now);
  const actions = inboxCardActions(item, deadline?.kind === 'expired');
  const kindWord = inboxKindWord(item.kind);
  return (
    <GlassPane className={classes.card} data-inbox-card={item.id}>
      <button type="button" className={classes.head} onClick={onOpen}>
        <span className={classes.kindLine}>
          <span
            aria-hidden
            className={mergeClasses(
              classes.dot,
              inboxKindTone(item.kind) === 'danger' ? classes.dotDanger : classes.dotAttention,
            )}
          />
          <span className={classes.kindWord}>{kindWord}</span>
          {deadline && (
            <Caption1 className={classes.meta}>
              {deadline.kind === 'expired' ? 'expired' : formatCountdown(deadline.remainingMs)}
            </Caption1>
          )}
          <Caption1 className={classes.meta}>{formatAge(item.createdAt, now)}</Caption1>
        </span>
        <span className={classes.keyLine}>
          {taskKey && <span className={classes.key}>{taskKey}</span>}
          <span className={classes.taskTitle}>{item.taskTitle}</span>
        </span>
        <span className={classes.title}>{inboxCardTitle(item)}</span>
      </button>
      <div className={classes.actions}>
        {actions.map((action) =>
          action.kind === 'answer' ? (
            <Button
              key={`answer:${action.label}`}
              shape="circular"
              appearance={action.primary ? 'primary' : 'outline'}
              className={classes.action}
              disabled={busy}
              onClick={() => onAction(action)}
            >
              {action.label}
            </Button>
          ) : (
            <Button
              key={`open:${action.label}`}
              shape="circular"
              appearance={action.link ? 'transparent' : 'outline'}
              className={mergeClasses(classes.action, action.link && classes.link)}
              disabled={busy}
              onClick={() => onAction(action)}
            >
              {action.label}
            </Button>
          ),
        )}
      </div>
      {error && (
        <Caption1 role="alert" className={classes.error}>
          {error}
        </Caption1>
      )}
    </GlassPane>
  );
}

export interface InboxCardProps {
  item: AttentionItem;
  taskKey: string | null;
  now: number;
  busy: boolean;
  onOpen: () => void;
  /** Resolves once the action is done; a rejection is shown on the card. */
  onAction: (action: InboxCardAction) => Promise<void>;
}

export function InboxCard({ onAction, ...rest }: InboxCardProps): JSX.Element {
  const classes = useStyles();
  const [error, setError] = useState<string | null>(null);
  const act = (action: InboxCardAction): void => {
    setError(null);
    onAction(action).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return <InboxCardBody {...rest} error={error} onAction={act} classes={classes} />;
}
