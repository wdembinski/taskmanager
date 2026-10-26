/**
 * A card's open owner decision (`Task.decisionQuestion`), at the top of `TaskDetail` — the
 * question, a box to answer it in, and the two ways out: Answer (clears the flag and files the
 * answer as a local comment the next planning run reads) and Withdraw (the question no longer
 * stands). While it is up, the board never shows the card as ready and Start refuses it, so
 * this bar is the one place on the card that says why nothing is happening.
 *
 * Split the same way as `ArchivedTicketBanner`: `DecisionBannerView` is hook-free — the answer
 * box is controlled from outside — so `DecisionBanner.render.test.tsx` drives it directly
 * through `renderToStaticMarkup`; `DecisionBanner` owns the draft and the two channel calls,
 * and renders `null` for a card with no open decision (the common case).
 *
 * `compact` is the issue peek's form: one line — a glyph, "Decision needed · <question>"
 * ellipsized, and an Answer button that expands the full bar in place (with a Collapse link to
 * fold it again). The view stays hook-free, so the expanded flag lives in `DecisionBanner`;
 * only `IssuePeekBody` passes it, so the board pane and the full page are unchanged.
 *
 * `RaiseDecisionButton` is the other end: the "Needs a decision…" control that opens a small
 * dialog for the question and calls `task:setDecision`.
 *
 * Neither reloads anything on success: both channels push `task:changed`, and the host's own
 * listeners re-render the card without the flag. `onTaskChanged` is only the caller's chance
 * to apply the returned task at once rather than a round trip later.
 */
import { useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { QuestionCircleRegular } from '@fluentui/react-icons';
import type { Task } from '@tm/shared/model';
import { removedAgo } from './board/ArchivedCardsDialog';
import { useTransport } from './transport';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '6px', paddingBottom: '4px' },
  question: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  asked: { color: tokens.colorNeutralForeground3 },
  answer: { width: '100%' },
  error: { color: tokens.colorPaletteRedForeground1 },
  dialogField: { width: '100%' },
  compact: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
    padding: '4px 4px 4px 8px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  compactGlyph: { flexShrink: 0, fontSize: '16px', color: tokens.colorNeutralForeground3 },
  compactText: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  compactLabel: { fontWeight: tokens.fontWeightSemibold },
  compactButton: { flexShrink: 0 },
});

export interface DecisionBannerViewProps {
  question: string;
  /** Epoch ms the decision was raised (`Task.decisionAskedAt`); null prints no age line. */
  askedAt: number | null;
  /** "Now", passed in so the view stays pure. */
  now: number;
  answer: string;
  onAnswerChange: (text: string) => void;
  /** Absent hides the answer box and both buttons — a read-only host. */
  onAnswer?: () => void;
  onWithdraw?: () => void;
  busy: 'answer' | 'withdraw' | null;
  /** A refusal from either call, shown inside the same bar. */
  error: string | null;
  /** Render the one-line collapsed row instead of the bar — see this file's header. */
  compact?: boolean;
  /** The collapsed row's button: expand the full bar in place. */
  onExpand?: () => void;
  /** Present on an expanded compact bar: the "Collapse" link that folds it again. */
  onCollapse?: () => void;
}

/** The bar itself — hook-free, see this file's own header. */
export function DecisionBannerView({
  question,
  askedAt,
  now,
  answer,
  onAnswerChange,
  onAnswer,
  onWithdraw,
  busy,
  error,
  compact = false,
  onExpand,
  onCollapse,
}: DecisionBannerViewProps): JSX.Element {
  const styles = useStyles();
  const editable = Boolean(onAnswer);
  if (compact) {
    return (
      <div className={styles.compact} data-decision-banner="" data-compact="">
        <QuestionCircleRegular className={styles.compactGlyph} aria-hidden />
        <Text size={200} className={styles.compactText} title={question}>
          <span className={styles.compactLabel}>Decision needed</span> · {question}
        </Text>
        <Button size="small" className={styles.compactButton} onClick={onExpand}>
          {editable ? 'Answer' : 'Show'}
        </Button>
      </div>
    );
  }
  return (
    <MessageBar
      intent="warning"
      layout="multiline"
      icon={<QuestionCircleRegular />}
      data-decision-banner=""
    >
      <MessageBarBody className={styles.body}>
        <MessageBarTitle>Needs a decision</MessageBarTitle>
        <span className={styles.question}>{question}</span>
        {askedAt != null && (
          <Caption1 className={styles.asked}>
            Asked {removedAgo(askedAt, now)}. This card will not start until it is answered.
          </Caption1>
        )}
        {editable && (
          <Textarea
            className={styles.answer}
            aria-label="Your answer"
            placeholder="Your answer — it is filed on the card for the next planning run."
            resize="vertical"
            value={answer}
            disabled={busy !== null}
            onChange={(_e, d) => onAnswerChange(d.value)}
          />
        )}
        {error && <Caption1 className={styles.error}>{error}</Caption1>}
        {onCollapse && (
          <Link as="button" onClick={onCollapse}>
            Collapse
          </Link>
        )}
      </MessageBarBody>
      {editable && (
        <MessageBarActions>
          <Button
            size="small"
            appearance="primary"
            icon={busy === 'answer' ? <Spinner size="tiny" /> : undefined}
            disabled={busy !== null || !answer.trim()}
            onClick={onAnswer}
          >
            {busy === 'answer' ? 'Answering…' : 'Answer'}
          </Button>
          {onWithdraw && (
            <Button size="small" disabled={busy !== null} onClick={onWithdraw}>
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
            </Button>
          )}
        </MessageBarActions>
      )}
    </MessageBar>
  );
}

