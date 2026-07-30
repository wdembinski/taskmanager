/**
 * TaskCard — one draggable card on the My Tasks Kanban board.
 *
 * Mirrors the product mockup: a stripe of its project's colour along the top, a type
 * icon + title, an optional label chip, its progress note, the card's "Project:" line,
 * and a footer with the JIRA source badge and a priority square. A small status badge
 * appears only for the "unusual" states bucketed into a column (an AI run, or a
 * failed/stopped/cancelled task in Done).
 *
 * The card itself has NO frame — the fill is brighter than the column, which is edge
 * enough. The only frames are rings painted outside the box: orange for unread JIRA
 * comments or an agent waiting on an answer, brand for the selected card, both when
 * both. Outside, so clicking a card never moves its own text.
 *
 * Steps (Phase 11) and merge requests each render as a **section** of the card: one
 * hairline above the group, a quiet caption naming it, and the card's own fill
 * continuing underneath. They are part of the card, not strips floating on it. A step is
 * never a card of its own — it travels with its parent between columns — so the rows are
 * not draggable; clicking one selects that step in the detail pane.
 *
 * Phase 17 changed three things about what the card can say:
 *
 *   - The ring is driven by the INBOX (`attentionTaskIds`), not inferred from status and
 *     JIRA timestamps, so an item raised without a status flip no longer goes unshown.
 *   - The spinner comes from `runPhase`, which can see a run that has spawned but is not
 *     yet persisted as `running`, and it is accompanied by words — "Running step 2 of 5"
 *     rather than bare motion.
 *   - A row that wants you takes a TINT and the ticket badge takes the JIRA signal, so
 *     the card's one orange ring keeps its meaning and the reason stays legible.
 */
import {
  Badge,
  Caption1,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  AgentsRegular,
  BeakerFilled,
  BookmarkFilled,
  BugFilled,
  CheckmarkCircleFilled,
  CircleFilled,
  DismissCircleFilled,
  NoteFilled,
  PersonFilled,
  SparkleFilled,
  TaskListSquareLtrFilled,
} from '@fluentui/react-icons';
import type { Task } from '@shared/model';
import {
  chainNeedsAttention,
  hasUnreadJira,
  isAgentAssigned,
  needsAgentInput,
  parkedStep,
  runPhase,
} from '@shared/board';
import { priorityColor } from '@shared/priority';
import { statusNoteColor, type StatusKeyword } from '@shared/statusKeywords';
import { DEFAULT_BOARD_DISPLAY, type BoardDisplaySettings } from '@shared/settings';
import { STATUS_COLOR, STATUS_LABEL } from '../taskStatus';
import { columnForStatus, statusForColumn, subtaskProgress } from './boardColumns';
import {
  ACCENT,
  ATTENTION_TINT,
  FLUO,
  PIPELINE_COLOR,
  RING,
  STATUS_INDICATOR_COLOR,
} from '../theme';
import { JiraMark } from '../JiraMark';
import { approvalSummary, mrAttentionReason, type MergeRequest } from '@shared/mergeRequest';


/**
 * The delegation glyph, white so a card an agent owns reads at a glance. Sized to sit
 * with the card's type icon rather than tower over it.
 */
