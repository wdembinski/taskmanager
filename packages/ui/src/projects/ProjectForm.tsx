/**
 * The project add/edit drawer — shared by the desktop's own `Projects` screen and the Tickets
 * workspace's `ProjectAdmin`, since a repo project and a ticket-only project are the same
 * `project:*` object, just missing a folder.
 *
 * Repo fields — the folder + Browse, "Runs on", the isolated-worktrees switch, `BaseBranchField`,
 * and the three per-project automation switches (auto-merge, auto-release, auto-PR) — render
 * only when the host supplies `repo`, a small capability object. `project:pickDirectory` is
 * `host-only`
 * (`packages/shared/src/ipcRelay.ts`) — a browser tab pointed at a remote engine has no local
 * folder to browse for — so a host without `repo` (the Tickets workspace) gets a form with
 * nothing about a directory in it, same as `ProjectAdmin`'s own dialog did before this existed.
 * `exec:listDistros` itself relays fine either way; only the "Runs on" FIELD travels with the
 * capability, because a target means nothing without a folder to run it against.
 *
 * The git preflight (`useGitPreflight`) stays in the desktop renderer rather than moving here —
 * it calls `window.api` directly, which this package cannot reach — so the host runs it and
 * hands the result down as `gitPreflight`. Since this form (not the host) owns the path/target
 * state the hook needs, `onFolderChange` echoes every change back up so the host can keep the
 * hook fed.
 */
