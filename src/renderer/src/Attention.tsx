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
import { useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Field,
  makeStyles,
  Spinner,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import type { AttentionAnswer, AttentionItem } from '@shared/attention';

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
  prompt: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    padding: '8px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
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
}: {
  item: AttentionItem;
  onAnswer: (id: string, answer: AttentionAnswer) => Promise<void>;
}): JSX.Element {
  const styles = useStyles();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const answer = async (a: AttentionAnswer): Promise<void> => {
    setBusy(true);
    try {
      await onAnswer(item.id, a);
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
      </div>

      <div className={styles.prompt}>{item.prompt}</div>
      {item.reason && <Caption1 className={styles.reason}>Held because it {item.reason}.</Caption1>}
      {item.kind === 'merge-conflict' && item.worktreePath && (
        <Caption1 className={styles.path} title={item.worktreePath}>
          Worktree: {item.worktreePath}
        </Caption1>
      )}

      {item.kind === 'merge-conflict' ? (
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
      ) : item.kind === 'permission' ? (
        <div className={styles.actions}>
          <Field className={styles.note} label="Optional note to Claude">
            <Textarea
              value={note}
              resize="vertical"
              onChange={(_e, d) => setNote(d.value)}
              placeholder="Add guidance (optional)…"
            />
          </Field>
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void answer({ decision: 'approve', note: note.trim() || undefined })}
          >
            Approve
          </Button>
          <Button
            disabled={busy}
            onClick={() => void answer({ decision: 'deny', note: note.trim() || undefined })}
          >
            Deny
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
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  useEffect(() => {
    void window.api.invoke('attention:list').then(setItems);

    const offNew = window.api.on('attention:new', (item) => {
      setItems((prev) => {
        const rest = (prev ?? []).filter((i) => i.id !== item.id);
        return [...rest, item].sort((a, b) => a.createdAt - b.createdAt);
      });
    });
    const offResolved = window.api.on('attention:resolved', ({ id }) => {
      setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    });

    return () => {
      offNew();
      offResolved();
    };
  }, []);

  const answer = async (id: string, a: AttentionAnswer): Promise<void> => {
    await window.api.invoke('attention:answer', id, a);
    // The engine will also emit `attention:resolved`; remove now for a snappy UI.
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
  };

  if (items === null) {
    return <Spinner label="Loading inbox…" labelPosition="after" size="tiny" />;
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
        <InboxItem key={item.id} item={item} onAnswer={answer} />
      ))}
    </div>
  );
}
