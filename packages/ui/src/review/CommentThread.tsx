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
 *
 * An AI draft (`origin: 'ai'`, F16.12) draws as v9-6 does: a filled brand "AI" pill — the
 * card's one accent — then "Draft · <severity>" with a monochrome severity glyph (only
 * `blocker` takes the board's attention red), the body, the `suggestion` as a −/+ mini diff in
 * `DiffView`'s own tints, and Keep · Edit · Dismiss with "cites line N" on the right. Keep is
 * the `accept` transition; Edit opens the editor, and saving it accepts on the server. A kept
 * draft gets the human draft's Edit/Delete icons and a faint "kept"; a dismissed one (drawn
 * only under "show dismissed (N)") is dimmed, with Restore.
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkRegular,
  CommentRegular,
  DeleteRegular,
  EditRegular,
  ErrorCircleRegular,
  InfoRegular,
  WarningRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type { AiFindingSeverity } from '@tm/shared/aiReview';
import type { ReviewComment } from '@tm/shared/review';
import { MONO, fontPx } from '../theme';
import { DIFF_VAR } from '../tokens';
import { isAiDraft, type CommentEditor } from './reviewState';
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
  // ── AI drafts ──
  dismissed: { opacity: 0.6 },
  aiTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground2,
  },
  glyph: { fontSize: '14px', color: tokens.colorNeutralForeground3 },
  // The board's own attention red (`TaskCard`'s `danger`): a blocker is the one severity
  // worth a colour.
  glyphBlocker: { color: tokens.colorPaletteRedForeground1 },
  footer: { display: 'flex', alignItems: 'center', gap: '12px' },
  textAction: {
    minWidth: 0,
    height: 'auto',
    padding: 0,
    fontSize: fontPx(12),
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorBrandForeground1,
  },
  textActionPrimary: { fontWeight: tokens.fontWeightSemibold },
  textActionQuiet: { color: tokens.colorNeutralForeground3 },
  faint: { color: tokens.colorNeutralForeground4 },
  kept: { color: tokens.colorNeutralForeground3 },
  miniDiff: {
    display: 'flex',
    flexDirection: 'column',
    fontFamily: MONO,
    fontSize: fontPx(12),
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  miniLine: { display: 'flex', whiteSpace: 'pre-wrap', padding: '0 6px' },
  miniSign: { flexShrink: 0, width: '14px', color: tokens.colorNeutralForeground3 },
  miniDel: { backgroundColor: DIFF_VAR.del },
  miniAdd: { backgroundColor: DIFF_VAR.add },
});

/** Where an AI draft stands: waiting on Keep/Edit/Dismiss, kept, or dismissed. A sent AI draft
 * reads as kept — only an accepted one could have gone out. */
export type DraftDecision = 'pending' | 'accepted' | 'dismissed';

export function draftDecision(comment: ReviewComment): DraftDecision {
  if (comment.dismissedAt != null) return 'dismissed';
  if (comment.acceptedAt != null || comment.sentAt !== null) return 'accepted';
  return 'pending';
}

const SEVERITY_GLYPH: Record<AiFindingSeverity, FluentIcon> = {
  blocker: ErrorCircleRegular,
  major: WarningRegular,
  minor: InfoRegular,
  nit: CommentRegular,
};

/** "cites line 18", or "cites lines 12–18" for a range. */
export function citesLabel(comment: ReviewComment): string {
  const start = comment.start?.line ?? comment.line;
  if (start === comment.line) return `cites line ${comment.line}`;
  return `cites lines ${Math.min(start, comment.line)}–${Math.max(start, comment.line)}`;
}

/** The callbacks an AI draft's decision buttons call. Each is optional: a host that passes
 * none draws a pending draft with Edit alone. */
export interface DraftDecisionHandlers {
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onRestore?: (id: string) => void;
}

/** One text button under an AI draft. */
export interface AiDraftAction {
  key: 'keep' | 'edit' | 'dismiss' | 'restore';
  label: string;
  run: () => void;
}