const AGENT_ICON_SIZE = '16px';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    // Brighter than the board it sits on: a card is the object, the column is the space
    // between objects, and the old darker fill had that backwards. That contrast is the
    // whole edge — there is no frame, because a frame was saying a second time what the
    // fill already said, and it fought the rings below for the same pixels.
    backgroundColor: tokens.colorNeutralBackground1,
    // Step rows sit flush against the frame, so they must be clipped by its radius.
    overflow: 'hidden',
    // ...but `overflow: hidden` also drops this flex item's automatic minimum size to
    // zero, so inside the column's scrolling list the card would shrink and clip its
    // own step rows instead of making the column scroll. Never shrink a card.
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
    // The column header is opaque and pinned (`KanbanColumn.header`), so a card scrolled
    // into view would stop UNDER it and lose its top edge — which is exactly where the
    // project stripe and the attention ring live. Stop below the header instead.
    // Un-pinning the header would cost the column labels on every scroll: a worse trade.
    scrollMarginTop: '36px',
  },
  body: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' },
  /**
   * The card's project, as a stripe along the top edge. Top rather than left so it can
   * never be confused with — or crowd — the ring that says a card wants you, and so it
   * stays put however tall the card's step rows make it. Clipped into the corners by
   * the card's own `overflow: hidden` + radius.
   */
  projectBar: { height: '3px', flexShrink: 0 },
  /**
   * A group of rows (steps, or merge requests) as a SECTION of the card rather than a
   * strip floating on it: one hairline above the group, a quiet caption naming it, and
   * the card's own fill continuing underneath.
   */
  section: { borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px 2px',
    color: tokens.colorNeutralForeground4,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontSize: '10px',
    fontWeight: 600,
  },
  // No row border: the section owns the one hairline, and a rule per row turned a card
  // with four steps into a ledger.
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    // The card's own fill, NOT the board's. These rows are part of the card; painting
    // them in the column's colour made them read as holes punched through it.
    backgroundColor: tokens.colorNeutralBackground1,
  },
  stepSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  /**
   * A row that wants you: a TINT and nothing else.
   *
   * Not a border — the card already carries the orange ring, and a second orange edge a
   * few pixels inside it made the two compete for the same glance. Not a fourth card
   * boxShadow variant either: Griffel would have the later class REPLACE `boxShadow`,
   * removing the ring from exactly the card that needs it.
   */
  stepLoud: { backgroundColor: ATTENTION_TINT },
  /** An MR row is a link, but it must look exactly like the step rows above it. */
  mrRow: { textDecoration: 'none', color: 'inherit' },
  /** The approval glyph, at the row's trailing edge opposite the pipeline dot. */
  approval: { display: 'flex', alignItems: 'center', fontSize: '14px', flexShrink: 0 },
  // The spinner (16px) and the dot (8px) share this slot so every row's title starts
  // at the same x, whichever glyph the row is showing.
  stepSlot: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  spinner: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  stepTitle: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground2,
  },
  stepDone: { color: tokens.colorNeutralForeground4, textDecoration: 'line-through' },
  progress: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  /** A stopped chain reads in the frame's colour, so the two say one thing. */
  progressStopped: { color: ACCENT.unread },
  /**
   * What the card is doing, in words, next to the spinner. The spinner alone says
   * "something is happening"; this says WHICH something, which is the difference
   * between a card you trust and one you keep clicking to check.
   */
  runLabel: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  /**
   * "Wants you" and "is selected", as rings PAINTED OUTSIDE the card.
   *
   * `box-shadow`, not `border`: a border is part of the box, so adding one on click
   * reflowed the card's own text by a pixel — a visible twitch on every selection.
   * A shadow costs no layout at all. It is also stackable, which is why the third
   * class exists: with two separate classes Griffel would have the later one REPLACE
   * `boxShadow`, and the orange would vanish the moment you clicked the card that was
   * shouting for you — exactly the card you most need to keep flagged.
   */
  // 3px for the alarm, 2px for mere selection. The orange is painted OUTSIDE the card
  // against a dark column, so a good half of its apparent weight is lost to the
  // contrast — at 2px it read as a hairline. Selection stays 2px: only the alarm is
  // worth more ink, and widening both would flatten the difference between them.
  cardUnread: { boxShadow: `0 0 0 ${RING.attention}px ${ACCENT.unread}` },
  cardSelected: { boxShadow: `0 0 0 ${RING.selected}px ${tokens.colorBrandStroke1}` },
  cardUnreadSelected: {
    boxShadow:
      `0 0 0 ${RING.attention}px ${ACCENT.unread}, ` +
      `0 0 0 ${RING.attention + RING.selected}px ${tokens.colorBrandStroke1}`,
  },
  agentIcon: { fontSize: AGENT_ICON_SIZE, flexShrink: 0, display: 'flex', color: '#ffffff' },
  dragging: { opacity: 0.5 },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  icon: { fontSize: '18px', flexShrink: 0, display: 'flex' },
  title: { lineHeight: '18px', flex: 1, minWidth: 0 },
  project: { color: tokens.colorNeutralForeground3 },
  /**
   * The card's progress note: one line, clipped. One line on purpose — the point is
   * that a column of cards can be read at a glance, and a card that grew to fit a
   * paragraph would defeat that. The full text is in the tooltip and the pane.
   */
  statusNote: {
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  chip: {
    backgroundColor: '#12836b',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '2px 8px',
    borderRadius: '4px',
  },
  // Quieter than the label chip on purpose: the sprint is context, not the headline.
  // The 1px padding offsets the border so both chips sit at the same height.
  sprintChip: {
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '1px 7px',
    borderRadius: '4px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  footer: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1, minWidth: 0 },
  jiraLink: { textDecoration: 'none' },
  /** The ticket badge: the JIRA mark, then the key. */
  jiraBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 7px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '11px',
    fontWeight: 600,
  },
  /**
   * The same badge, carrying the unread signal itself.
   *
   * The card's ring says "this wants you" but never why, so a new JIRA comment and an
   * agent's question looked identical. Tinting the badge that OWNS the reason is the
   * same move the merge-request rows make, and it costs the card no extra furniture.
   */
  // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand.
  jiraBadgeUnread: {
    backgroundColor: ACCENT.unread,
    border: `1px solid ${ACCENT.unread}`,
    color: ACCENT.unreadInk,
  },
  prioritySquare: { width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0 },
});

