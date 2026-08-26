/**
 * Attention inbox (Phase 4).
 *
 * The one place a human is asked to unblock a task. Two kinds of item land here:
 *
 *   - **permission** — Claude wants to do something the risk policy won't
 *     auto-approve (git push, a delete, anything touching secrets). Approve or
 *     Deny; either way a short message is pushed back into the live session.
 *   - **question** — Claude asked for information. Type an answer and Send.
 *
 * Answering calls `attention:answer`, which pushes the reply into the SAME
 * session (no restart) and returns the task to `running`. Items arrive/leave live
 * over `attention:new` / `attention:resolved`, so the inbox never polls.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Field,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';
import { AgentQuestionForm } from './AgentQuestionForm';
import { Markdown } from './chat/MarkdownView';
import { PaneLoading } from './PaneLoading';
import { useTransport } from './transport';
import { useInitialLoad } from './useInitialLoad';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', minHeight: 0 },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  // Rendered markdown, so monospace appears inside code rather than over everything.
  prompt: {
    padding: '10px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: '420px',
    overflowY: 'auto',
  },
  reason: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
  note: { flex: 1 },
  choices: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  orFreeText: { color: tokens.colorNeutralForeground3, marginTop: '2px' },
  path: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    wordBreak: 'break-all',
    color: tokens.colorNeutralForeground2,
  },
  empty: { color: tokens.colorNeutralForeground3 },
  dismissError: { marginTop: '-4px' },
});

function KindBadge({ kind }: { kind: AttentionItem['kind'] }): JSX.Element {
  if (kind === 'permission') {
    return (
      <Badge appearance="tint" color="severe">
        permission
      </Badge>
    );
  }
  if (kind === 'merge-conflict') {
    return (
      <Badge appearance="tint" color="danger">
        merge conflict
      </Badge>
    );
  }
  if (kind === 'task-failed') {
    return (
      <Badge appearance="tint" color="danger">
        task failed
      </Badge>
    );
  }
  if (kind === 'proposal') {
    return (
      <Badge appearance="tint" color="brand">
        proposal
      </Badge>
    );
  }
  if (kind === 'plan-approval') {
    return (
      <Badge appearance="tint" color="brand">
        plan
      </Badge>
    );
  }
  if (kind === 'agent-question') {
    return (
      <Badge appearance="tint" color="warning">
        choose
      </Badge>
    );
  }
  return (
    <Badge appearance="tint" color="warning">
      question
    </Badge>
  );
}

/** One inbox card: shows the ask and collects the answer. */
function InboxItem({
  item,
  onAnswer,
  onDismiss,
}: {
  item: AttentionItem;
  onAnswer: (id: string, answer: AttentionAnswer) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}): JSX.Element {
  const styles = useStyles();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const answer = async (a: AttentionAnswer): Promise<void> => {
    setBusy(true);
    try {
      await onAnswer(item.id, a);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (): Promise<void> => {
    setBusy(true);
    setDismissError(null);
    try {
      await onDismiss(item.id);
    } catch (e) {
      setDismissError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.item}>
      <div className={styles.head}>
        <KindBadge kind={item.kind} />
        <Text weight="semibold" truncate wrap={false} className={styles.grow}>
          {item.taskTitle}
        </Text>
        <Caption1 className={styles.reason}>
          {new Date(item.createdAt).toLocaleTimeString()}
        </Caption1>
        {/* A merge-conflict item must be resolved or abandoned below, not dropped —
            the scheduler refuses it, so don't offer a button that would just error. */}
        {item.kind !== 'merge-conflict' && (
          <Button
            size="small"
            appearance="subtle"
            icon={<DismissRegular />}
            disabled={busy}
            title="Dismiss — clear this item without answering it"
            aria-label="Dismiss"
            onClick={() => void dismiss()}
          />
        )}
      </div>

      {dismissError && (
        <MessageBar intent="error" className={styles.dismissError}>
          <MessageBarBody>{dismissError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.prompt}>
        <Markdown source={item.prompt} />
      </div>
      {item.reason && <Caption1 className={styles.reason}>Held because it {item.reason}.</Caption1>}
      {item.kind === 'plan-approval' && (item.steps?.length ?? 0) > 0 && (
        <Caption1 className={styles.reason}>
          Steps: {item.steps!.map((s, i) => `${i + 1}. ${s}`).join(' · ')}
        </Caption1>
      )}
      {(item.kind === 'merge-conflict' || item.kind === 'task-failed') && item.worktreePath && (
        <Caption1 className={styles.path} title={item.worktreePath}>
          Worktree: {item.worktreePath}
        </Caption1>
      )}

      {/* The structured form, so the inbox and the card's pane offer the same thing —
          answering in one place and getting a different form in the other would make it
          look like they were two different asks. */}
      {item.kind === 'agent-question' && (item.questions?.length ?? 0) > 0 ? (
        <AgentQuestionForm
          questions={item.questions!}
          busy={busy}
          onAnswer={(a) => void answer(a)}
        />
      ) : item.kind === 'task-failed' || item.kind === 'proposal' ? (
        <>
          <div className={styles.choices}>
            {item.options.map((option) => (
              <Button
                key={option}
                appearance={option === item.options[0] ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() =>
                  void answer({ decision: 'reply', text: option, note: note.trim() || undefined })
                }
              >
                {option}
              </Button>
            ))}
          </div>
          <Field
            className={styles.note}
            label={
              item.kind === 'proposal'
                ? 'Optional note to the team'
                : 'Optional note (used by “AI fix & retry”)'
            }
          >
            <Textarea
              value={note}
              resize="vertical"
              onChange={(_e, d) => setNote(d.value)}
              placeholder={
                item.kind === 'proposal' ? 'Extra guidance…' : 'Extra guidance for a retry…'
              }
            />
          </Field>
        </>
      ) : item.kind === 'merge-conflict' ? (
        <div className={styles.actions}>
          <div className={styles.note} />
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void answer({ decision: 'approve' })}
          >
            Resolved — finish merge
          </Button>
          <Button disabled={busy} onClick={() => void answer({ decision: 'deny' })}>
            Abandon
          </Button>
        </div>
      ) : item.kind === 'permission' || item.kind === 'plan-approval' ? (
        <div className={styles.actions}>
          <Field
            className={styles.note}
            label={item.kind === 'plan-approval' ? 'Optional note' : 'Optional note to Claude'}
          >
            <Textarea
              value={note}
              resize="vertical"
              onChange={(_e, d) => setNote(d.value)}
              placeholder={
                item.kind === 'plan-approval'
                  ? 'Guidance to file on the card, or the reason to re-plan…'
                  : 'Add guidance (optional)…'
              }
            />
          </Field>
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void answer({ decision: 'approve', note: note.trim() || undefined })}
          >
            {item.kind === 'plan-approval' ? 'Approve plan' : 'Approve'}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void answer({ decision: 'deny', note: note.trim() || undefined })}
          >
            {item.kind === 'plan-approval' ? 'Re-plan' : 'Deny'}
          </Button>
        </div>
      ) : (
        <>
          {item.options.length > 0 && (
            <div className={styles.choices}>
              {item.options.map((option) => (
                <Button
                  key={option}
                  disabled={busy}
                  onClick={() => void answer({ decision: 'reply', text: option })}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Field
              className={styles.note}
              label={item.options.length > 0 ? 'Or answer in your own words' : 'Your answer'}
            >
              <Textarea
                value={note}
                resize="vertical"
                onChange={(_e, d) => setNote(d.value)}
                placeholder="Type your reply…"
              />
            </Field>
            <Button
              appearance="primary"
              disabled={busy || note.trim().length === 0}
              onClick={() => void answer({ decision: 'reply', text: note.trim() })}
            >
              Send
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function Attention(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  const seed = useCallback(
    async () => setItems(await transport.invoke('attention:list')),
    [transport],
  );
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offNew = transport.on('attention:new', (item) => {
      setItems((prev) => {
        const rest = (prev ?? []).filter((i) => i.id !== item.id);
        return [...rest, item].sort((a, b) => a.createdAt - b.createdAt);
      });
    });
    const offResolved = transport.on('attention:resolved', ({ id }) => {
      setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    });

    return () => {
      offNew();
      offResolved();
    };
  }, [transport]);

  const answer = async (id: string, a: AttentionAnswer): Promise<void> => {
    await transport.invoke('attention:answer', id, a);
    // The engine will also emit `attention:resolved`; remove now for a snappy UI.
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
  };

  const dismiss = async (id: string): Promise<void> => {
    await transport.invoke('attention:dismiss', id);
    // Throws (and leaves the item in place) if the channel refuses it — see InboxItem.
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
  };

  if (items === null) {
    return (
      <PaneLoading
        label="Loading inbox…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  if (items.length === 0) {
    return (
      <Body1 className={styles.empty}>
        Nothing needs you right now. When a task asks a question or hits a risky action, it appears
        here.
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      {items.map((item) => (
        <InboxItem key={item.id} item={item} onAnswer={answer} onDismiss={dismiss} />
      ))}
    </div>
  );
}
