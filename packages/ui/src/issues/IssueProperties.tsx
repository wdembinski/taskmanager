/**
 * The full-screen issue's right-hand property column, after `v9-2-issue-detail-light.svg`:
 * a muted label on the LEFT of a plain value per row (a 92px label track, as the mockup's
 * x=1130 / x=1222 columns), no borders, the rows set apart by spacing alone. Only Status
 * (its column's glyph), Assignee (the agent glyph, or the person) and Milestone (a flag)
 * carry an icon before the value — the mockup draws Runner, Model, Estimate and Due as text.
 *
 * **Click-to-edit** (the owner's default, taken as given): a value reads as text until it is
 * clicked, and then becomes the editor that field already has everywhere else — Status the
 * details cell's State dropdown, Assignee and Milestone the Ticket fold's pickers, Model the
 * composer's `ModelField` — focused at once. Picking a value, Esc, or leaving the editor puts
 * the row back to its read-only look. Every save is the field's own (`useStatusSetter`,
 * `useTicketFieldSave`, `task:setAgentOptions`), hosted HERE rather than in the editor, so a
 * refused save's message and the release-on-Done prompt outlive the editor that closed.
 *
 * Which rows exist, and in which order, is `issuePropertyRows` (`./issuePropertyRows`). The
 * native-ticket fields the list does not carry (Type, Epic, Labels, Reporter, Story points,
 * Start) stay reachable under a "More fields" fold at the bottom.
 */