// Type-icon colors, now from the one palette (`theme.ts`) rather than four literals the
// card owned privately. Aliased so the maps below read the same as they always did.
const BUG_RED = ACCENT.bugRed;
const FEATURE_BLUE = ACCENT.featureBlue;
const STORY_GREEN = ACCENT.storyGreen;
const EPIC_PURPLE = ACCENT.epicPurple;

/**
 * Step-row dot color per status — the row's whole status display, since a badge per
 * row would drown the card. Deliberately the same vocabulary as `STATUS_COLOR`'s
 * badges: green done, red failed, brand while running, orange while it wants you.
 * `in-review` borrows the epic violet: it is the one column that is neither work in
 * flight nor work finished.
 */

/**
 * Pick a card icon for the task's type. Internal tasks use their user-chosen
 * `type` (bug/feature); JIRA tasks map their issue-type name onto the same glyphs.
 * A typeless internal task (legacy) falls back to a neutral note.
 */
export function typeIcon(task: Task): JSX.Element {
  if (task.externalSource !== 'jira') {
    if (task.type === 'bug') return <BugFilled style={{ color: BUG_RED }} />;
    if (task.type === 'feature') return <BeakerFilled style={{ color: FEATURE_BLUE }} />;
    return <NoteFilled />;
  }
  const t = (task.externalType ?? '').toLowerCase();
  if (t.includes('bug')) return <BugFilled style={{ color: BUG_RED }} />;
  if (t.includes('story')) return <BookmarkFilled style={{ color: STORY_GREEN }} />;
  if (t.includes('epic')) return <SparkleFilled style={{ color: EPIC_PURPLE }} />;
  if (t.includes('feature') || t.includes('improvement'))
    return <BeakerFilled style={{ color: FEATURE_BLUE }} />;
  if (t.includes('sub')) return <PersonFilled />;
  if (t.includes('task')) return <TaskListSquareLtrFilled style={{ color: FEATURE_BLUE }} />;
  return <CircleFilled style={{ color: FEATURE_BLUE }} />;
}