/**
 * The text buttons an AI draft offers in its current {@link draftDecision}: Keep · Edit ·
 * Dismiss while pending, Restore once dismissed, none once kept (it has the icon buttons then)
 * or sent. Pure, so the wiring is testable without a DOM.
 */
export function aiDraftActions(
  comment: ReviewComment,
  handlers: DraftDecisionHandlers & { onEdit: (comment: ReviewComment) => void },
): AiDraftAction[] {
  if (comment.sentAt !== null) return [];
  const { onAccept, onDismiss, onRestore, onEdit } = handlers;
  const actions: AiDraftAction[] = [];
  switch (draftDecision(comment)) {
    case 'pending':
      if (onAccept) actions.push({ key: 'keep', label: 'Keep', run: () => onAccept(comment.id) });
      actions.push({ key: 'edit', label: 'Edit', run: () => onEdit(comment) });
      if (onDismiss) {
        actions.push({ key: 'dismiss', label: 'Dismiss', run: () => onDismiss(comment.id) });
      }
      break;
    case 'dismissed':
      if (onRestore) {
        actions.push({ key: 'restore', label: 'Restore', run: () => onRestore(comment.id) });
      }
      break;
    case 'accepted':
      break;
  }
  return actions;
}

export interface CommentCardProps extends DraftDecisionHandlers {
  comment: ReviewComment;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

/** "L12" for a single line, "L12–L18" for a range — regardless of which side it anchors to. */
function rangeLabel(comment: ReviewComment): string {
  const start = comment.start?.line ?? comment.line;
  return start === comment.line ? `L${comment.line}` : `L${start}–L${comment.line}`;
}

function OutdatedBadge(): JSX.Element {
  return (
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
  );
}

function SentStamp({ sentAt }: { sentAt: number }): JSX.Element {
  const styles = useStyles();
  return (
    <Caption1 className={styles.sent}>
      <CheckmarkRegular className={styles.sentIcon} />
      {formatSentStamp(sentAt, Date.now())}
    </Caption1>
  );
}

/** A draft's Edit and Delete icon buttons. */
function DraftIcons({
  comment,
  onEdit,
  onDelete,
}: Pick<CommentCardProps, 'comment' | 'onEdit' | 'onDelete'>): JSX.Element {
  return (
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
  );
}

export function CommentCard(props: CommentCardProps): JSX.Element {
  return isAiDraft(props.comment) ? <AiDraftCard {...props} /> : <HumanCommentCard {...props} />;
}

function HumanCommentCard({ comment, onEdit, onDelete }: CommentCardProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Caption1 className={styles.range}>{rangeLabel(comment)}</Caption1>
        {comment.outdated && <OutdatedBadge />}
        {comment.sentAt !== null && <SentStamp sentAt={comment.sentAt} />}
        <span className={styles.grow} />
        {comment.sentAt === null && (
          <DraftIcons comment={comment} onEdit={onEdit} onDelete={onDelete} />
        )}
      </div>
      <Body1 className={styles.body}>{comment.body}</Body1>
    </div>
  );
}