import { useEffect, useRef, useState } from 'react';
import { Body1, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { FlagRegular, PersonRegular } from '@fluentui/react-icons';
import { columnForTask } from '@tm/shared/board';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { ManualStatus, Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import type { ClaudeModel } from '@tm/shared/session';
import type { TaskLink } from '@tm/shared/taskChain';
import { delegatedAgentName, isNativeTicket } from '@tm/shared/tickets';
import { AgentGlyph } from '../AgentGlyph';
import { FoldToggle } from '../FoldToggle';
import { ModelField, useModelLabels } from '../ModelField';
import {
  cardModelCaption,
  cardModelFromOption,
  PROJECT_DEFAULT,
  projectDefaultLabel,
} from '../modelChoice';
import { ArchivedTicketBanner } from '../projects/ArchivedTicketBanner';
import { useDeviceFold } from '../projects/deviceFold';
import { PersonAvatar } from '../projects/PersonAvatar';
import {
  TicketAssigneeField,
  TicketFieldsSection,
  TicketMilestoneField,
  useTicketFieldSave,
} from '../projects/TicketFieldsSection';
import { StatusDropdown, useStatusSetter } from '../TaskDetailsCell';
import {
  issuePropertyRows,
  nextEditing,
  type PropertyEditor,
  type PropertyRow,
} from './issuePropertyRows';
import { STATUS_GLYPH } from './IssueRow';

const useStyles = makeStyles({
  column: { display: 'flex', flexDirection: 'column', gap: '16px' },
  list: { display: 'flex', flexDirection: 'column', gap: '4px' },
  /**
   * Label left, value right — the label track fixed so every value starts at one x. Aligned
   * to the top with the label on the value's 20px line box rather than by `baseline`: a value
   * that opens with an icon gets the SVG's bottom edge as its baseline, which dropped the
   * label below the text, and a wrapped value must keep its label on the FIRST line.
   */
  row: {
    display: 'grid',
    gridTemplateColumns: '92px minmax(0, 1fr)',
    columnGap: '8px',
    alignItems: 'start',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
  },
  /** Only a row a click can edit lights up under the pointer. */
  editable: { ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover } },
  label: {
    gridColumn: '1',
    lineHeight: tokens.lineHeightBase300,
    color: tokens.colorNeutralForeground3,
  },
  /** Column 2: the value at rest, or the editor that replaced it, plus a save's error. */
  cell: {
    gridColumn: '2',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  /** An icon and the text beside it, on one line — the column is 300px, as v9-2 draws it. */
  value: {
    display: 'inline-flex',
    alignItems: 'flex-start',
    gap: '6px',
    minWidth: 0,
    maxWidth: '100%',
  },
  /** The value's text: one line, cut with an ellipsis; its `title` carries the whole. */
  valueText: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    height: tokens.lineHeightBase300,
    flexShrink: 0,
    fontSize: '16px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  /** The value as a control — reads as plain text, with no button chrome. */
  valueButton: {
    background: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    textAlign: 'left',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    font: 'inherit',
    maxWidth: '100%',
    minWidth: 0,
    display: 'flex',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, borderRadius: '2px' },
  },
  empty: { color: tokens.colorNeutralForeground3 },
  /**
   * Blocked by reads as text, not a link — v9-2 draws a muted key and a plain title. The
   * Links section below still opens the card.
   */
  links: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  blocker: {
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  blockerKey: {
    marginRight: '6px',
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: '11.5px',
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  blockerTitle: { fontSize: '12.5px', color: tokens.colorNeutralForeground1 },
  error: { color: tokens.colorPaletteRedForeground1 },
  more: { display: 'flex', flexDirection: 'column', gap: '8px' },
});

export interface IssuePropertiesProps {
  task: Task;
  /** This project's tickets — epic candidates and the milestone manager's counts. */
  tickets: Task[];
  people: Person[];
  /** The repos a card can be delegated to — the agent's name and the model's project default. */
  agentProjects: Project[];
  labels: TicketLabel[];
  milestones: Milestone[];
  /** The tracker projects the archived-ticket banner reads. */
  projects?: Project[];
  chainLinks: readonly TaskLink[];
  chainTasksById: ReadonlyMap<string, Task>;
  mergeRequests: readonly MergeRequest[];
  /** The host is unreachable: plain values, no click-to-edit. */
  readOnly?: boolean;
  onTaskChanged: (task: Task) => void;
  onStatusSet?: (status: ManualStatus) => void;
  /** After a status move, so the timeline refreshes. */
  onEdited?: () => void;
  /** The model for the next run — `null` hands the card back to its project's models. */
  onModelChange: (model: ClaudeModel | null) => void;
  /** Which editor is open on first render — for the render test, which cannot click. */
  defaultEditing?: PropertyEditor | null;
}

export function IssueProperties({
  task,
  tickets,
  people,
  agentProjects,
  labels,
  milestones,
  projects,
  chainLinks,
  chainTasksById,
  mergeRequests,
  readOnly = false,
  onTaskChanged,
  onStatusSet,
  onEdited,
  onModelChange,
  defaultEditing = null,
}: IssuePropertiesProps): JSX.Element {
  const styles = useStyles();
  const labelOf = useModelLabels();
  const [editing, setEditing] = useState<PropertyEditor | null>(readOnly ? null : defaultEditing);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [moreOpen, toggleMore] = useDeviceFold('tm.issue.moreFieldsOpen', false);
  const columnRef = useRef<HTMLDivElement>(null);
  /** The row whose editor just closed — its value gets the focus back, for the keyboard. */
  const returnFocus = useRef<PropertyEditor | null>(null);

  const ticketSave = useTicketFieldSave(task);
  const status = useStatusSetter({
    task,
    onTaskChanged,
    onStatusSet,
    onEdited,
    onError: setStatusError,
    chainLinks,
    chainTasksById,
    mergeRequests,
  });

  const agentProject = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;
  const agentName = delegatedAgentName(task, agentProject?.name);
  const rows = issuePropertyRows({
    task,
    people,
    milestones,
    agentName,
    modelCaption: cardModelCaption(task, agentProject, labelOf),
    chainLinks,
    chainTasksById,
    readOnly,
  });

  // Another card, or the host going away, closes whatever editor was open.
  useEffect(() => {
    setEditing(null);
    setStatusError(null);
  }, [task.id, readOnly]);

  useEffect(() => {
    if (editing !== null || returnFocus.current === null) return;
    const key = returnFocus.current;
    returnFocus.current = null;
    columnRef.current
      ?.querySelector<HTMLElement>(`[data-property-editor="${key}"] [data-property-value]`)
      ?.focus();
  }, [editing]);

  function open(editor: PropertyEditor): void {
    setEditing((current) => nextEditing(current, { type: 'open', editor }, readOnly));
  }
  function close(): void {
    returnFocus.current = editing;
    setEditing((current) => nextEditing(current, { type: 'close' }));
  }
  /** The editor's list closing — a pick, Esc, or a click away — is the editor being done. */
  const onOpenChange = (isOpen: boolean): void => {
    if (!isOpen) close();
  };

  function editorFor(editor: PropertyEditor): JSX.Element {
    switch (editor) {
      case 'status':
        return (
          <StatusDropdown
            task={task}
            autoFocus
            onOpenChange={onOpenChange}
            onSelect={(next: ManualStatus) => void status.setStatus(next)}
          />
        );
      case 'assignee':
        return (
          <TicketAssigneeField
            bare
            ticket={task}
            people={people}
            autoFocus
            onOpenChange={onOpenChange}
            onSave={(v) => void ticketSave.saveField('assigneeId', v)}
          />
        );
      case 'milestone':
        return (
          <TicketMilestoneField
            bare
            ticket={task}
            tickets={tickets}
            milestones={milestones}
            autoFocus
            onOpenChange={onOpenChange}
            onSave={(v) => void ticketSave.saveField('milestoneId', v)}
          />
        );
      case 'model':
        // No custom box, as in the composer's strip: typing a new model id is the assign
        // dialog's job, and a box here would close the moment the list did.
        return (
          <ModelField
            size="small"
            allowCustom={false}
            autoFocus
            onOpenChange={onOpenChange}
            value={task.agentModel ?? PROJECT_DEFAULT}
            sentinel={{ value: PROJECT_DEFAULT, label: projectDefaultLabel(agentProject, labelOf) }}
            onChange={(v) => onModelChange(cardModelFromOption(v))}
          />
        );
    }
  }

  function errorFor(row: PropertyRow): string | null {
    if (row.key === 'status') return statusError;
    if (row.key === 'assignee') return ticketSave.errors.assigneeId ?? null;
    if (row.key === 'milestone') return ticketSave.errors.milestoneId ?? null;
    return null;
  }

  /** The icon before a value — Status, Assignee and Milestone only, as the mockup draws. */
  function iconFor(row: PropertyRow): JSX.Element | null {
    if (row.key === 'status') {
      const column = columnForTask(task);
      return (
        <span className={styles.icon} data-property-icon={`status-${column}`}>
          {STATUS_GLYPH[column]}
        </span>
      );
    }
    if (row.key === 'assignee') {
      // A delegated card reads as the agent's; a person alone shows their avatar.
      const person = people.find((p) => p.id === task.assigneeId);
      return (
        <span
          className={styles.icon}
          data-property-icon={agentName ? 'agent' : person ? 'person' : 'unassigned'}
        >
          {agentName ? (
            <AgentGlyph />
          ) : person ? (
            <PersonAvatar person={person} size={16} />
          ) : (
            <PersonRegular />
          )}
        </span>
      );
    }
    if (row.key === 'milestone') {
      return (
        <span className={styles.icon} data-property-icon="milestone">
          <FlagRegular />
        </span>
      );
    }
    return null;
  }

  function valueFor(row: PropertyRow): JSX.Element {
    if (row.blockedBy) {
      return (
        <div className={styles.links}>
          {row.blockedBy.map((card) => (
            <span
              key={card.taskId}
              className={styles.blocker}
              title={card.key ? `${card.key} ${card.title}` : card.title}
              data-blocked-by={card.taskId}
            >
              {card.key && <span className={styles.blockerKey}>{card.key}</span>}
              <span className={styles.blockerTitle}>{card.title}</span>
            </span>
          ))}
        </div>
      );
    }
    const empty = row.value === 'None' || row.value === 'Unassigned';
    const icon = iconFor(row);
    const text = (
      <span className={styles.value}>
        {icon}
        <Body1
          className={`${styles.valueText} ${empty ? styles.empty : ''}`}
          title={row.value ?? undefined}
        >
          {row.value}
        </Body1>
      </span>
    );
    if (!row.editor) return text;
    const editor = row.editor;
    return (
      <button
        type="button"
        className={styles.valueButton}
        title={`Change ${row.label.toLowerCase()}`}
        data-property-value
        onClick={() => open(editor)}
      >
        {text}
      </button>
    );
  }

  const native = isNativeTicket(task);

  return (
    <div className={styles.column} ref={columnRef}>
      {native && (
        <ArchivedTicketBanner
          ticket={task}
          milestones={milestones}
          tickets={tickets}
          projects={projects}
          readOnly={readOnly}
        />
      )}
      <div className={styles.list}>
        {rows.map((row) => {
          const isEditing = row.editor !== undefined && editing === row.editor;
          const error = errorFor(row);
          return (
            <div
              key={row.key}
              className={`${styles.row} ${row.editor ? styles.editable : ''}`}
              data-property={row.key}
              data-property-editor={row.editor}
            >
              <Caption1 className={styles.label}>{row.label}</Caption1>
              {/* The editor opens in the value's own cell, so the label never moves. */}
              <div className={styles.cell} data-property-cell>
                {isEditing && row.editor ? (
                  <div
                    data-property-editing
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') close();
                    }}
                    onBlur={(e) => {
                      // Focus moving within the editor (its own list) is not leaving it.
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
                    }}
                  >
                    {editorFor(row.editor)}
                  </div>
                ) : (
                  valueFor(row)
                )}
                {error && <Caption1 className={styles.error}>{error}</Caption1>}
              </div>
            </div>
          );
        })}
      </div>
      {native && (
        <div className={styles.more}>
          <FoldToggle open={moreOpen} onToggle={toggleMore}>
            <Text weight="semibold">More fields</Text>
          </FoldToggle>
          {moreOpen && (
            <TicketFieldsSection
              ticket={task}
              tickets={tickets}
              people={people}
              agentProjects={agentProjects}
              labels={labels}
              milestones={milestones}
              readOnly={readOnly}
              omit={['milestone', 'assignee', 'estimate', 'due']}
            />
          )}
        </div>
      )}
      {status.dialog}
    </div>
  );
}
