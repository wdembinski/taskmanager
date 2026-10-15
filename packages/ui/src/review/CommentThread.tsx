/**
 * One gutter row's worth of review comments: the sent/draft cards `DiffView` already has an
 * anchor for, and — appended after them, never in their place — the inline editor when one
 * is open at that same anchor. `ReviewPane` owns every transport call; this module only
 * turns a `CommentEditor`/`ReviewComment[]` pair into Fluent JSX, the same split
 * `ReviewPaneView` makes from `ReviewPane`.
 *
 * Colour budget (memory *board-colour-budget*): the "Outdated" badge asks for
 * `color="informative"` by name, but its `style` override pins it to neutral tokens anyway —
 * this pane's only colour is still added/removed diff content, same as `DiffView`'s own rule.
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Spinner,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import type { ReviewComment } from '@tm/shared/review';
import { MONO, fontPx } from '../theme';
import type { CommentEditor } from './reviewState';
import { formatSentStamp } from './reviewView';

const useStyles = makeStyles({
  thread: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 8px' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
  range: { fontFamily: MONO, color: tokens.colorNeutralForeground3 },
  sent: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground3,
  },
  sentIcon: { fontSize: '14px' },
  grow: { flex: 1, minWidth: 0 },
  body: { whiteSpace: 'pre-wrap', fontSize: fontPx(13) },
  outdatedHint: { color: tokens.colorNeutralForeground3 },
  error: { marginBottom: '2px' },
  editorActions: { display: 'flex', gap: '6px' },
});

export interface CommentCardProps {
  comment: ReviewComment;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

/** "L12" for a single line, "L12–L18" for a range — regardless of which side it anchors to. */
function rangeLabel(comment: ReviewComment): string {
  const start = comment.start?.line ?? comment.line;
  return start === comment.line ? `L${comment.line}` : `L${start}–L${comment.line}`;
}

export function CommentCard({ comment, onEdit, onDelete }: CommentCardProps): JSX.Element {
  const styles = useStyles();
  const isDraft = comment.sentAt === null;
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Caption1 className={styles.range}>{rangeLabel(comment)}</Caption1>
        {comment.outdated && (
          <Badge
            appearance="outline"
            color="informative"
            size="small"
            style={{
              color: tokens.colorNeutralForeground3,
              borderColor: tokens.colorNeutralStroke1,
            }}
          >
            Outdated
          </Badge>
        )}
        {comment.sentAt !== null && (
          <Caption1 className={styles.sent}>
            <CheckmarkRegular className={styles.sentIcon} />
            {formatSentStamp(comment.sentAt, Date.now())}
          </Caption1>
        )}
        <span className={styles.grow} />
        {isDraft && (
          <>
            <Button
              size="small"
              appearance="subtle"
              icon={<EditRegular />}
              aria-label="Edit comment"
              onClick={() => onEdit(comment)}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<DeleteRegular />}
              aria-label="Delete comment"
              onClick={() => onDelete(comment.id)}
            />
          </>
        )}
      </div>
      <Body1 className={styles.body}>{comment.body}</Body1>
    </div>
  );
}

export interface CommentEditorCardProps {
  editor: CommentEditor;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function CommentEditorCard({
  editor,
  onEditDraft,
  onSave,
  onCancel,
}: CommentEditorCardProps): JSX.Element {
  const styles = useStyles();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSave = editor.draft.trim() !== '' && !editor.saving;

  return (
    <div className={styles.card}>
      {editor.outdated && (
        <Caption1 className={styles.outdatedHint}>
          The diff moved on since this was anchored — the excerpt kept here still shows what it was
          about.
        </Caption1>
      )}
      {editor.error && (
        <MessageBar intent="error" className={styles.error}>
          <MessageBarBody>{editor.error}</MessageBarBody>
        </MessageBar>
      )}
      <Textarea
        textarea={{ ref: textareaRef }}
        value={editor.draft}
        disabled={editor.saving}
        onChange={(_e, data) => onEditDraft(data.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (canSave) onSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Leave a comment…  (Ctrl/Cmd+Enter to save, Esc to cancel)"
        resize="vertical"
      />
      <div className={styles.editorActions}>
        <Button
          size="small"
          appearance="primary"
          disabled={!canSave}
          icon={editor.saving ? <Spinner size="tiny" /> : undefined}
          onClick={onSave}
        >
          {editor.saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="small" appearance="subtle" disabled={editor.saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export interface CommentThreadProps {
  /** Every sent/draft comment anchored at this row, in no particular order. */
  comments: readonly ReviewComment[];
  /** The open editor, when it belongs at this row — `null` otherwise. */
  editor: CommentEditor | null;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

/**
 * `comments` first, then the editor — except the one comment the editor is itself editing,
 * which would otherwise show twice (once as its own read-only card, once as the editor).
 */
export function CommentThread({
  comments,
  editor,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: CommentThreadProps): JSX.Element | null {
  const styles = useStyles();
  if (comments.length === 0 && editor === null) return null;
  return (
    <div className={styles.thread}>
      {comments
        .filter((c) => c.id !== editor?.commentId)
        .map((c) => (
          <CommentCard key={c.id} comment={c} onEdit={onEdit} onDelete={onDelete} />
        ))}
      {editor && (
        <CommentEditorCard
          editor={editor}
          onEditDraft={onEditDraft}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}
