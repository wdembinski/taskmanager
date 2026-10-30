/**
 * AssignAgentDialog — delegate one My Tasks card to an agent.
 *
 * The card never leaves the Personal board; what this picks is the **agent project**
 * (a repo directory, managed in the desktop app's Projects screen) the run happens in,
 * plus the model and permission mode that run uses. The project is pre-filled from the
 * card's filing or its ticket's epic (`seedAssignProject`), so for a filed or linked card
 * the whole dialog is usually one click — but a card that cannot say where it should run
 * (filed under a project with no repo, or not filed at all) seeds an empty picker rather
 * than guessing: the Assign buttons stay disabled until the human names a project.
 *
 * Confirming calls `task:assignAgent`, which records the instructions on the task's timeline
 * and starts the agent immediately (Assign without starting stages it instead). The one
 * exception is an account-wide usage limit: the assignment still sticks and the engine parks
 * the card in the gate to start at the reset, which comes back as an ordinary success here —
 * the dialog closes, and the detail pane is where the wait is explained.
 *
 * This dialog renders in BOTH hosts — apps/web reaches it through the shared `TaskDetail`'s
 * `TaskAgentPanel` — which is why the empty state below names the desktop app explicitly.
 * Creating an agent project is deliberately desktop-only (it needs a folder picker on the
 * machine the engine runs on), and the web app has no Projects screen of its own to send
 * anyone to: an instruction that is true in one host and a dead end in the other reads as a
 * broken screen rather than as the decision it is.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Body1,
  Button,
  Input,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  Textarea,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import type { PermissionMode } from '@tm/shared/session';
import type { BoardScope } from '@tm/shared/ipc';
import { AGENT_ROLES } from '@tm/shared/model';
import type { Project, Task } from '@tm/shared/model';
import { estimateRun, type RunEstimate } from '@tm/shared/runEstimate';
import { DEFAULT_EFFORTS } from '@tm/shared/settings';
import { useModelLabels } from './ModelField';
import { RolesTable, type RoleRow } from './RolesTable';
import {
  emptyRoles,
  fallbackModel,
  roleWrites,
  seedRoles,
  setRoleEffort,
  setRoleModel,
  shownEffort,
  type RoleWrites,
  type RolesState,
} from './rolesTableModel';
import { variantCountNote, type AssignCount } from './variantCount';
import {
  BRANCH_TYPES,
  buildBranchName,
  inferBranchType,
  validateBranchName,
  type BranchType,
} from '@tm/shared/branchName';
import { seedAssignProject } from '@tm/shared/agentProjects';
import type { PromptTemplate } from '@tm/shared/promptTemplates';
import {
  modeForPickedProject,
  NO_AGENT_PROJECTS_MESSAGE,
  PERMISSION_MODES,
  seedPermissionMode,
} from './agentPickers';
import { SkillPicker } from './SkillPicker';
import { TemplateMenu } from './TemplateMenu';
import { applyTemplateToText, templateVarsForTask } from './templateInsert';
import { useSkillOptions } from './useSkillOptions';
import { useWorkflowOptions } from './useWorkflowOptions';
import { applyOutcome, reconcileSelection } from './workflowPickerState';
import { useTransport } from './transport';

/** Same length, same refs in the same order — whether the picker has anything unsaved. */
function sameSkillRefs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((ref, i) => ref === b[i]);
}

/** The Workflow dropdown's "no workflow" row — `workflowId` stays `null` while it's picked. */
const WORKFLOW_NONE = '';
const WORKFLOW_NONE_LABEL = 'None — the agent plans its own work';