import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  SpinButton,
  Switch,
  Textarea,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  MessageBar,
  MessageBarBody,
  OverlayDrawer,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import {
  AUTO_MERGE_BY,
  AUTO_MERGE_BY_LABELS,
  AUTO_MERGE_METHODS,
  AGENT_ROLES,
  hasPlan,
  hasRepo,
  ownsTickets,
  type AutoMergeBy,
  type AutoMergeMethod,
  type GitPreflight,
  type Project,
} from '@tm/shared/model';
import { PERMISSION_MODE_LABELS, type PermissionMode } from '@tm/shared/session';
import { DEFAULT_EFFORTS } from '@tm/shared/settings';
import { RELEASE_DOC } from '@tm/shared/release';
import { suggestTicketPrefix } from '@tm/shared/ticketKey';
import { DEFAULT_READY_LANES } from '@tm/shared/readyLanes';
import {
  clampAiReviewMaxRounds,
  DEFAULT_AI_REVIEW_MAX_ROUNDS,
  MAX_AI_REVIEW_MAX_ROUNDS,
} from '@tm/shared/aiVisualReview';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
  type ExecTarget,
} from '@tm/shared/execTarget';
import { distroFromWindowsPath, pathSuitsHost, windowsToLinux } from '@tm/shared/wslPath';
import { describeGitPreflight } from '@tm/shared/gitPreflight';
import { BaseBranchField } from '../BaseBranchField';
import { ColorSwatches } from '../ColorSwatches';
import { RolesTable, type RoleRow } from '../RolesTable';
import { useTransport } from '../transport';
import { ProjectBasicsFields } from './ProjectBasicsFields';
import {
  projectRoleEffort,
  projectRoleSentinel,
  projectRoleWrites,
  seedProjectRoles,
  setProjectRoleEffort,
  setProjectRoleModel,
  ticketModeOf,
  ticketPrefixError,
  type ProjectRoles,
  type TicketMode,
} from './projectBasics';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '380px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  grow: { flex: 1 },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
  hint: { color: tokens.colorNeutralForeground3 },
  /** The roles section, framed by hairlines like the Start dialog's (v11-4). */
  roles: {
    display: 'flex',
    flexDirection: 'column',
    paddingTop: '12px',
    paddingBottom: '4px',
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

const AUTO_MERGE_METHOD_LABELS: Record<AutoMergeMethod, string> = {
  merge: 'Merge',
  squash: 'Squash',
  rebase: 'Rebase',
};

/** Split a free-text epic list ("ABC-1, ABC-2") into keys; the engine normalizes them. */
function parseEpicKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

/** Split a free-text, comma-separated check-name list ("gates, docker"). Commas only, unlike
 *  `parseEpicKeys` above — a CI check name may itself contain a space (e.g. a matrix job's
 *  own label), which a JIRA epic key never does. */
function parseCommaList(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** What only a host that can attach a repo to a project can do. */
export interface ProjectFormRepoCapability {
  /** Browse for the repo folder — `project:pickDirectory` is `host-only`, see file header. */
  onBrowseFolder: () => Promise<string | null>;
}

export interface ProjectFormProps {
  open: boolean;
  /** The project being edited; absent means "add". */
  project?: Project;
  /** Every other project, so a chosen ticket prefix can be checked against theirs. */
  projects: Project[];
  onClose: () => void;
  /** The created/updated project, so each host can do its own thing with it — the desktop
   *  ignores it, the Tickets workspace selects the project it just added. */
  onSaved: (project: Project) => void;
  /** Present only for a host that can attach a repo to a project. Absent, every repo field
   *  stays out of the form — see file header. */
  repo?: ProjectFormRepoCapability;
  /** The chosen folder's live git state, read by the host's own `useGitPreflight` (see file
   *  header). `null` while there is nothing to preflight, or `repo` is absent. */
  gitPreflight?: GitPreflight | null;
  /** Fired on every change to the folder path or "Runs on" target — including the seed when
   *  the form opens — so a host with `repo` can keep its own `useGitPreflight` fed with the
   *  current values, which it has no other way to reach. */
  onFolderChange?: (path: string, target: ExecTarget) => void;
}

/** Add / edit drawer. Repo-only fields (worktrees, branch, merge, release, epics, models, mode,
 *  concurrency, standing instructions) hide while the folder is empty — there is nothing for
 *  them to mean yet. The write-back switch is rarer still: it only surfaces for a legacy
 *  plan-driven project being edited, since this drawer never creates one (see `save()`). */
export function ProjectForm({
  open,
  project,
  projects,
  onClose,
  onSaved,
  repo,
  gitPreflight = null,
  onFolderChange,
}: ProjectFormProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  /** Only meaningful for a plan-less project — see `showModeChoice` below. Defaults to
   *  'tickets': the guarantee a plan-less project gets a prefix is the default, and
   *  Personal is the opt-out, not the other way round. */
  const [mode, setMode] = useState<TicketMode>('tickets');
  const [ticketPrefix, setTicketPrefix] = useState('');
  // Once the human edits the prefix directly, a later name edit must stop overwriting it.
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [epics, setEpics] = useState('');
  const [color, setColor] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [useWorktrees, setUseWorktrees] = useState(true);
  const [autoRelease, setAutoRelease] = useState(false);
  const [autoCreatePr, setAutoCreatePr] = useState(false);
  const [autoMergeOnGreen, setAutoMergeOnGreen] = useState(false);
  const [autoMergeMethod, setAutoMergeMethod] = useState<AutoMergeMethod>('squash');
  const [autoMergeRequiredChecks, setAutoMergeRequiredChecks] = useState('');
  const [autoMergeBy, setAutoMergeBy] = useState<AutoMergeBy>('forge');
  const [autoDoneOnLand, setAutoDoneOnLand] = useState(false);
  const [autoVisualSignOff, setAutoVisualSignOff] = useState(false);
  const [autoVisualSignOffMaxRounds, setAutoVisualSignOffMaxRounds] = useState(
    DEFAULT_AI_REVIEW_MAX_ROUNDS,
  );
  /** `null` = follow the app-wide setting, which is what a repo that never ruled does. */
  const [autoIntegrate, setAutoIntegrate] = useState<boolean | null>(null);
  const [autoApprovePlans, setAutoApprovePlans] = useState(false);
  const [autoApproveMaxSteps, setAutoApproveMaxSteps] = useState(6);
  const [readyLanes, setReadyLanes] = useState(DEFAULT_READY_LANES);
  /**
   * The app-wide merge switch as it stands. Read in both modes — setting this repo's
   * switch to what the app already says stores `null`, which is how it goes back to
   * following, and that comparison needs the app's answer even when editing.
   */
  const [appAutoIntegrate, setAppAutoIntegrate] = useState(false);
  /** The four role rows — see `ProjectRoles` for what `null` means in each. */
  const [roles, setRoles] = useState<ProjectRoles>(() =>
    seedProjectRoles(null, { defaultModel: 'sonnet', defaultPlanningModel: null }),
  );
  /** The app's effort per role — what a row the project never set shows picked. */
  const [defaultEfforts, setDefaultEfforts] = useState(DEFAULT_EFFORTS);
  const [permMode, setPermMode] = useState<PermissionMode>('acceptEdits');
  const [concurrency, setConcurrency] = useState(1);
  const [writeBackPlan, setWriteBackPlan] = useState(false);
  const [instructions, setInstructions] = useState('');
  /** `''` = this repo has no headless screenshot command; see `Project.uiVerifyCommand`. */
  const [uiVerifyCommand, setUiVerifyCommand] = useState('');
  const [target, setTarget] = useState<ExecTarget>(LOCAL_TARGET);
  const [distros, setDistros] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // path/target changes together, so the host's own git preflight (fed by onFolderChange)
  // always sees a value it can actually run against rather than the other half's stale one.
  function updatePath(next: string): void {
    setPath(next);
    onFolderChange?.(next, target);
  }
  function updateTarget(next: ExecTarget): void {
    setTarget(next);
    onFolderChange?.(path, next);
  }

  const hasRepoCapability = Boolean(repo);

  // Only offer targets that exist here: with no WSL installed the control never
  // appears, and the pane looks exactly as it did before. Meaningless without a folder to
  // run against, so skipped entirely for a host with no repo capability.
  useEffect(() => {
    if (!hasRepoCapability) return;
    void transport.invoke('exec:listDistros').then(setDistros);
  }, [hasRepoCapability, transport]);

  // Seed the form each time it opens — from the project when editing, from the
  // user's global defaults when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    // Needed whichever mode this is; the defaults fetch below only runs for a new project.
    void transport.invoke('settings:get').then((s) => {
      setAppAutoIntegrate(s.autoIntegrate);
      setDefaultEfforts(s.defaultEfforts ?? DEFAULT_EFFORTS);
    });
    if (project) {
      updatePath(project.path);
      setName(project.name);
      setMode(ticketModeOf(project));
      setTicketPrefix(project.ticketPrefix);
      setPrefixTouched(true); // an existing prefix is never overwritten by editing the name
      setEpics(project.jiraEpicKeys.join(', '));
      setColor(project.color);
      setBaseBranch(project.baseBranch);
      setUseWorktrees(project.useWorktrees);
      setAutoRelease(project.autoRelease);
      setAutoCreatePr(project.autoCreatePr);
      setAutoMergeOnGreen(project.autoMergeOnGreen);
      setAutoMergeMethod(project.autoMergeMethod);
      setAutoMergeRequiredChecks(project.autoMergeRequiredChecks.join(', '));
      setAutoMergeBy(project.autoMergeBy);
      setAutoDoneOnLand(project.autoDoneOnLand);
      setAutoVisualSignOff(project.autoVisualSignOff ?? false);
      setAutoVisualSignOffMaxRounds(
        project.autoVisualSignOffMaxRounds ?? DEFAULT_AI_REVIEW_MAX_ROUNDS,
      );
      setAutoIntegrate(project.autoIntegrate);
      setAutoApprovePlans(project.autoApprovePlans);
      setAutoApproveMaxSteps(project.autoApproveMaxSteps);
      setReadyLanes(project.readyLanes ?? DEFAULT_READY_LANES);
      setRoles(
        seedProjectRoles(project, {
          defaultModel: project.defaultModel,
          defaultPlanningModel: null,
        }),
      );
      setPermMode(project.defaultPermissionMode);
      setConcurrency(project.concurrency);
      setWriteBackPlan(project.writeBackPlan);
      setInstructions(project.instructions);
      setUiVerifyCommand(project.uiVerifyCommand ?? '');
      updateTarget(project.target);
    } else {
      updatePath('');
      setName('');
      setMode('tickets');
      setTicketPrefix('');
      setPrefixTouched(false);
      setEpics('');
      setColor('');
      setBaseBranch(''); // follow the checkout, exactly as before this field existed
      setUseWorktrees(true); // default on; only engages for git repos
      setAutoRelease(false); // releasing is opt-in, always
      setAutoMergeOnGreen(false); // merging itself is opt-in too, always
      setAutoMergeMethod('squash');
      setAutoMergeRequiredChecks('');
      setAutoDoneOnLand(false); // moving a card for the human is opt-in, always
      setAutoVisualSignOff(false); // so is a reviewer signing off for them
      setAutoVisualSignOffMaxRounds(DEFAULT_AI_REVIEW_MAX_ROUNDS);
      setAutoIntegrate(null); // and merging follows the app until this project says otherwise
      setAutoApprovePlans(false); // auto-approving a plan is opt-in, always
      setAutoApproveMaxSteps(6);
      setReadyLanes(DEFAULT_READY_LANES);
      setWriteBackPlan(false); // moot here — this dialog always adds plan-less (see save())
      setInstructions('');
      setUiVerifyCommand('');
      void transport.invoke('settings:get').then((s) => {
        setRoles(seedProjectRoles(null, s));
        setPermMode(s.defaultPermissionMode);
        setConcurrency(s.concurrency);
        updateTarget(s.defaultExecTarget);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open/project, not per render
  }, [open, project, transport]);

  // Suggest a prefix from the name, until the human types one of their own.
  useEffect(() => {
    if (prefixTouched) return;
    setTicketPrefix(suggestTicketPrefix(name));
  }, [name, prefixTouched]);

  /**
   * Browse for the repo folder.
   *
   * The Windows picker can walk into a distro, where it hands back a
   * `\\wsl.localhost\<distro>\…` path. That one path says both WHERE the repo is and
   * WHICH machine it belongs to, so picking it selects the target too, and the path is
   * stored in the Linux form the agent, git and the worktrees will actually use.
   */
  async function browseFolder(): Promise<void> {
    if (!repo) return;
    const picked = await repo.onBrowseFolder();
    if (!picked) return;
    const distro = distroFromWindowsPath(picked);
    if (distro) {
      updateTarget({ kind: 'wsl', distro });
      updatePath(windowsToLinux(picked));
    } else {
      updateTarget(LOCAL_TARGET);
      updatePath(picked);
    }
  }

  // The tickets-or-personal choice only means anything for a plan-less project — this
  // dialog always adds plan-less (see save()), and every plan-less board project is now
  // guaranteed a prefix unless it opts out as Personal (`store.addProject`/`updateProject`).
  // A legacy plan-driven project being edited was never part of either guarantee, so it
  // keeps its own always-shown, always-optional prefix field below instead of this choice.
  const showModeChoice = !project || !hasPlan(project);
  // Outside `showModeChoice`, `mode` still holds whatever `ticketModeOf` read off the
  // project being edited (usually 'personal' — a plan project rarely carries a prefix) but
  // means nothing there: the legacy field's own validation reads as if this project were
  // always in ticket mode, exactly as it did before this choice existed.
  const prefixError = ticketPrefixError({
    mode: showModeChoice ? mode : 'tickets',
    prefix: ticketPrefix,
    projects,
    editingId: project?.id,
  });
  const isPersonalChoice = showModeChoice && mode === 'personal';

  async function save(): Promise<void> {
    if (prefixError) {
      setError(prefixError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (project) {
        const updated = await transport.invoke('project:update', project.id, {
          path,
          name: name.trim() || undefined,
          ...projectRoleWrites(roles),
          defaultPermissionMode: permMode,
          concurrency,
          jiraEpicKeys: parseEpicKeys(epics),
          ticketPrefix: isPersonalChoice ? '' : ticketPrefix,
          personal: isPersonalChoice,
          color,
          target,
          baseBranch,
          useWorktrees,
          autoRelease,
          autoCreatePr,
          autoMergeOnGreen,
          autoMergeMethod,
          autoMergeRequiredChecks: parseCommaList(autoMergeRequiredChecks),
          autoMergeBy,
          autoVisualSignOff,
          autoVisualSignOffMaxRounds,
          autoDoneOnLand,
          autoIntegrate,
          autoApprovePlans,
          autoApproveMaxSteps,
          readyLanes,
          writeBackPlan,
          instructions,
          uiVerifyCommand,
        });
        if (!updated) throw new Error('That project no longer exists.');
        onSaved(updated);
      } else {
        const created = await transport.invoke('project:add', {
          path,
          // Forced plan-less: this dialog never manages a plan.md-driven queue, and
          // `project:add` otherwise defaults `planPath` to `<path>/plan.md` the moment a
          // path is given — which would pull the project off the single board and onto
          // the scheduler's queue instead.
          planPath: '',
          name: name.trim() || undefined,
          ...projectRoleWrites(roles),
          defaultPermissionMode: permMode,
          concurrency,
          jiraEpicKeys: parseEpicKeys(epics),
          ticketPrefix: isPersonalChoice ? '' : ticketPrefix,
          personal: isPersonalChoice,
          color,
          target,
          baseBranch,
          useWorktrees,
          autoRelease,
          autoCreatePr,
          autoDoneOnLand,
          autoVisualSignOff,
          autoVisualSignOffMaxRounds,
          autoIntegrate,
          autoApprovePlans,
          autoApproveMaxSteps,
          readyLanes,
          writeBackPlan,
          instructions,
          uiVerifyCommand,
        });
        onSaved(created.project);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // A typed path and a chosen machine can disagree; say so on the form rather than
  // letting the first run die on a `cd` into a path that machine cannot see.
  const targetMismatch = !pathSuitsHost(path, target.kind === 'wsl' ? 'linux' : 'windows');

  // Same principle, one layer deeper: the machine can be right and the folder still be unable
  // to host a run — and which git states are worth interrupting someone over depends on
  // whether this repo actually runs isolated, hence the live switch rather than a hardcoded true.
  const gitNote = describeGitPreflight(gitPreflight, useWorktrees);

  const roleRows: RoleRow[] = AGENT_ROLES.map((role) => ({
    role,
    model: roles.models[role],
    sentinelLabel: projectRoleSentinel(role),
    effort: projectRoleEffort(role, roles, defaultEfforts),
  }));

  return (
    <OverlayDrawer
      open={open}
      position="end"
      // Wide enough for the roles table's 730px Role / Model / Effort grid (v11-4).
      size="large"
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          {project ? 'Edit project' : 'Add project'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.form}>
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <Field
            label="Display name"
            hint="Defaults to the folder name, or the ticket prefix if there is no folder."
          >
            <Input
              value={name}
              onChange={(_e, d) => setName(d.value)}
              placeholder="(folder name)"
            />
          </Field>

          {repo && (
            <Field
              label="Repository folder"
              hint={
                distros.length > 0
                  ? 'Optional. Browse into a distro (\\\\wsl.localhost\\…) and both the path and "Runs on" follow — or type a Linux path such as /home/you/repo directly.'
                  : 'Optional — leave it blank for a project that only files and numbers tickets.'
              }
              validationState={gitNote.severity}
              validationMessage={gitNote.message}
            >
              <div className={styles.row}>
                <Input
                  className={`${styles.grow} ${styles.mono}`}
                  value={path}
                  onChange={(_e, d) => updatePath(d.value)}
                  placeholder="Choose a folder, or type /home/you/repo…"
                />
                <Button onClick={() => void browseFolder()}>Browse…</Button>
              </div>
            </Field>
          )}

          {/* Read-only: a host with no repo capability (the web) can see what a repo
              project is configured with even though it cannot set any of it. */}
          {!repo && project && hasRepo(project) && (
            <Field label="Repository folder">
              <Input value={project.path} readOnly className={styles.mono} />
              <Caption1 className={styles.hint}>
                Set on the desktop client that owns this folder, along with its execution target —
                not editable from here.
              </Caption1>
            </Field>
          )}

          {repo && path && distros.length > 0 && (
            <Field
              label="Runs on"
              hint={
                project
                  ? 'Changing this clears this project’s saved sessions and worktrees — they only exist on the machine that created them.'
                  : 'Where this project’s Claude sessions, git and worktrees execute. Browsing into a distro selects it automatically.'
              }
              validationState={targetMismatch ? 'warning' : 'none'}
              validationMessage={
                targetMismatch
                  ? target.kind === 'wsl'
                    ? 'That looks like a Windows path. A WSL target needs a Linux one, e.g. /home/you/repo or /mnt/c/…'
                    : 'That looks like a Linux path. Pick the distro it lives on, or choose a Windows folder.'
                  : undefined
              }
            >
              <Dropdown
                value={execTargetLabel(target)}
                selectedOptions={[formatExecTarget(target)]}
                onOptionSelect={(_e, d) => updateTarget(parseExecTarget(d.optionValue))}
              >
                <Option value="local">{execTargetLabel(LOCAL_TARGET)}</Option>
                {distros.map((distro) => (
                  <Option key={distro} value={`wsl:${distro}`}>
                    {execTargetLabel({ kind: 'wsl', distro })}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}

          {/* The tickets-or-personal choice, for anything the guaranteed prefix actually
              applies to — see `showModeChoice`. A legacy plan-driven project being edited
              keeps its own always-shown, always-optional field instead: that guarantee
              never applied to it, and it is not a project this choice was ever about. */}
          {showModeChoice ? (
            <ProjectBasicsFields
              mode={mode}
              onModeChange={setMode}
              ticketPrefix={ticketPrefix}
              onTicketPrefixChange={(prefix) => {
                setTicketPrefix(prefix);
                setPrefixTouched(true);
              }}
              projects={projects}
              editingId={project?.id}
              hasIssuedTickets={Boolean(project && ownsTickets(project))}
            />
          ) : (
            <Field
              label="Ticket key prefix"
              hint="Tickets filed under this project are numbered TM-1, TM-2, … Leave it blank if this project doesn't own tickets of its own."
              validationState={prefixError ? 'error' : undefined}
              validationMessage={prefixError ?? undefined}
            >
              <Input
                className={styles.mono}
                value={ticketPrefix}
                onChange={(_e, d) => {
                  setTicketPrefix(d.value);
                  setPrefixTouched(true);
                }}
                placeholder="TM"
              />
            </Field>
          )}

          <Field
            label="Colour"
            hint="A card tagged with this project wears a stripe of this colour, so a mixed column says which project each card is about."
          >
            <ColorSwatches value={color} onChange={setColor} allowNone />
          </Field>

          {/* The whole hinge for the git-state note above and every switch below it: with
              this off, a folder's git state is simply not this project's business — see
              `describeGitPreflight`. */}
          {repo && path && (
            <Field hint="Each task runs on its own git branch in a separate worktree, auto-merged back into the base branch when it completes. Only applies to git repositories — other projects run in the shared folder.">
              <Switch
                checked={useWorktrees}
                label="Isolated worktrees (git)"
                onChange={(_e, d) => setUseWorktrees(d.checked)}
              />
            </Field>
          )}

          {/* Only meaningful with isolation on: with it off there is no branch of this
              card's own to name a base for, merge, or release. */}
          {repo && path && useWorktrees && (
            <BaseBranchField value={baseBranch} onChange={setBaseBranch} preflight={gitPreflight} />
          )}

          {/* Whether a finished branch merges itself, decided per repo. Same three-state
              shape as the release switch below, one level up: this repo's answer, or the
              app's when it has none — and choosing the app's answer hands it back. */}
          {repo && path && useWorktrees && (
            <Field
              hint={
                autoIntegrate === null
                  ? `Following the app-wide setting (${appAutoIntegrate ? 'merge automatically' : 'you merge from the card'}), so changing that changes this project too. Set it here to decide for this repo alone.`
                  : autoIntegrate
                    ? "Every card assigned here merges its branch into the base as soon as its work finishes. A card can still say otherwise on the board, right up to the moment it's merged."
                    : 'Every card assigned here leaves its branch alone and offers a Merge button — so you merge work you have looked at. Nothing is discarded either way.'
              }
            >
              <Switch
                checked={autoIntegrate ?? appAutoIntegrate}
                label={
                  autoIntegrate === null
                    ? `Merge finished branches automatically (app default: ${appAutoIntegrate ? 'on' : 'off'})`
                    : 'Merge finished branches automatically'
                }
                onChange={(_e, d) =>
                  setAutoIntegrate(d.checked === appAutoIntegrate ? null : d.checked)
                }
              />
            </Field>
          )}

          {/* The project's PREFERENCE, not its decision: every card can still say
              otherwise in its Details Panel, and one that never does follows this. */}
          {repo && path && useWorktrees && (
            <Field
              hint={`Every card assigned here starts with "Release after merge" already on. When its branch merges, an agent reads ${RELEASE_DOC} in this repo and follows it — so the repo has to have one, and it is the repo's instructions that decide what releasing means.`}
            >
              <Switch
                checked={autoRelease}
                label="Release after merge by default"
                onChange={(_e, d) => setAutoRelease(d.checked)}
              />
            </Field>
          )}

          {/* The alternative to merging, and a preference in exactly the same sense: a card
              may still say otherwise, and one that never does follows this. */}
          {repo && path && useWorktrees && (
            <Field hint='Every card assigned here starts with "Open a PR when finished" already on: its branch is pushed to this repo&apos;s remote and a pull/merge request is opened against the base branch, INSTEAD of the branch being merged locally. Needs a GitHub or GitLab token in Settings.'>
              <Switch
                checked={autoCreatePr}
                label="Open a PR when finished by default"
                onChange={(_e, d) => setAutoCreatePr(d.checked)}
              />
            </Field>
          )}

          {/* Once its PR's required checks pass, the forge merges it — a card whose own
              steps changed the UI still waits for the owner's Approve (`autoMergeDecision`),
              regardless of this switch. */}
          {repo && path && useWorktrees && (
            <Field hint="When this project's PR passes its required checks, the forge merges it. Cards with UI changes wait for Approve.">
              <Switch
                checked={autoMergeOnGreen}
                label="Merge on green"
                onChange={(_e, d) => setAutoMergeOnGreen(d.checked)}
              />
            </Field>
          )}

          {/* The one thing the app moves for the human, and only on a forge's merged report
              — never over a move the human made after the merge (`landedDoneMove`). */}
          {repo && path && useWorktrees && (
            <Field
              data-auto-done-on-land
              hint="When this project's pull/merge request is merged, its card moves to Done — the linked ticket moves with it, as a drag would. A card you moved yourself after it merged stays where you put it."
            >
              <Switch
                checked={autoDoneOnLand}
                label="Move to Done when its PR lands"
                onChange={(_e, d) => setAutoDoneOnLand(d.checked)}
              />
            </Field>
          )}

          {/* `'app'` is for a forge that refuses auto-merge (a private repo on GitHub Free):
              the PR watcher merges it instead, re-reading every fact right before the PUT. A
              refusal flips a single card to the app on its own (`effectiveAutoMergeBy`); this
              setting is the project-wide choice. The hint sits under the row so the two
              dropdowns stay level; "Required checks" takes its own line, since three fields
              overflow the drawer. */}
          {repo && path && useWorktrees && autoMergeOnGreen && (
            <div className={styles.row}>
              <Field label="Who merges on green" className={styles.grow} data-auto-merge-by>
                <Dropdown
                  aria-label="Who merges on green"
                  value={AUTO_MERGE_BY_LABELS[autoMergeBy]}
                  selectedOptions={[autoMergeBy]}
                  onOptionSelect={(_e, d) => setAutoMergeBy(d.optionValue as AutoMergeBy)}
                >
                  {AUTO_MERGE_BY.map((by) => (
                    <Option key={by} value={by}>
                      {AUTO_MERGE_BY_LABELS[by]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Merge method" className={styles.grow}>
                <Dropdown
                  aria-label="Merge method"
                  value={AUTO_MERGE_METHOD_LABELS[autoMergeMethod]}
                  selectedOptions={[autoMergeMethod]}
                  onOptionSelect={(_e, d) => setAutoMergeMethod(d.optionValue as AutoMergeMethod)}
                >
                  {AUTO_MERGE_METHODS.map((m) => (
                    <Option key={m} value={m}>
                      {AUTO_MERGE_METHOD_LABELS[m]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </div>
          )}
          {repo && path && useWorktrees && autoMergeOnGreen && (
            <Caption1 className={styles.hint}>
              Task Manager merges the PR itself once every check is green — for repos where the
              forge has no auto-merge (a private repo on GitHub Free). Only while the app is
              running.
            </Caption1>
          )}
          {repo && path && useWorktrees && autoMergeOnGreen && (
            <Field label="Required checks (comma-separated)">
              <Input
                value={autoMergeRequiredChecks}
                onChange={(_e, d) => setAutoMergeRequiredChecks(d.value)}
                placeholder="changes, gates, docker, package"
              />
            </Field>
          )}

          {/* Who gives a UI card's visual sign-off. Only meaningful with merge on green: the
              sign-off is what arms it. A human's own verdict always wins. */}
          {repo && path && useWorktrees && autoMergeOnGreen && (
            <Field
              data-auto-visual-sign-off
              hint="When a card with UI changes waits for visual sign-off, a fresh read-only review session judges its shots. If they pass, it signs off and the PR merges. If not, it adds a fix step. Your own Approve or Needs changes always wins."
            >
              <Switch
                checked={autoVisualSignOff}
                label="Visual sign-off by AI reviewer"
                onChange={(_e, d) => setAutoVisualSignOff(d.checked)}
              />
            </Field>
          )}

          {repo && path && useWorktrees && autoMergeOnGreen && autoVisualSignOff && (
            <Field
              label="Max automatic fix rounds"
              data-auto-visual-sign-off-max-rounds
              hint="How many fix steps the reviewer may add before it stops and asks you in the Inbox. 0 = review once, never fix."
            >
              <SpinButton
                min={0}
                max={MAX_AI_REVIEW_MAX_ROUNDS}
                value={autoVisualSignOffMaxRounds}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n)) {
                    setAutoVisualSignOffMaxRounds(clampAiReviewMaxRounds(n as number));
                  }
                }}
              />
            </Field>
          )}

          {/* Offered on every project — a plan has nothing to do with a repo or worktrees,
              so a plan-less ticket project can turn this on just as well. */}
          <Field hint="When a plan passes every plan check (no open question, critical files that overlap no active card, few enough steps, the spec read, agent-checkable acceptance) it is approved without waiting in the Inbox.">
            <Switch
              checked={autoApprovePlans}
              label="Approve clean plans automatically"
              onChange={(_e, d) => setAutoApprovePlans(d.checked)}
            />
          </Field>

          <Field
            label="Most steps an auto-approved plan may have"
            data-auto-approve-plans
            hint="A plan that splits into more steps than this is left in the Inbox for a human, even if every other check passes."
          >
            <SpinButton
              min={1}
              max={50}
              value={autoApproveMaxSteps}
              disabled={!autoApprovePlans}
              onChange={(_e, d) => {
                const n = d.value ?? Number(d.displayValue);
                if (Number.isFinite(n)) {
                  setAutoApproveMaxSteps(Math.max(1, Math.min(50, Math.round(n as number))));
                }
              }}
            />
          </Field>

          <Field
            label="Ready lanes"
            data-ready-lanes
            hint="The most cards of this project the board marks ready at once — the ones already running or in an open PR count toward it. The rest wait as queued. 0 = no limit."
          >
            <SpinButton
              min={0}
              max={20}
              value={readyLanes}
              onChange={(_e, d) => {
                const n = d.value ?? Number(d.displayValue);
                if (Number.isFinite(n)) {
                  setReadyLanes(Math.max(0, Math.min(20, Math.round(n as number))));
                }
              }}
            />
          </Field>

          {/* Only meaningful for a plan-driven project (see `hasPlan`) — this drawer always
              adds plan-less (see `save()`), so an add form never has one to tick, and only a
              legacy plan project reaches this screen with one at all. */}
          {project && hasPlan(project) && (
            <Switch
              checked={writeBackPlan}
              label="Tick completed checkboxes back into the plan file"
              onChange={(_e, d) => setWriteBackPlan(d.checked)}
            />
          )}

          {path && (
            <Field
              label="JIRA epics"
              hint="Epic keys this repo owns, comma separated (e.g. ABC-100, ABC-250). A ticket under one of them is assigned here by default."
            >
              <Input
                className={styles.mono}
                value={epics}
                onChange={(_e, d) => setEpics(d.value)}
                placeholder="ABC-100, ABC-250"
              />
            </Field>
          )}

          {/* The Start dialog's roles table (v11-4), as this repo's defaults: a card that
              leaves a role unset runs it on what is picked here. Workers is the execution
              model; Planner, Lead and Reviewer follow their next rung until picked. */}
          {path && (
            <div className={styles.roles} data-project-roles>
              <RolesTable
                rows={roleRows}
                disabled={saving}
                onModelChange={(role, m) => setRoles((r) => setProjectRoleModel(r, role, m))}
                onEffortChange={(role, e) => setRoles((r) => setProjectRoleEffort(r, role, e))}
              />
            </div>
          )}

          {path && (
            <Field label="Default permission mode">
              <Dropdown
                value={PERMISSION_MODE_LABELS[permMode]}
                selectedOptions={[permMode]}
                onOptionSelect={(_e, d) => setPermMode(d.optionValue as PermissionMode)}
              >
                {MODES.map((m) => (
                  <Option key={m} value={m}>
                    {PERMISSION_MODE_LABELS[m]}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}

          {path && (
            <Field
              label="Concurrency"
              hint="How many of this project's tasks run at once. 1 = strictly one at a time. Tasks with @needs: dependencies still wait for their prerequisites."
            >
              <SpinButton
                min={1}
                max={8}
                value={concurrency}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n)) setConcurrency(Math.max(1, Math.round(n as number)));
                }}
              />
            </Field>
          )}

          {repo && path && useWorktrees && (
            <Body1 className={styles.hint}>
              Each assigned card runs on its own git branch in a separate worktree, merged back into
              the base branch above when the agent finishes.
            </Body1>
          )}

          {path && (
            <Field
              label="Standing instructions"
              hint="Added to every run's prompt. For setup knowledge that belongs to your orchestrator — where a build tree lives, an environment to source first, a wrapper a command must run through. Knowledge about the code itself belongs in the repo's CLAUDE.md, which Claude reads on its own."
            >
              <Textarea
                value={instructions}
                resize="vertical"
                onChange={(_e, d) => setInstructions(d.value)}
                placeholder="e.g. The Yocto tree is at /opt/yocto; source oe-init-build-env before any bitbake command."
              />
            </Field>
          )}

          {path && (
            <Field
              label="UI verification command"
              hint="Run by a UI step to screenshot the real UI headlessly. It must write NAME.png, NAME-mockup.png and verdicts.txt into .vipper/attach/. Leave empty if the repo has none: the planner will then propose one."
            >
              <Input
                className={styles.mono}
                data-ui-verify-command
                value={uiVerifyCommand}
                onChange={(_e, d) => setUiVerifyCommand(d.value)}
                placeholder="e.g. node scripts/ui-shots.mjs --attach"
              />
            </Field>
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          appearance="primary"
          onClick={() => void save()}
          disabled={saving || Boolean(prefixError)}
        >
          {project ? 'Save' : 'Add project'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
