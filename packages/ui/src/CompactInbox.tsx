/**
 * The compact Inbox screen (F3.3) — what the phone layout's Inbox tab shows instead of the
 * wide `Attention()` list. Same data, same answer/dismiss channels, same `InboxItem` form
 * (imported from `./Attention` rather than redrawn), but a single scrolling list sorted by
 * `sortByUrgency` and a tap-to-open full-screen detail instead of every item expanded at once
 * — the wide layout has room for that, a phone does not.
 *
 * State lives here, in a `useReducer(inboxReducer)` over `inboxState.ts`'s pure transitions —
 * see that file's header for why `answeringId` exists and what `notice` means. Both `answer`
 * and `dismiss` route through the same `answerStarted`/`answerSucceeded`/`answerFailed` cycle:
 * from the reducer's point of view a dismiss is just an `invoke` that happens not to carry an
 * `AttentionAnswer`.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeftRegular, DismissRegular } from '@fluentui/react-icons';
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';
import { InboxItem, KindBadge } from './Attention';
import { questionDeadline, sortByUrgency } from './attentionUrgency';
import { formatAge, formatCountdown } from './countdown';
import {
  EMPTY_INBOX_STATE,
  answerFailed,
  answerStarted,
  answerSucceeded,
  arrived,
  closed,
  noticeCleared,
  opened,
  resolved,
  seeded,
  type InboxState,
} from './inboxState';
import { PaneLoading } from './PaneLoading';
import { useTransport } from './transport';
import { useInitialLoad } from './useInitialLoad';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflowY: 'auto',
    minHeight: 0,
    height: '100%',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', minHeight: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '44px',
    width: '100%',
    justifyContent: 'flex-start',
    textAlign: 'left',
  },
  rowTitle: { flex: 1, minWidth: 0 },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '12px' },
  detail: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', minHeight: 0 },
  back: { alignSelf: 'flex-start' },
});

type InboxAction =
  | { type: 'seeded'; items: AttentionItem[] }
  | { type: 'arrived'; item: AttentionItem }
  | { type: 'resolved'; id: string }
  | { type: 'opened'; id: string }
  | { type: 'closed' }
  | { type: 'answerStarted'; id: string }
  | { type: 'answerSucceeded'; id: string }
  | { type: 'answerFailed'; id: string }
  | { type: 'noticeCleared' };

function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'seeded':
      return seeded(state, action.items);
    case 'arrived':
      return arrived(state, action.item);
    case 'resolved':
      return resolved(state, action.id);
    case 'opened':
      return opened(state, action.id);
    case 'closed':
      return closed(state);
    case 'answerStarted':
      return answerStarted(state, action.id);
    case 'answerSucceeded':
      return answerSucceeded(state, action.id);
    case 'answerFailed':
      return answerFailed(state, action.id);
    case 'noticeCleared':
      return noticeCleared(state);
  }
}

export function CompactInbox(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [state, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STATE);
  const [now, setNow] = useState(() => Date.now());

  const seed = useCallback(async () => {
    const items = await transport.invoke('attention:list');
    dispatch({ type: 'seeded', items });
  }, [transport]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offNew = transport.on('attention:new', (item) => dispatch({ type: 'arrived', item }));
    const offResolved = transport.on('attention:resolved', ({ id }) =>
      dispatch({ type: 'resolved', id }),
    );
    return () => {
      offNew();
      offResolved();
    };
  }, [transport]);

  const hasCountingItem = useMemo(
    () => (state.items ?? []).some((item) => questionDeadline(item, now)?.kind === 'counting'),
    [state.items, now],
  );

  useEffect(() => {
    if (!hasCountingItem) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasCountingItem]);

  const answer = useCallback(
    async (id: string, a: AttentionAnswer): Promise<void> => {
      dispatch({ type: 'answerStarted', id });
      try {
        await transport.invoke('attention:answer', id, a);
        dispatch({ type: 'answerSucceeded', id });
      } catch (e) {
        dispatch({ type: 'answerFailed', id });
        throw e;
      }
    },
    [transport],
  );

  const dismiss = useCallback(
    async (id: string): Promise<void> => {
      dispatch({ type: 'answerStarted', id });
      try {
        await transport.invoke('attention:dismiss', id);
        dispatch({ type: 'answerSucceeded', id });
      } catch (e) {
        dispatch({ type: 'answerFailed', id });
        throw e;
      }
    },
    [transport],
  );

  if (state.items === null) {
    return (
      <PaneLoading
        label="Loading inbox…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const openItem = state.items.find((item) => item.id === state.openId) ?? null;

  if (openItem) {
    return (
      <div className={styles.detail}>
        <Button
          appearance="subtle"
          icon={<ArrowLeftRegular />}
          className={styles.back}
          onClick={() => dispatch({ type: 'closed' })}
        >
          Back
        </Button>
        <InboxItem item={openItem} onAnswer={answer} onDismiss={dismiss} />
      </div>
    );
  }

  const sorted = sortByUrgency(state.items, now);

  return (
    <div className={styles.root}>
      {state.notice && (
        <MessageBar intent="info">
          <MessageBarBody>{state.notice}</MessageBarBody>
          <MessageBarActions
            containerAction={
              <Button
                appearance="transparent"
                icon={<DismissRegular />}
                aria-label="Dismiss"
                onClick={() => dispatch({ type: 'noticeCleared' })}
              />
            }
          />
        </MessageBar>
      )}

      {sorted.length === 0 ? (
        <Body1 className={styles.empty}>
          Nothing needs you right now. When a task asks a question or hits a risky action, it
          appears here.
        </Body1>
      ) : (
        <div className={styles.list}>
          {sorted.map((item) => {
            const deadline = questionDeadline(item, now);
            return (
              <Button
                key={item.id}
                appearance="subtle"
                className={styles.row}
                onClick={() => dispatch({ type: 'opened', id: item.id })}
              >
                <Text truncate wrap={false} className={styles.rowTitle}>
                  {item.taskTitle}
                </Text>
                <div className={styles.rowMeta}>
                  <KindBadge kind={item.kind} />
                  <Caption1>{formatAge(item.createdAt, now)}</Caption1>
                  {deadline && (
                    <Caption1>
                      {deadline.kind === 'expired'
                        ? 'expired'
                        : formatCountdown(deadline.remainingMs)}
                    </Caption1>
                  )}
                </div>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