/** See the module header. */
function AiDraftCard({
  comment,
  onEdit,
  onDelete,
  onAccept,
  onDismiss,
  onRestore,
}: CommentCardProps): JSX.Element {
  const styles = useStyles();
  const decision = draftDecision(comment);
  const severity = comment.severity ?? null;
  const Glyph = severity !== null ? SEVERITY_GLYPH[severity] : null;
  const actions = aiDraftActions(comment, { onAccept, onDismiss, onRestore, onEdit });
  const kept = decision === 'accepted' && comment.sentAt === null;
  return (
    <div
      className={mergeClasses(styles.card, decision === 'dismissed' && styles.dismissed)}
      data-ai-draft
      data-severity={severity ?? undefined}
      data-decision={decision}
    >
      <div className={styles.cardHeader}>
        <Badge appearance="filled" color="brand" size="small" data-ai-mark>
          AI
        </Badge>
        <Caption1 className={styles.aiTitle}>
          Draft
          {severity !== null && Glyph !== null && (
            <>
              <span aria-hidden>·</span>
              <Glyph
                className={mergeClasses(
                  styles.glyph,
                  severity === 'blocker' && styles.glyphBlocker,
                )}
                data-severity-glyph={severity}
                data-tone={severity === 'blocker' ? 'attention' : 'neutral'}
                aria-hidden
              />
              {severity}
            </>
          )}
        </Caption1>
        {comment.outdated && <OutdatedBadge />}
        {comment.sentAt !== null && <SentStamp sentAt={comment.sentAt} />}
        <span className={styles.grow} />
        {kept && <DraftIcons comment={comment} onEdit={onEdit} onDelete={onDelete} />}
      </div>
      <Body1 className={styles.body}>{comment.body}</Body1>
      {comment.suggestion != null && (
        <SuggestionDiff excerpt={comment.excerpt} suggestion={comment.suggestion} />
      )}
      <div className={styles.footer}>
        {actions.map((action) => (
          <Button
            key={action.key}
            size="small"
            appearance="transparent"
            className={mergeClasses(
              styles.textAction,
              (action.key === 'keep' || action.key === 'restore') && styles.textActionPrimary,
              action.key === 'dismiss' && styles.textActionQuiet,
            )}
            data-draft-action={action.key}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ))}
        {kept && (
          <Caption1 className={styles.kept} data-kept>
            kept
          </Caption1>
        )}
        <span className={styles.grow} />
        <Caption1 className={styles.faint} data-cites>
          {citesLabel(comment)}
        </Caption1>
      </div>
    </div>
  );
}

/** The anchored excerpt as `−` lines and the suggestion as `+` lines, in `DiffView`'s tints. */
function SuggestionDiff({
  excerpt,
  suggestion,
}: {
  excerpt: string;
  suggestion: string;
}): JSX.Element {
  const styles = useStyles();
  const removed = excerpt === '' ? [] : excerpt.split('\n');
  const added = suggestion === '' ? [] : suggestion.split('\n');
  return (
    <div className={styles.miniDiff} data-suggestion>
      {removed.map((text, i) => (
        <div
          key={`del${i}`}
          className={mergeClasses(styles.miniLine, styles.miniDel)}
          data-line="del"
        >
          <span className={styles.miniSign}>−</span>
          {text}
        </div>
      ))}
      {added.map((text, i) => (
        <div
          key={`add${i}`}
          className={mergeClasses(styles.miniLine, styles.miniAdd)}
          data-line="add"
        >
          <span className={styles.miniSign}>+</span>
          {text}
        </div>
      ))}
    </div>
  );
}

export interface DismissedToggleProps {
  /** How many drafts are dismissed — nothing is drawn while there are none. */
  count: number;
  shown: boolean;
  onToggle: () => void;
}

/** "show dismissed (N)" / "hide dismissed": a subtle link beside a header's draft count. */
export function DismissedToggle({
  count,
  shown,
  onToggle,
}: DismissedToggleProps): JSX.Element | null {
  if (count === 0) return null;
  return (
    <Link
      as="button"
      appearance="subtle"
      onClick={onToggle}
      data-dismissed-toggle={shown ? 'shown' : 'hidden'}
    >
      <Caption1>{shown ? 'hide dismissed' : `show dismissed (${count})`}</Caption1>
    </Link>
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

export interface CommentThreadProps extends DraftDecisionHandlers {
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
  onAccept,
  onDismiss,
  onRestore,
}: CommentThreadProps): JSX.Element | null {
  const styles = useStyles();
  if (comments.length === 0 && editor === null) return null;
  return (
    <div className={styles.thread}>
      {comments
        .filter((c) => c.id !== editor?.commentId)
        .map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            onEdit={onEdit}
            onDelete={onDelete}
            onAccept={onAccept}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />
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