export interface TaskCardProps {
  task: Task;
  /** The card's "Project:" label (the JIRA project name for JIRA tasks). */
  projectName?: string;
  /** Name of the agent project this card is delegated to, for the glyph's tooltip. */
  agentName?: string;
  /** The card's project colour (`''`/undefined = no stripe). */
  projectColor?: string;
  /**
   * Whether to show the sprint chip. False while the board is filtered to the current
   * sprint: every card would carry the same word, so the name moves to the status bar
   * and is said once. With the filter off the chip is back, because that is when it
   * actually tells one card from another.
   */
  showSprint?: boolean;
  /** This card's steps in execution order — rendered inside the card. */
  subtasks?: Task[];
  /**
   * The merge requests filed under this card. Rendered as rows beneath the steps, and
   * folded into `chainNeedsAttention` — so the ring and the card ordering agree.
   */
  mergeRequests?: MergeRequest[];
  /** The user's status-note vocabulary, which colours the card's progress line. */
  statusKeywords?: readonly StatusKeyword[];
  /**
   * The task ids the inbox is holding an item for. The AUTHORITATIVE "wants you" signal:
   * without it the ring is inferred from status plus JIRA timestamps, so an item raised
   * without the engine also flipping the task to `waiting-input` — or one restored from
   * disk after a restart — left the card sitting there silently.
   */
  attentionTaskIds?: ReadonlySet<string>;
  /**
   * The task ids the engine currently has a run for, so a run that has spawned but is
   * not yet persisted as `running` still turns a spinner.
   */
  liveRunTaskIds?: ReadonlySet<string>;
  /** Which optional context lines to draw. Defaults to the shipped defaults. */
  display?: BoardDisplaySettings;
  selected: boolean;
  /** Id of the selected task, so a selected *step* row can highlight itself. */
  selectedTaskId?: string | null;
  draggable: boolean;
  onSelect: () => void;
  /** Open a step in the detail pane (the row never drags or moves the card). */
  onSelectSubtask?: (taskId: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  dragging: boolean;
}

/** The status worth badging on the card, or null when the column already says it. */
function secondaryStatus(task: Task): Task['status'] | null {
  const canonical = statusForColumn(columnForStatus(task.status));
  return task.status === canonical ? null : task.status;
}

export function TaskCard({
  task,
  projectName,
  agentName,
  projectColor,
  showSprint = true,
  subtasks = [],
  mergeRequests = [],
  statusKeywords,
  attentionTaskIds,
  liveRunTaskIds,
  display = DEFAULT_BOARD_DISPLAY,
  selected,
  selectedTaskId,
  draggable,
  onSelect,
  onSelectSubtask,
  onDragStart,
  onDragEnd,
  dragging,
}: TaskCardProps): JSX.Element {
  const styles = useStyles();
  const badge = secondaryStatus(task);
  const sprintShown = showSprint;
  const isJira = task.externalSource === 'jira';
  const squareColor = priorityColor(task.externalPriority);
  // Null when the note matched no keyword — the line then keeps the card's ordinary
  // secondary text colour, so an uncoloured note reads as text rather than as a state.
  const noteColor = statusNoteColor(task.statusNote, statusKeywords);
  // An unread comment, the card's own agent asking, or a step that has parked the
  // chain (question or failure) — all mean "this card wants you", and a step has no
  // frame of its own to say it with.
  const wantsAttention = chainNeedsAttention(task, subtasks, mergeRequests, attentionTaskIds);
  const progress = subtaskProgress(subtasks);
  // A parked chain looks exactly like one between steps unless the card says so.
  const stopped = parkedStep(subtasks) !== null;
  // The one answer to "what is this card doing", shared with the detail pane and the
  // composer strip so the three can never disagree. It replaces a spinner derived from
  // `status === 'running'`, which could not see a run that had spawned but not yet been
  // persisted — the "it's clearly working but there's no spinner" complaint.
  const run = runPhase(task, subtasks, liveRunTaskIds);
  // Only the ticket badge carries the JIRA signal, so the ring's reason is legible.
  const jiraUnread = hasUnreadJira(task);

  return (
    <div
      className={mergeClasses(
        styles.card,
        // One of three, never two: see `cardUnreadSelected`.
        wantsAttention && selected
          ? styles.cardUnreadSelected
          : wantsAttention
            ? styles.cardUnread
            : selected && styles.cardSelected,
        dragging && styles.dragging,
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
    >
      {projectColor && (
        <div className={styles.projectBar} style={{ backgroundColor: projectColor }} />
      )}
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <span className={styles.icon}>{typeIcon(task)}</span>
          <Text weight="semibold" className={styles.title}>
            {task.title}
          </Text>
          {progress.total > 0 && (
            <Caption1
              className={mergeClasses(styles.progress, stopped && styles.progressStopped)}
              title={
                stopped
                  ? `${progress.done} of ${progress.total} steps done — the chain has stopped at a step that needs you`
                  : `${progress.done} of ${progress.total} steps done`
              }
            >
              {progress.done}/{progress.total}
              {stopped && ' · stopped'}
            </Caption1>
          )}
          {isAgentAssigned(task) && (
            <Tooltip
              relationship="label"
              content={
                needsAgentInput(task)
                  ? `Agent needs your input${agentName ? ` · ${agentName}` : ''}`
                  : `Assigned to an agent${agentName ? ` · ${agentName}` : ''}`
              }
            >
              <span className={styles.agentIcon}>
                <AgentsRegular />
              </span>
            </Tooltip>
          )}
          {/* The spinner turns only while something actually moves; the words say which
              step it is on. Previously bare, on the theory that "Running" on a card and
              "Running" on a step read as an inconsistency — but the real complaint was
              not knowing whether anything was happening at all, and a step counter
              answers that far better than motion alone. */}
          {run.spinner && (
            <span className={styles.spinner} title={run.label}>
              <Spinner size="extra-tiny" />
            </span>
          )}
          {run.label && (
            <Caption1 className={styles.runLabel} title={run.label}>
              {run.label}
            </Caption1>
          )}
          {/* A running card's badge would only repeat what the label just said. */}
          {badge && !run.spinner && (
            <Badge appearance="tint" color={STATUS_COLOR[badge]}>
              {STATUS_LABEL[badge]}
            </Badge>
          )}
        </div>

        {((display.showLabels && task.externalLabel) || (sprintShown && task.externalSprint)) && (
          <div className={styles.chipRow}>
            {display.showLabels && task.externalLabel && (
              <span className={styles.chip}>{task.externalLabel}</span>
            )}
            {sprintShown && task.externalSprint && (
              <span className={styles.sprintChip} title={`Sprint: ${task.externalSprint}`}>
                {task.externalSprint}
              </span>
            )}
          </div>
        )}

        {/* Where the card actually is, in your words. Above the "Project:" line
            because it is the thing that changes, and the thing you scan for. */}
        {task.statusNote && (
          <Caption1
            className={styles.statusNote}
            style={noteColor ? { color: noteColor } : undefined}
            title={task.statusNote}
          >
            {task.statusNote}
          </Caption1>
        )}

        {display.showProjectName && projectName && (
          <Caption1 className={styles.project}>Project: {projectName}</Caption1>
        )}

        {/* The name when the sync has it, the key until then — a key is still an answer
            to "which epic", where an empty line looks like the toggle is broken. */}
        {display.showEpicName && (task.externalEpicName || task.externalParentKey) && (
          <Caption1
            className={styles.project}
            title={`Epic: ${task.externalEpicName ?? task.externalParentKey}`}
          >
            Epic: {task.externalEpicName ?? task.externalParentKey}
          </Caption1>
        )}

        {(isJira || squareColor) && (
          <div className={styles.footer}>
            {isJira && task.externalKey && (
              <a
                className={styles.jiraLink}
                href={task.externalUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={
                  jiraUnread
                    ? `${task.externalKey} — new comments on the ticket`
                    : (task.externalKey ?? undefined)
                }
              >
                <span
                  className={mergeClasses(
                    styles.jiraBadge,
                    jiraUnread && styles.jiraBadgeUnread,
                  )}
                >
                  {/* `currentColor` when tinted, so the mark flips to near-black with the
                      badge's text instead of sitting brand-blue on orange. */}
                  <JiraMark size={12} color={jiraUnread ? 'currentColor' : undefined} />
                  {task.externalKey}
                </span>
              </a>
            )}
            <span className={styles.grow} />
            {squareColor && (
              <span
                className={styles.prioritySquare}
                style={{ backgroundColor: squareColor }}
                title={task.externalPriority ?? undefined}
              />
            )}
          </div>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span>Steps</span>
            <span className={styles.grow} />
            <span>
              {progress.done}/{progress.total}
            </span>
          </div>
          {subtasks.map((step) => {
            const stepRun = runPhase(step, [], liveRunTaskIds);
            const stepWants = attentionTaskIds?.has(step.id) ?? false;
            return (
              <div
                key={step.id}
                className={mergeClasses(
                  styles.step,
                  stepWants && styles.stepLoud,
                  step.id === selectedTaskId && styles.stepSelected,
                )}
                title={`${step.title} · ${stepRun.label || STATUS_LABEL[step.status]}`}
                // A step never travels on its own: a drag started on a row is cancelled
                // rather than dragging the parent out from under the pointer.
                onDragStart={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSubtask?.(step.id);
                }}
              >
                {/* One fixed-width slot for the status glyph, so the running row's spinner
                    doesn't shove its title out of line with its siblings' dots. */}
                <span className={styles.stepSlot}>
                  {stepRun.spinner ? (
                    <Spinner size="extra-tiny" />
                  ) : (
                    <span
                      className={styles.stepDot}
                      style={{ backgroundColor: STATUS_INDICATOR_COLOR[step.status] }}
                    />
                  )}
                </span>
                <Caption1
                  className={mergeClasses(
                    styles.stepTitle,
                    step.status === 'done' && styles.stepDone,
                  )}
                >
                  {step.title}
                </Caption1>
              </div>
            );
          })}
        </div>
      )}


      {/* Merge requests, in the same row vocabulary as the steps. Pipeline and approval
          are now SEPARATE glyphs: one dot conflated "the build is green" with "a human
          said yes", which are the two different things you actually wait on. */}
      {mergeRequests.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span>{mergeRequests.length === 1 ? 'Merge request' : 'Merge requests'}</span>
          </div>
          {mergeRequests.map((mr) => {
            const reason = mrAttentionReason(mr);
            return (
              <a
                key={mr.id}
                href={mr.webUrl}
                target="_blank"
                rel="noreferrer"
                className={mergeClasses(
                  styles.step,
                  styles.mrRow,
                  reason !== null && styles.stepLoud,
                )}
                title={reason ?? `!${mr.iid} ${mr.title} · ${approvalSummary(mr)}`}
                onDragStart={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                // The shell's window-open handler sends target=_blank to the real browser;
                // stopPropagation keeps the click from also selecting the card behind it.
                onClick={(e) => e.stopPropagation()}
              >
                <span className={styles.stepSlot} title={`Pipeline: ${mr.pipelineStatus}`}>
                  <span
                    className={styles.stepDot}
                    style={{ backgroundColor: PIPELINE_COLOR[mr.pipelineStatus] }}
                  />
                </span>
                <Caption1 className={styles.stepTitle}>{`!${mr.iid} ${mr.sourceBranch}`}</Caption1>
                {mr.draft && <Caption1 className={styles.progress}>draft</Caption1>}
                <span className={styles.approval} title={approvalSummary(mr)}>
                  {mr.approvalsRequired !== null && mr.approvalsGiven >= mr.approvalsRequired ? (
                    <CheckmarkCircleFilled style={{ color: FLUO.green }} aria-label="Approved" />
                  ) : mr.changesRequested ? (
                    <DismissCircleFilled
                      style={{ color: FLUO.red }}
                      aria-label="Changes requested"
                    />
                  ) : (
                    <PersonFilled
                      style={{ color: tokens.colorNeutralForeground4 }}
                      aria-label="Awaiting approval"
                    />
                  )}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