const useStyles = makeStyles({
  /**
   * The surface, sized to the form rather than the other way round.
   *
   * The form asked for `minWidth: 560px` while the surface kept Fluent's default 600px cap
   * and its own 24px padding either side — so the content was 560 wide inside 552 of usable
   * room and simply overflowed, which is what made the dialog look broken. The surface is
   * now the thing with the width, capped at the viewport so a small window narrows it
   * instead of pushing the buttons off the edge.
   *
   * `maxHeight` + a scrolling body for the same reason on the other axis: eight fields, two
   * hints and a paragraph do not fit a short window, and a dialog whose Assign button is
   * below the fold is a dialog you cannot use.
   */
  surface: { maxWidth: 'min(780px, calc(100vw - 48px))', width: '100%' },
  /**
   * Capped near v11-4's 650px frame too: the roles section and the footer stay in view and
   * the fields below the roles scroll, rather than the dialog growing past the window.
   */
  body: { maxHeight: 'min(590px, calc(100vh - 160px))' },
  /**
   * `minWidth: 0` and not a fixed one: the surface owns the width now, and a min-width here
   * would put it straight back to overflowing the moment the window got narrow.
   */
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  /**
   * Wraps rather than squeezing: two dropdowns side by side need real width each.
   *
   * `alignItems: start` because the fields in a row rarely have the same height — Branch
   * carries a hint (or a validation message) and Type does not — and the default `stretch`
   * makes the shorter field's box as tall as its neighbour for no reason.
   */
  row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'start' },
  /** Narrow — a Conventional Commits type is six characters at most. */
  type: { width: '120px', flexShrink: 0 },
  /** `minWidth` so a flex child can actually shrink instead of forcing the row wider. */
  grow: { flex: 1, minWidth: '180px' },
  /**
   * Let a Dropdown be as wide as the Field around it, and no wider.
   *
   * Fluent's Dropdown hard-codes `minWidth: 250px` on its own root, which a `Field` cannot
   * override from the outside — so the Type field, sized to 120px above, rendered a 250px
   * control that spilled out of its slot and painted straight over the Branch field beside
   * it. The layout was never wrong; the control simply refused to fit it.
   *
   * Applied to EVERY dropdown here, not just Type: two 250px minimums plus the gap exceed
   * the surface as soon as the window is narrow, and the same overflow would come back on
   * the Model / Permission mode row.
   */
  dropdown: { minWidth: 0, width: '100%' },
  hint: { color: tokens.colorNeutralForeground3 },
  /** The card's key ahead of the title, mono and muted (v11-4). */
  key: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground4,
    marginRight: '12px',
  },
  /** The hairlines framing the roles section. */
  divider: {
    height: 0,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  estimate: { alignItems: 'center', gap: '12px' },
  estimateLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  estimateValue: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre',
  },
  /** The Instructions textarea plus its template menu, side by side. */
  notesRow: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
  notesArea: { flex: 1, minWidth: 0 },
  /** The ×1 ×2 ×3 segmented control and its "≈ N sessions" note, in one row. */
  countRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
});

export interface AssignAgentDialogProps {
  open: boolean;
  /** The card being delegated (null closes the dialog's content). */
  task: Task | null;
  /** Every agent project (from `project:list`), for the picker. */
  agentProjects: Project[];
  /**
   * Every project a card can be FILED under (`TaskDetail`'s wider `projects` list) — used
   * only to NAME the project in the empty-picker hint below, never to seed it: a filing
   * project may have no repo at all, which is exactly the case that hint explains.
   */
  filingProjects?: BoardScope[];
  /** How many steps the card already has — the estimate counts a session per step. */
  stepCount?: number;
  onClose: () => void;
  /** The updated task, so the board can patch the card without a refresh. */
  onAssigned: (task: Task) => void;
}