export interface DecisionBannerProps {
  task: Task;
  /** The updated card, straight from the channel — see this file's header. */
  onTaskChanged?: (task: Task) => void;
  /** After an answer lands: its comment is on the card's timeline now. */
  onAnswered?: () => void;
  readOnly?: boolean;
  /** Start as the one-line row that expands on click — the issue peek's form only. */
  compact?: boolean;
}

export function DecisionBanner({
  task,
  onTaskChanged,
  onAnswered,
  readOnly = false,
  compact = false,
}: DecisionBannerProps): JSX.Element | null {
  const transport = useTransport();
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'answer' | 'withdraw' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (task.decisionQuestion == null) return null;

  async function submit(): Promise<void> {
    if (!answer.trim()) return;
    setBusy('answer');
    setError(null);
    try {
      const result = await transport.invoke('task:answerDecision', task.id, answer.trim());
      setAnswer('');
      onTaskChanged?.(result.task);
      onAnswered?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(): Promise<void> {
    setBusy('withdraw');
    setError(null);
    try {
      onTaskChanged?.(await transport.invoke('task:setDecision', task.id, null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DecisionBannerView
      question={task.decisionQuestion}
      askedAt={task.decisionAskedAt ?? null}
      now={Date.now()}
      answer={answer}
      onAnswerChange={setAnswer}
      onAnswer={readOnly ? undefined : () => void submit()}
      onWithdraw={readOnly ? undefined : () => void withdraw()}
      busy={busy}
      error={error}
      compact={compact && !expanded}
      onExpand={() => setExpanded(true)}
      onCollapse={compact && expanded ? () => setExpanded(false) : undefined}
    />
  );
}

export interface RaiseDecisionButtonProps {
  task: Task;
  onTaskChanged?: (task: Task) => void;
}

/**
 * "Needs a decision…" — raise an owner decision on this card. Offered only while none is open
 * (the banner above is the place to change an open one: answer or withdraw it).
 */
export function RaiseDecisionButton({
  task,
  onTaskChanged,
}: RaiseDecisionButtonProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (task.decisionQuestion != null) return null;

  function close(): void {
    setOpen(false);
    setQuestion('');
    setError(null);
  }

  async function raise(): Promise<void> {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onTaskChanged?.(await transport.invoke('task:setDecision', task.id, question.trim()));
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="small"
        appearance="subtle"
        icon={<QuestionCircleRegular />}
        title="Hold this card until you have decided something — it will not start until you answer"
        onClick={() => setOpen(true)}
      >
        Needs a decision…
      </Button>
      <Dialog open={open} onOpenChange={(_e, d) => !d.open && close()}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Needs a decision</DialogTitle>
            <DialogContent>
              <Textarea
                className={styles.dialogField}
                aria-label="The question"
                placeholder="What has to be decided before this card can go ahead?"
                resize="vertical"
                value={question}
                disabled={busy}
                autoFocus
                onChange={(_e, d) => setQuestion(d.value)}
              />
              {error && <Caption1 className={styles.error}>{error}</Caption1>}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : undefined}
                disabled={busy || !question.trim()}
                onClick={() => void raise()}
              >
                {busy ? 'Saving…' : 'Hold the card'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
