/**
 * The compact Inbox's (F3.3) full-screen touch answer view (F3.4) for the three kinds that
 * are worth a dedicated screen rather than the generic `InboxItem` form: `agent-question`,
 * `permission`, and `plan-approval`. The other four kinds (`question`, `merge-conflict`,
 * `task-failed`, `proposal`) keep using `InboxItem` as-is — they are already a plain
 * approve/reply shape with nothing to gain from a tap-first redesign.
 *
 * `agent-question` is driven straight from `answerDraft.ts`'s reducer rather than
 * `AgentQuestionForm`: a phone answers one option at a time (`tapOption`), not by filling a
 * whole form and pressing one "Send", and a single, unambiguous tap sends itself. The draft
 * is parked under the item's id on every unmount — opening another item, hitting "Back", or
 * switching tabs — and restored on the way back in, via `restoreAnswerDraft`/`parkAnswerDraft`.
 *
 * `permission`/`plan-approval` are the same approve/deny-with-a-note shape `InboxItem`
 * already renders, just touch-sized; the note itself is a `useDraft` under the SAME key
 * (`draftKey(item.id, 'note')`) `InboxItem` uses, so nothing is lost if a layout change ever
 * put both in front of the same item.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { AttentionAnswer, AttentionItem, AttentionQuestion } from '@tm/shared/attention';
import {
  initialDraft,
  isComplete,
  parkAnswerDraft,
  permissionDecision,
  planDecision,
  restoreAnswerDraft,
  sendFailed,
  sendStarted,
  sendSucceeded,
  submission,
  tapOption,
  typed,
  type AnswerDraftState,
} from './answerDraft';
import { KindBadge } from './Attention';
import { questionDeadline } from './attentionUrgency';
import { Markdown } from './chat/MarkdownView';
import { formatCountdown } from './countdown';
import { draftKey, useDraft } from './drafts';
import { GlassPane } from './shell/GlassPane';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  prompt: {
    padding: '10px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: '320px',
    overflowY: 'auto',
  },
  reason: { color: tokens.colorNeutralForeground3 },
  question: { display: 'flex', flexDirection: 'column', gap: '8px' },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '1px 7px',
    borderRadius: '4px',
  },
  questionText: { fontWeight: 600 },
  hint: { color: tokens.colorNeutralForeground3 },
  options: { display: 'flex', flexDirection: 'column', gap: '6px' },
  // 44px: the same touch-target minimum `CompactInbox`'s rows and `BottomTabBar` use.
  option: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minHeight: '44px',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit',
  },
  optionChosen: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  optionWhy: { color: tokens.colorNeutralForeground3 },
  decide: { display: 'flex', flexDirection: 'column', gap: '10px' },
  // The bar wrapping this view's primary buttons — `actionBar` is the `GlassPane`, `actions`
  // just the flex row inside it, so a wider caller (none today) could still use the flex row
  // without the pane.
  actionBar: { padding: '12px' },
  actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  // Fluent's largest Button size is 40px tall — 4px under the 44px touch-target floor every
  // other control on this screen already clears (`option`, `row` above). These three are the
  // ones a human actually sends an answer or a plan decision with, so they get it explicitly
  // rather than inheriting whatever Fluent's biggest built-in size happens to be.
  primaryAction: { minHeight: '44px' },
});

/**
 * The `agent-question` draft, restored for `itemId` on mount and parked back on every
 * unmount — a tab switch or "Back" included. Keyed on `itemId` alone, like `useDraft`: an
 * item's `questions` never change while its id does, so there is nothing to gain from also
 * depending on it, and doing so would re-run the restore on every re-render instead of once.
 */