export function AssignAgentDialog({
  open,
  task,
  agentProjects,
  filingProjects = [],
  stepCount = 0,
  onClose,
  onAssigned,
}: AssignAgentDialogProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [projectId, setProjectId] = useState<string>('');
  // The card's OWN model and effort per role (F28.1); null = "follow the next rung", and
  // the dialog's default. See the seeding below and `rolesTableModel.ts`.
  const [roles, setRoles] = useState<RolesState>(emptyRoles);
  // The app's effort per role — the last rung the effort controls show. Read from settings
  // on open; the out-of-the-box value until that answers.
  const [defaultEfforts, setDefaultEfforts] = useState(DEFAULT_EFFORTS);
  // What this project's past sessions cost, for the estimate line. Null = no line.
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  // ×1 is Assign agent as it always was; ×2/×3 start a variant group instead — see
  // `variantCountNote`. Reset on open, same as every other field below.
  const [count, setCount] = useState<AssignCount>(1);
  const [notes, setNotes] = useState('');
  // The card's own skillRefs, seeded on open — see the effect below.
  const [skillRefs, setSkillRefs] = useState<string[]>([]);
  // The workflow to apply after assigning, or null for "the agent plans its own work" —
  // always reset to null on open, never seeded from the card (see the effect below).
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  // The branch, and the Conventional Commits type it is proposed from. `branchTouched`
  // is what stops re-proposing over a name the human has edited.
  const [branchType, setBranchType] = useState<BranchType>('feat');
  const [branch, setBranch] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The Instructions textarea, so a template can land where the caret actually is. */
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Seed once per opening — keyed on the card, not the task object, so a background
  // JIRA sync replacing it can't wipe what the user is halfway through typing.
  const latest = useRef({ task, agentProjects, filingProjects });
  latest.current = { task, agentProjects, filingProjects };
  useEffect(() => {
    if (!open) return;
    const { task: card, agentProjects: projects } = latest.current;
    if (!card) return;
    setError(null);
    setNotes('');
    setCount(1);
    setSkillRefs(card.skillRefs ?? []);
    setWorkflowId(null);
    const resolved = seedAssignProject(card, projects);
    setProjectId(resolved?.id ?? '');
    // The card's own model ONLY: reading the project's in as a seed made a fresh assignment
    // save an override nobody asked for, pinning the card to the repo's execution model and
    // quietly excluding it from the repo's planning one. An untouched field now stores null,
    // and the card follows the project the way an unopened dialog would have left it.
    //
    // The one-shot in `store.ts` let go of the overrides this dialog had already written;
    // this line is what stops it writing them again.
    //
    // The same holds for every role's model and effort: the table SHOWS the resolved value
    // but seeds only what the card already chose.
    setRoles(seedRoles(card));
    setMode(seedPermissionMode(card, resolved));
    setBranchTouched(false);
    const type = inferBranchType({
      title: card.title,
      taskType: card.type,
      issueType: card.issueType,
      externalType: card.externalType,
    });
    setBranchType(type);
    // The card's saved branch wins: re-opening the dialog on an assigned card must show
    // the branch its worktree is actually on, not a fresh proposal that disagrees with it.
    void transport
      .invoke('settings:get')
      .then((settings) => {
        setPrefix(settings.branchPrefix);
        setDefaultEfforts(settings.defaultEfforts ?? DEFAULT_EFFORTS);
        setBranch(
          card.agentBranch ??
            buildBranchName({
              title: card.title,
              externalType: card.externalType,
              externalKey: card.externalKey,
              prefix: settings.branchPrefix,
              type,
            }),
        );
      })
      .catch(() => setBranch(card.agentBranch ?? ''));
  }, [open, task?.id]);

  /** Re-propose from a newly picked type — unless the human has edited the name. */
  function pickBranchType(type: BranchType): void {
    setBranchType(type);
    if (branchTouched || !task) return;
    setBranch(
      buildBranchName({
        title: task.title,
        externalType: task.externalType,
        externalKey: task.externalKey,
        prefix,
        type,
      }),
    );
  }

  /**
   * Switching repo also switches to that repo's defaults — they're per-project settings.
   *
   * The model is the exception, and deliberately: it is already "follow the project" unless
   * the human overrode it, so it follows the NEW project by doing nothing. Copying the
   * repo's model in here would turn every project switch into an override — and one that
   * names the execution model, silently opting the card out of the planning one.
   */
  function pickProject(id: string): void {
    setProjectId(id);
    setMode((current) => modeForPickedProject(agentProjects, id, current));
  }

  /** ×2/×3 are out of scope for a workflow — picking one forces back to a single attempt. */
  function pickWorkflow(id: string | null): void {
    setWorkflowId(id);
    if (id) setCount(1);
  }

  /** Insert a picked template into Instructions at the caret, replacing any selection. */
  function pickTemplate(template: PromptTemplate): void {
    if (!task) return;
    const el = notesRef.current;
    const selection = el ? { start: el.selectionStart, end: el.selectionEnd } : notes.length;
    const vars = templateVarsForTask(task, selected);
    const { text, caret } = applyTemplateToText(notes, selection, template, vars);
    setNotes(text);
    requestAnimationFrame(() => {
      const node = notesRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(caret, caret);
      }
    });
  }

  /** The delegation itself — agent project, role/mode overrides, instructions, branch. */
  function buildAssignInput(): RoleWrites & {
    agentProjectId: string;
    mode: PermissionMode;
    notes: string | undefined;
    branch: string | undefined;
  } {
    return {
      agentProjectId: projectId,
      mode,
      // Each role's model and effort, omitted rather than null: `task:assignAgent` maps a
      // missing field to null, which is the same "follow the next rung" the table means.
      ...roleWrites(roles),
      notes: notes.trim() || undefined,
      branch: branch.trim() || undefined,
    };
  }

  /**
   * The delegation, plus — when a workflow is picked — turning it into the card's own
   * steps right after. The assign itself always starts `false` in that case: the workflow's
   * steps are what `start` should honour, via `task:run` once they exist, not the agent's
   * own (nonexistent) planning.
   */
  async function assign(start: boolean): Promise<void> {
    if (!task || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (!sameSkillRefs(skillRefs, task.skillRefs ?? [])) {
        await transport.invoke('task:setSkillRefs', task.id, skillRefs);
      }
      const updated = await transport.invoke('task:assignAgent', task.id, {
        ...buildAssignInput(),
        start: workflowId ? false : start,
      });
      onAssigned(updated);

      if (workflowId) {
        const outcome = applyOutcome(await transport.invoke('workflow:apply', task.id, workflowId));
        if (outcome.kind === 'refused') {
          // The assignment already stuck — only the workflow failed to apply — so the
          // dialog stays open on a sentence that says exactly that, rather than closing on
          // a step that didn't happen.
          setError(
            `Assigned, but the workflow could not be applied: ${outcome.sentence}` +
              (outcome.issues && outcome.issues.length > 0 ? ` ${outcome.issues.join(' ')}` : ''),
          );
          return;
        }
        if (start) {
          await transport.invoke('task:run', task.id);
        }
      }

      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** ×2/×3: fan the same delegation out over `count` hidden rows instead of the card. */
  async function startVariants(): Promise<void> {
    if (!task || !projectId || count === 1) return;
    setBusy(true);
    setError(null);
    try {
      if (!sameSkillRefs(skillRefs, task.skillRefs ?? [])) {
        await transport.invoke('task:setSkillRefs', task.id, skillRefs);
      }
      const result = await transport.invoke(
        'task:startVariants',
        task.id,
        count,
        buildAssignInput(),
      );
      onAssigned(result.leader);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Repo skills follow the project picked ABOVE, not the card's prior one — switching repo
  // mid-dialog switches what the picker can offer, same as the model/mode defaults do.
  const skillState = useSkillOptions(projectId || null);
  const workflowState = useWorkflowOptions(open);
  // Clears the selection if the list comes back without it (e.g. a workflow deleted while
  // this dialog was open) — never seeds one, since the field itself starts at "None" on
  // every open.
  useEffect(() => {
    setWorkflowId((id) => reconcileSelection(id, workflowState.workflows));
  }, [workflowState.workflows]);
  const selected = agentProjects.find((p) => p.id === projectId) ?? null;
  const labelOf = useModelLabels();
  // Each role's row: the default option names the model it actually falls back to right
  // now (other roles' picks included), and the effort shown is the resolved one.
  const roleRows: RoleRow[] = AGENT_ROLES.map((role) => ({
    role,
    model: roles[role].model,
    sentinelLabel: selected ? labelOf(fallbackModel(role, roles, selected)) : 'Project default',
    effort: shownEffort(role, roles, selected, defaultEfforts),
  }));

  // The estimate follows the project picked above: its own run history, never a price list.
  useEffect(() => {
    if (!open || !projectId) {
      setEstimate(null);
      return;
    }
    let live = true;
    void transport
      .invoke('project:runStats', projectId)
      .then((stats) => {
        // An answer that is not a summary (a host with no history to give) is no line.
        if (live)
          setEstimate(
            typeof stats?.sessionCount === 'number' ? estimateRun(stats, stepCount) : null,
          );
      })
      .catch(() => live && setEstimate(null));
    return () => {
      live = false;
    };
  }, [open, projectId, stepCount]);
  // Validated on every keystroke with the SAME rules the engine applies before cutting a
  // worktree, so a name that will be rejected is rejected here — where you can still fix
  // it — rather than several seconds later inside git's stderr.
  const trimmedBranch = branch.trim();
  const branchCheck = trimmedBranch ? validateBranchName(trimmedBranch) : null;
  const branchError =
    trimmedBranch && branchCheck && !branchCheck.ok
      ? `That won't work: ${branchCheck.reason}.`
      : null;
  // The mockup's header: the card's key in mono, then what this dialog does to it.
  const ticketKey = task ? (task.externalKey ?? task.ticketKey ?? null) : null;
  // Names the project in the empty-picker hint below, when that's WHY it's empty: the card
  // is filed somewhere, that project just isn't an agent project (no repo). `filingProjects`
  // rather than `agentProjects` because the project we need to name is exactly the one
  // `agentProjects` excludes.
  const filedProjectId = task ? (task.projectTagId ?? task.agentProjectId ?? null) : null;
  const filedProject = filedProjectId
    ? (filingProjects.find((p) => p.id === filedProjectId) ?? null)
    : null;

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody className={styles.body}>
          <DialogTitle>
            {ticketKey && <span className={styles.key}>{ticketKey}</span>}
            Start: {task?.title ?? ''}
          </DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {agentProjects.length === 0 ? (
                <MessageBar intent="warning">
                  <MessageBarBody>{NO_AGENT_PROJECTS_MESSAGE}</MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  {!projectId && filedProject && (
                    <MessageBar intent="info">
                      <MessageBarBody>
                        This card is filed under {filedProject.name}, which has no repository for an
                        agent to work in. Pick where this run should happen — the filing is not
                        changed.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  <Field
                    label="Agent project"
                    required
                    hint={selected ? selected.path : 'The repository the agent works in.'}
                  >
                    <Dropdown
                      className={styles.dropdown}
                      value={selected?.name ?? ''}
                      selectedOptions={projectId ? [projectId] : []}
                      onOptionSelect={(_e, d) => d.optionValue && pickProject(d.optionValue)}
                    >
                      {agentProjects.map((p) => (
                        <Option key={p.id} value={p.id} text={p.name}>
                          {p.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>

                  {/* F28.4/F28.5's "How it runs" and Lead rows go here, above the roles. */}

                  <div className={styles.divider} />
                  <RolesTable
                    rows={roleRows}
                    disabled={busy}
                    onModelChange={(role, m) => setRoles((r) => setRoleModel(r, role, m))}
                    onEffortChange={(role, e) => setRoles((r) => setRoleEffort(r, role, e))}
                  />
                  <div className={styles.divider} />

                  {/* F28.4/F28.5's Limits and "Ask me when" rows go here, below the roles. */}

                  <Field
                    label="Workflow (optional)"
                    hint="The workflow's steps replace the agent's own planning."
                  >
                    <Dropdown
                      className={styles.dropdown}
                      value={
                        workflowId
                          ? (workflowState.workflows.find((w) => w.id === workflowId)?.name ?? '')
                          : WORKFLOW_NONE_LABEL
                      }
                      selectedOptions={[workflowId ?? WORKFLOW_NONE]}
                      onOptionSelect={(_e, d) =>
                        pickWorkflow(
                          d.optionValue === WORKFLOW_NONE ? null : (d.optionValue ?? null),
                        )
                      }
                    >
                      <Option value={WORKFLOW_NONE} text={WORKFLOW_NONE_LABEL}>
                        {WORKFLOW_NONE_LABEL}
                      </Option>
                      {workflowState.workflows.map((w) => (
                        <Option key={w.id} value={w.id} text={w.name}>
                          {w.name} · {w.caption}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>

                  {/* ×1 is Assign agent exactly as it always was. ×2/×3 start a variant
                      group instead — N hidden rows running the same card, compared once
                      they finish — so the secondary Assign button below is disabled for
                      those two: a variant group always starts immediately. A workflow is
                      also out of scope for a variant group, so picking one forces ×1 too
                      (see `pickWorkflow`) and disables ×2/×3 here. */}
                  <Field label="How many attempts">
                    <div className={styles.countRow}>
                      {([1, 2, 3] as const).map((n) => (
                        <ToggleButton
                          key={n}
                          size="small"
                          appearance="subtle"
                          checked={count === n}
                          disabled={Boolean(workflowId) && n !== 1}
                          title={
                            workflowId && n !== 1
                              ? 'A workflow always runs as a single attempt.'
                              : undefined
                          }
                          onClick={() => setCount(n)}
                        >
                          ×{n}
                        </ToggleButton>
                      ))}
                      {variantCountNote(count, selected?.concurrency ?? 1) && (
                        <Body1 className={styles.hint}>
                          {variantCountNote(count, selected?.concurrency ?? 1)}
                        </Body1>
                      )}
                    </div>
                  </Field>

                  <div className={styles.row}>
                    <Field label="Permission mode" className={styles.grow}>
                      <Dropdown
                        className={styles.dropdown}
                        value={PERMISSION_MODE_LABELS[mode]}
                        selectedOptions={[mode]}
                        onOptionSelect={(_e, d) => setMode(d.optionValue as PermissionMode)}
                      >
                        {PERMISSION_MODES.map((m) => (
                          <Option key={m} value={m} text={PERMISSION_MODE_LABELS[m]}>
                            {PERMISSION_MODE_LABELS[m]}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  </div>

                  <div className={styles.row}>
                    <Field label="Type" className={styles.type}>
                      <Dropdown
                        className={styles.dropdown}
                        value={branchType}
                        selectedOptions={[branchType]}
                        onOptionSelect={(_e, d) => pickBranchType(d.optionValue as BranchType)}
                      >
                        {BRANCH_TYPES.map((t) => (
                          <Option key={t} value={t} text={t}>
                            {t}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field
                      label="Branch"
                      className={styles.grow}
                      validationState={branchError ? 'error' : 'none'}
                      validationMessage={branchError ?? undefined}
                      hint={
                        branchError
                          ? undefined
                          : 'The agent works here. Edit it freely — the type above only proposes.'
                      }
                    >
                      <Input
                        value={branch}
                        onChange={(_e, d) => {
                          setBranchTouched(true);
                          setBranch(d.value);
                        }}
                        placeholder="feat/abc-123/add-the-thing"
                      />
                    </Field>
                  </div>

                  <Field
                    label="Instructions (optional)"
                    hint="Added to the task's timeline and handed to the agent with the ticket."
                  >
                    <div className={styles.notesRow}>
                      <Textarea
                        className={styles.notesArea}
                        value={notes}
                        resize="vertical"
                        textarea={{ ref: notesRef }}
                        onChange={(_e, d) => setNotes(d.value)}
                        placeholder="Anything the ticket doesn't say — where to start, what to avoid…"
                      />
                      {task && <TemplateMenu surface="assign" onPick={pickTemplate} />}
                    </div>
                  </Field>

                  <Field label="Skills">
                    <SkillPicker
                      options={skillState.options}
                      own={skillRefs}
                      onChange={setSkillRefs}
                      loading={skillState.loading}
                    />
                  </Field>

                  <Body1 className={styles.hint}>
                    The agent works on its own branch in a separate worktree, and never writes
                    anything back to JIRA. <b>Assign</b> sets all this up without starting it, so
                    you can talk to it about the card first — your first message starts it.
                  </Body1>
                </>
              )}
            </div>
          </DialogContent>
          {/* The estimate line, left of the buttons — omitted with no run history to base it on. */}
          <DialogActions position="start" className={styles.estimate}>
            {estimate && (
              <>
                <span className={styles.estimateLabel}>Estimate</span>
                <span className={styles.estimateValue} data-run-estimate>
                  {`${estimate.cost}  ·  ${estimate.sessions}  ·  ${estimate.duration}`}
                </span>
              </>
            )}
          </DialogActions>
          <DialogActions position="end">
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {/* Assigning and starting used to be the same act, which left no way to
                discuss a card with its agent before it began changing files. */}
            <Button
              appearance="secondary"
              onClick={() => void assign(false)}
              // A variant group always starts right away — there is no card left idle to
              // talk to first, only N rows about to run — so ×2/×3 disable this button
              // rather than offer a no-start path nothing downstream can act on.
              disabled={busy || !projectId || branchError !== null || count !== 1}
              title="Set the agent up on this card without starting it."
            >
              Assign
            </Button>
            <Button
              appearance="primary"
              onClick={() => void (count === 1 ? assign(true) : startVariants())}
              disabled={busy || !projectId || branchError !== null}
            >
              {busy ? 'Starting…' : count === 1 ? 'Start' : `Start ${count} variants`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
