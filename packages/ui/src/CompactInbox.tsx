/**
 * The compact Inbox screen (F3.3) — what the phone layout's Inbox tab shows instead of the
 * wide `Attention()` list. Same data, same answer/dismiss channels, a single scrolling list
 * sorted by `sortByUrgency`, and a tap-to-open full-screen detail instead of every item
 * expanded at once — the wide layout has room for that, a phone does not.
 *
 * The detail view itself is one of two things (F3.4): `CompactAnswerView` for the three kinds
 * worth a dedicated touch screen (`agent-question`, `permission`, `plan-approval`), and the
 * generic `InboxItem` (from `./Attention`, not redrawn) for the rest.
 *
 * State lives here, in a `useReducer(inboxReducer)` over `inboxState.ts`'s pure transitions —
 * see that file's header for why `answeringId` exists and what `notice` means. `answer`,
 * `dismiss`, and `chat` all route through the same `answerStarted`/`answerSucceeded`/
 * `answerFailed` cycle: from the reducer's point of view each is just an `invoke` that may or
 * may not carry an `AttentionAnswer`.
 *
 * `openId` is parked under its own draft key (`drafts.ts`) rather than only living in
 * `InboxState`, so leaving the Inbox tab and coming back — which unmounts this whole
 * component, unlike the wide board — reopens whatever was open rather than dropping back to
 * the list.
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
import { invokeAttentionAnswer } from './attentionAnswer';
import { questionDeadline, sortByUrgency } from './attentionUrgency';
import { CompactAnswerView } from './CompactAnswerView';
import { formatAge, formatCountdown } from './countdown';
import { draftKey, parkDraft, readDraft } from './drafts';
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
import { GlassPane } from './shell/GlassPane';
import { REFUSAL_HINT } from './taskChat';
import { useTransport } from './transport';
import { useInitialLoad } from './useInitialLoad';

/** The three kinds `CompactAnswerView` renders; every other kind keeps `InboxItem`. */
function isAnswerKind(kind: AttentionItem['kind']): boolean {
  return kind === 'agent-question' || kind === 'permission' || kind === 'plan-approval';
}

/** Where the open item's id is parked — one scope, not per-item, since the Inbox is a singleton. */
const OPEN_ID_KEY = draftKey('compact-inbox', 'openId');

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflowY: 'auto',
    minHeight: 0,
    height: '100%',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    overflowY: 'auto',
    minHeight: 0,
  },
  // Wraps each row's own `Button` — see the module header on why glass wraps rather than
  // replaces it (the 44px touch target and click behaviour stay the Button's).
  card: { padding: '12px' },
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
  detailPane: { padding: '12px' },
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
  const [state, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STATE, (base): InboxState => ({
    ...base,
    openId: readDraft<string>(OPEN_ID_KEY) ?? null,
  }));
  const [now, setNow] = useState(() => Date.now());

  // Survives this component unmounting — switching away from the Inbox tab and back, unlike
  // the wide board, tears the whole tree down. `seeded`/`resolved` already close the view (with
  // `ANSWERED_ELSEWHERE`) if the restored id is no longer present, so there is nothing else to
  // reconcile here.
  useEffect(() => {
    parkDraft(OPEN_ID_KEY, state.openId, state.openId !== null);
  }, [state.openId]);

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
        await invokeAttentionAnswer(transport, id, a);
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

  /**
   * The chat fallback for an `agent-question` that expired before it was answered (`CompactAnswerView`
   * decides when this is the right channel, not here). The relay's own tool call has already
   * timed out by then, so there is nothing left to approve/deny — once the message is delivered
   * the item is dismissed, the same as tapping the X on a question nobody can answer any more.
   */
  const chat = useCallback(
    async (id: string, taskId: string, message: string): Promise<void> => {
      dispatch({ type: 'answerStarted', id });
      try {
        const result = await transport.invoke('task:chat', taskId, message);
        if (result.status === 'refused') throw new Error(REFUSAL_HINT[result.reason]);
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
        <GlassPane className={styles.detailPane}>
          {isAnswerKind(openItem.kind) ? (
            <CompactAnswerView
              item={openItem}
              now={now}
              onAnswer={answer}
              onChat={(message) => chat(openItem.id, openItem.taskId, message)}
              onDismiss={dismiss}
            />
          ) : (
            <InboxItem item={openItem} onAnswer={answer} onDismiss={dismiss} />
          )}
        </GlassPane>
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
              <GlassPane key={item.id} className={styles.card}>
                <Button
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
              </GlassPane>
            );
          })}
        </div>
      )}
    </div>
  );
}
