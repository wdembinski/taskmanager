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
 *
 * The list view opens with the v9-4/v9-5 header: a large "Inbox" title over a horizontally
 * scrolling chip row (`inboxFilter.ts` decides which kinds each chip shows). The chips are a
 * `radiogroup` of `radio` buttons — one is always selected, and arrow keys move between them —
 * and the selected one takes the inverted neutral fill, the others a `colorNeutralStroke2`
 * outline. The chip is local state: leaving the tab resets it to "Needs you", which is
 * everything.
 *
 * Each item is an `InboxCard` (`InboxCardView.tsx`): kind line, mono key + task title, the
 * question, and inline actions that go through the same `answer` (and the same `opened`) the
 * detail view uses — `inboxCard.ts` decides which actions a card offers. The key comes from a
 * `board:tasks` read, since an `AttentionItem` carries none.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Body1,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeftRegular, DismissRegular } from '@fluentui/react-icons';
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';
import type { TaskAttachment } from '@tm/shared/attachments';
import { InboxItem } from './Attention';
import { invokeAttentionAnswer } from './attentionAnswer';
import { questionDeadline, sortByUrgency } from './attentionUrgency';
import { CompactAnswerView } from './CompactAnswerView';
import { draftKey, parkDraft, readDraft } from './drafts';
import { InboxCard } from './InboxCardView';
import { runInboxCardAction, taskDisplayKey } from './inboxCard';
import { INBOX_CHIPS, filterInbox, type InboxChip } from './inboxFilter';
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
import { byTask } from './taskDetailHost';
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
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    paddingTop: '16px',
    flexShrink: 0,
  },
  /** The mockup's 30px/600 title, inset 20px from the screen edge. */
  title: {
    margin: 0,
    paddingLeft: '20px',
    paddingRight: '20px',
    fontSize: '30px',
    lineHeight: '38px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  /** Scrolls sideways rather than wrapping — the chip row is one line on any width. */
  chips: {
    display: 'flex',
    gap: '8px',
    overflowX: 'auto',
    paddingLeft: '20px',
    paddingRight: '20px',
    scrollbarWidth: 'none',
  },
  chip: {
    flexShrink: 0,
    height: '32px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightRegular,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '1px',
    },
  },
  chipSelected: {
    border: `1px solid ${tokens.colorNeutralBackgroundInverted}`,
    backgroundColor: tokens.colorNeutralBackgroundInverted,
    color: tokens.colorNeutralForegroundInverted,
    fontWeight: tokens.fontWeightSemibold,
    ':hover': { backgroundColor: tokens.colorNeutralBackgroundInverted },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    overflowY: 'auto',
    minHeight: 0,
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '12px 20px' },
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
  const [chip, setChip] = useState<InboxChip>('needs-you');
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A radiogroup's own keyboard contract: arrows move the selection (wrapping) and focus with it.
  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + INBOX_CHIPS.length) % INBOX_CHIPS.length;
    setChip(INBOX_CHIPS[next].id);
    chipRefs.current[next]?.focus();
  };

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

  // The files behind the open item's own run (`InboxItem`'s own `attachments` prop) — a
  // separate fetch from `seed`'s, same as the wide inbox's `useAttentionItems`, so a slow
  // attachment read never blocks the question itself.
  const [attachments, setAttachments] = useState<readonly TaskAttachment[]>([]);
  useEffect(() => {
    let live = true;
    void transport.invoke('attachment:list').then((v) => {
      if (live) setAttachments(v);
    });
    const off = transport.on('attachment:changed', (v) => {
      if (live) setAttachments(v);
    });
    return () => {
      live = false;
      off();
    };
  }, [transport]);
  const attachmentsByTask = useMemo(() => byTask(attachments), [attachments]);

  // Each card's mono ticket key — `AttentionItem` carries none, so it comes from the board.
  // Best-effort: a failed read leaves the map empty and the cards print the title alone.
  const [taskKeys, setTaskKeys] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    transport.invoke('board:tasks', 'all').then(
      (tasks) => {
        if (!live) return;
        const keys = new Map<string, string>();
        for (const task of tasks) {
          const key = taskDisplayKey(task);
          if (key) keys.set(task.id, key);
        }
        setTaskKeys(keys);
      },
      () => undefined,
    );
    const off = transport.on('task:changed', ({ task }) => {
      const key = taskDisplayKey(task);
      setTaskKeys((prev) => {
        if ((prev.get(task.id) ?? null) === key) return prev;
        const next = new Map(prev);
        if (key) next.set(task.id, key);
        else next.delete(task.id);
        return next;
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  const open = useCallback((id: string) => dispatch({ type: 'opened', id }), []);

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
            <InboxItem
              item={openItem}
              attachments={attachmentsByTask.get(openItem.taskId)}
              onAnswer={answer}
              onDismiss={dismiss}
            />
          )}
        </GlassPane>
      </div>
    );
  }

  const sorted = filterInbox(sortByUrgency(state.items, now), chip);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>Inbox</h1>
        <div role="radiogroup" aria-label="Filter" className={styles.chips}>
          {INBOX_CHIPS.map((c, index) => {
            const checked = c.id === chip;
            return (
              <button
                key={c.id}
                ref={(el) => {
                  chipRefs.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className={mergeClasses(styles.chip, checked && styles.chipSelected)}
                onClick={() => setChip(c.id)}
                onKeyDown={(e) => onChipKey(e, index)}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

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
          {chip === 'needs-you'
            ? 'Nothing needs you right now. When a task asks a question or hits a risky action, it appears here.'
            : 'Nothing here right now'}
        </Body1>
      ) : (
        <div className={styles.list}>
          {sorted.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              taskKey={taskKeys.get(item.taskId) ?? null}
              now={now}
              busy={state.answeringId === item.id}
              onOpen={() => open(item.id)}
              onAction={(action) => runInboxCardAction(item, action, { answer, open })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
