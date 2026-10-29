/**
 * The Inbox's open owner decisions — every card holding a `decisionQuestion`, under its
 * project, above the attention list in `Attention()`.
 *
 * A decision is not an `AttentionItem`: no run is parked on it and nothing pushes it into
 * `attention:list`. It is a fact on the card itself, so this list reads the cards —
 * `board:tasks()` unscoped (every board), names from `project:list` (the same source
 * `ActivityFeed` and `useSidebarData` use), and `task:changed` to follow a decision being
 * raised, re-asked, answered or withdrawn anywhere else.
 *
 * Split the same way as `DecisionBanner`: `InboxDecisionsView` takes its groups and two
 * callbacks and reads no transport, so `InboxDecisions.render.test.tsx` drives it through
 * `renderToStaticMarkup`; `useInboxDecisions` owns the cards and the channel call. Each row
 * keeps its half-typed answer as a draft (`useDraft`), like `InboxItem`'s note.
 *
 * Answering calls `task:answerDecision`, which clears the flag and files the answer as a
 * comment on the card; the row leaves at once rather than waiting for `task:changed`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Body1Strong,
  Button,
  Caption1,
  Caption1Strong,
  Link,
  Spinner,
  Subtitle2,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { toTaskSummary, type TaskSummary } from '@tm/shared/taskSummary';
import { removedAgo } from './board/ArchivedCardsDialog';
import { groupDecisions, type DecisionGroup, type DecisionRow } from './decisionsIndex';
import { draftKey, useDraft } from './drafts';
import { useTransport } from './transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  group: { display: 'flex', flexDirection: 'column', gap: '8px' },
  project: { color: tokens.colorNeutralForeground3, textTransform: 'uppercase' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  question: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  asked: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
  answer: { flex: 1 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface InboxDecisionsViewProps {
  groups: readonly DecisionGroup[];
  /** Throws to refuse — the refusal shows under that row's answer box. */
  onAnswer: (taskId: string, answer: string) => Promise<void>;
  /** Absent prints the card's title as plain text rather than a link. */
  onOpen?: (taskId: string) => void;
  /** "Now", for the age line; defaults to the clock. */
  now?: number;
}

/** The section itself — renders nothing at all with zero decisions. */
export function InboxDecisionsView({
  groups,
  onAnswer,
  onOpen,
  now = Date.now(),
}: InboxDecisionsViewProps): JSX.Element | null {
  const styles = useStyles();
  if (groups.length === 0) return null;
  return (
    <section className={styles.root} data-inbox-decisions="" aria-label="Decisions">
      <Subtitle2>Decisions</Subtitle2>
      {groups.map((group) => (
        <div key={group.projectId} className={styles.group} data-decision-project={group.projectId}>
          <Caption1Strong className={styles.project}>{group.projectName}</Caption1Strong>
          {group.decisions.map((row) => (
            <DecisionItem
              key={row.taskId}
              row={row}
              now={now}
              onAnswer={onAnswer}
              onOpen={onOpen}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function DecisionItem({
  row,
  now,
  onAnswer,
  onOpen,
}: {
  row: DecisionRow;
  now: number;
  onAnswer: InboxDecisionsViewProps['onAnswer'];
  onOpen?: InboxDecisionsViewProps['onOpen'];
}): JSX.Element {
  const styles = useStyles();
  const answer = useDraft(draftKey(row.taskId, 'decision'), '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const text = answer.value.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(row.taskId, text);
      answer.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.item} data-decision-row={row.taskId}>
      <div className={styles.head}>
        <Body1Strong className={styles.grow}>
          {onOpen ? <Link onClick={() => onOpen(row.taskId)}>{row.title}</Link> : row.title}
        </Body1Strong>
        {row.askedAt != null && (
          <Caption1 className={styles.asked}>Asked {removedAgo(row.askedAt, now)}</Caption1>
        )}
      </div>
      <span className={styles.question}>{row.question}</span>
      <div className={styles.actions}>
        <Textarea
          className={styles.answer}
          aria-label={`Your answer to: ${row.question}`}
          placeholder="Your answer — it is filed on the card for the next planning run."
          resize="vertical"
          value={answer.value}
          disabled={busy}
          onChange={(_e, d) => answer.set(d.value)}
        />
        <Button
          appearance="primary"
          icon={busy ? <Spinner size="tiny" /> : undefined}
          disabled={busy || !answer.value.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Answering…' : 'Answer'}
        </Button>
      </div>
      {error && <Caption1 className={styles.error}>{error}</Caption1>}
    </div>
  );
}

export interface InboxDecisions {
  /** Null until the first `board:tasks()` answer lands (or while it keeps failing). */
  groups: DecisionGroup[] | null;
  answer: (taskId: string, answer: string) => Promise<void>;
}

/**
 * Seeds from `board:tasks()` and `project:list`, follows `task:changed`. A failed seed leaves
 * `groups` null — the attention list below must never wait on, or be hidden by, this one.
 */
export function useInboxDecisions(): InboxDecisions {
  const transport = useTransport();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    transport.invoke('board:tasks').then(
      (list) => {
        if (live) setTasks(list);
      },
      () => undefined,
    );
    transport.invoke('project:list').then(
      (list) => {
        if (live) setNames(new Map(list.map((p) => [p.project.id, p.project.name])));
      },
      () => undefined,
    );
    const off = transport.on('task:changed', ({ task }) => {
      setTasks((prev) => {
        if (prev === null) return prev;
        const rest = prev.filter((t) => t.id !== task.id);
        return rest.length === prev.length && task.decisionQuestion == null
          ? prev
          : [...rest, toTaskSummary(task)];
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  const groups = useMemo(
    () => (tasks === null ? null : groupDecisions(tasks, (id) => names.get(id) ?? 'No project')),
    [tasks, names],
  );

  const answer = useCallback(
    async (taskId: string, text: string): Promise<void> => {
      const { task } = await transport.invoke('task:answerDecision', taskId, text);
      setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
    },
    [transport],
  );

  return { groups, answer };
}