function useAnswerDraftState(
  itemId: string,
  questions: readonly AttentionQuestion[] | undefined,
): [AnswerDraftState, (next: AnswerDraftState) => void] {
  const qs = questions ?? [];
  const [draft, setDraft] = useState<AnswerDraftState>(
    () => restoreAnswerDraft(itemId, qs) ?? initialDraft(qs),
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setDraft(restoreAnswerDraft(itemId, qs) ?? initialDraft(qs));
    return () => parkAnswerDraft(itemId, draftRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  return [draft, setDraft];
}

export interface CompactAnswerViewProps {
  item: AttentionItem;
  /** The clock `CompactInbox` already ticks for its own countdowns — not owned here. */
  now: number;
  onAnswer: (id: string, answer: AttentionAnswer) => Promise<void>;
  /** The chat-fallback channel for a question that expired before it was answered. */
  onChat: (message: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}

/** The agent-question half of the view: a draft reducer driving tap-first chips. */
function AnswerQuestions({
  item,
  now,
  onAnswer,
  onChat,
}: Pick<CompactAnswerViewProps, 'item' | 'now' | 'onAnswer' | 'onChat'>): JSX.Element {
  const styles = useStyles();
  const questions = item.questions ?? [];
  const [draft, setDraft] = useAnswerDraftState(item.id, questions);
  const expired = questionDeadline(item, now)?.kind === 'expired';
  const busy = draft.phase === 'sending';

  const send = async (toSend: AnswerDraftState): Promise<void> => {
    const result = submission(questions, toSend, expired);
    if (!result) return;
    setDraft(sendStarted(toSend));
    try {
      if (result.kind === 'chat') {
        await onChat(result.message);
      } else {
        await onAnswer(item.id, result.answer);
      }
      setDraft(sendSucceeded(toSend));
    } catch (e) {
      setDraft(sendFailed(toSend, e instanceof Error ? e.message : String(e)));
    }
  };

  const tap = (qi: number, label: string): void => {
    if (busy) return;
    const { state, autoSend } = tapOption(draft, questions, qi, label, expired);
    setDraft(state);
    if (autoSend) void send(state);
  };

  return (
    <div className={styles.question}>
      {expired && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This question timed out — your answer will be sent as a chat message instead.
          </MessageBarBody>
        </MessageBar>
      )}
      {questions.map((q, qi) => (
        <div key={`${qi}-${q.header}`} className={styles.question}>
          {q.header && <span className={styles.chip}>{q.header}</span>}
          <div className={styles.questionText}>
            <Markdown source={q.question} />
          </div>
          {q.multiSelect && <Caption1 className={styles.hint}>Choose as many as apply.</Caption1>}
          <div className={styles.options}>
            {q.options.map((opt) => {
              const chosen = draft.selections[qi]?.includes(opt.label) ?? false;
              return (
                <button
                  key={opt.label}
                  type="button"
                  aria-pressed={chosen}
                  disabled={busy}
                  className={`${styles.option} ${chosen ? styles.optionChosen : ''}`}
                  onClick={() => tap(qi, opt.label)}
                >
                  <Text weight={chosen ? 'semibold' : 'regular'}>{opt.label}</Text>
                  {opt.description && (
                    <Caption1 className={styles.optionWhy}>{opt.description}</Caption1>
                  )}
                </button>
              );
            })}
          </div>
          <Textarea
            value={draft.freeText[qi] ?? ''}
            resize="vertical"
            disabled={busy}
            placeholder="Answer in your own words…"
            onChange={(_e, d) => setDraft(typed(draft, qi, d.value))}
          />
        </div>
      ))}

      {draft.error && (
        <MessageBar intent="error">
          <MessageBarBody>{draft.error}</MessageBarBody>
        </MessageBar>
      )}

      <GlassPane className={mergeClasses(styles.actionBar, styles.actions)}>
        <Button
          appearance="primary"
          size="large"
          className={styles.primaryAction}
          disabled={busy || !isComplete(questions, draft)}
          onClick={() => void send(draft)}
        >
          {draft.phase === 'failed' ? 'Try again' : 'Send answer'}
        </Button>
      </GlassPane>
    </div>
  );
}

/** The permission/plan-approval half of the view: approve, or deny with an optional note. */
function AnswerDecision({
  item,
  onAnswer,
}: Pick<CompactAnswerViewProps, 'item' | 'onAnswer'>): JSX.Element {
  const styles = useStyles();
  const note = useDraft(draftKey(item.id, 'note'), '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPlan = item.kind === 'plan-approval';

  const decide = async (answer: AttentionAnswer): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(item.id, answer);
      note.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deny = (): void => {
    const decision = isPlan
      ? planDecision('request-changes', note.value)
      : permissionDecision(false, note.value);
    if (decision) void decide(decision);
  };

  return (
    <div className={styles.decide}>
      {isPlan && item.plan && (
        <div className={styles.prompt}>
          <Markdown source={item.plan} />
        </div>
      )}
      {isPlan && (item.steps?.length ?? 0) > 0 && (
        <Caption1 className={styles.reason}>
          Steps: {item.steps!.map((s, i) => `${i + 1}. ${s}`).join(' · ')}
        </Caption1>
      )}
      {!isPlan && item.reason && (
        <Caption1 className={styles.reason}>Held because it {item.reason}.</Caption1>
      )}
      <Textarea
        value={note.value}
        resize="vertical"
        disabled={busy}
        placeholder={
          isPlan
            ? 'Guidance to file on the card, or the reason to re-plan…'
            : 'Add guidance (optional)…'
        }
        onChange={(_e, d) => note.set(d.value)}
      />
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <GlassPane className={mergeClasses(styles.actionBar, styles.actions)}>
        <Button
          appearance="primary"
          size="large"
          className={styles.primaryAction}
          disabled={busy}
          onClick={() =>
            void decide(
              isPlan ? planDecision('approve', note.value)! : permissionDecision(true, note.value),
            )
          }
        >
          {isPlan ? 'Approve plan' : 'Approve'}
        </Button>
        <Button
          size="large"
          className={styles.primaryAction}
          disabled={busy || (isPlan && note.value.trim().length === 0)}
          onClick={deny}
        >
          {isPlan ? 'Re-plan' : 'Deny'}
        </Button>
      </GlassPane>
    </div>
  );
}

export function CompactAnswerView({
  item,
  now,
  onAnswer,
  onChat,
  onDismiss,
}: CompactAnswerViewProps): JSX.Element {
  const styles = useStyles();
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const deadline = questionDeadline(item, now);

  const dismiss = async (): Promise<void> => {
    setDismissBusy(true);
    setDismissError(null);
    try {
      await onDismiss(item.id);
    } catch (e) {
      setDismissError(e instanceof Error ? e.message : String(e));
    } finally {
      setDismissBusy(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <KindBadge kind={item.kind} />
        <Text weight="semibold" truncate wrap={false} className={styles.grow}>
          {item.taskTitle}
        </Text>
        <Button
          size="large"
          appearance="subtle"
          icon={<DismissRegular />}
          disabled={dismissBusy}
          title="Dismiss — clear this item without answering it"
          aria-label="Dismiss"
          onClick={() => void dismiss()}
        />
      </div>

      {dismissError && (
        <MessageBar intent="error">
          <MessageBarBody>{dismissError}</MessageBarBody>
        </MessageBar>
      )}

      {deadline && deadline.kind === 'counting' && (
        <Caption1 className={styles.reason}>
          Expires in {formatCountdown(deadline.remainingMs)}
        </Caption1>
      )}

      <div className={styles.prompt}>
        <Markdown source={item.prompt} />
      </div>

      {item.kind === 'agent-question' ? (
        <AnswerQuestions item={item} now={now} onAnswer={onAnswer} onChat={onChat} />
      ) : (
        <AnswerDecision item={item} onAnswer={onAnswer} />
      )}
    </div>
  );
}
