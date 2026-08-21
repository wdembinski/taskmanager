/**
 * The project add/edit drawer — shared by the desktop's own `Projects` screen and the Tickets
 * workspace's `ProjectAdmin`, since a repo project and a ticket-only project are the same
 * `project:*` object, just missing a folder.
 *
 * Repo fields — the folder + Browse, "Runs on", `BaseBranchField`, and the three per-project
 * automation switches (auto-merge, auto-release, auto-PR) — render only when the host supplies
 * `repo`, a small capability object. `project:pickDirectory` is `host-only`
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
  Dropdown,
  Field,
  Input,
  Option,
  Switch,
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
import { MODELS, type GitPreflight, type Project } from '@tm/shared/model';
import { PERMISSION_MODE_LABELS, type ClaudeModel, type PermissionMode } from '@tm/shared/session';
import { RELEASE_DOC } from '@tm/shared/release';
import { normalizeTicketPrefix, suggestTicketPrefix } from '@tm/shared/ticketKey';
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
import { PlanningModelField } from '../PlanningModelField';
import { useTransport } from '../transport';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '380px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  grow: { flex: 1 },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
  hint: { color: tokens.colorNeutralForeground3 },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

/** Split a free-text epic list ("ABC-1, ABC-2") into keys; the engine normalizes them. */
function parseEpicKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((key) => key.trim())
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

/** Add / edit drawer. Repo-only fields (branch, merge, release, epics, models, mode) hide
 *  while the folder is empty — there is nothing for them to mean yet. */
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
  const [ticketPrefix, setTicketPrefix] = useState('');
  // Once the human edits the prefix directly, a later name edit must stop overwriting it.
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [epics, setEpics] = useState('');
  const [color, setColor] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [autoRelease, setAutoRelease] = useState(false);
  const [autoCreatePr, setAutoCreatePr] = useState(false);
  /** `null` = follow the app-wide setting, which is what a repo that never ruled does. */
  const [autoIntegrate, setAutoIntegrate] = useState<boolean | null>(null);
  /**
   * The app-wide merge switch as it stands. Read in both modes — setting this repo's
   * switch to what the app already says stores `null`, which is how it goes back to
   * following, and that comparison needs the app's answer even when editing.
   */
  const [appAutoIntegrate, setAppAutoIntegrate] = useState(false);
  const [model, setModel] = useState<ClaudeModel>('sonnet');
  /** `null` = plan on the execution model, which is what a repo that never ruled does. */
  const [planningModel, setPlanningModel] = useState<ClaudeModel | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>('acceptEdits');
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

  const hasRepo = Boolean(repo);

  // Only offer targets that exist here: with no WSL installed the control never
  // appears, and the pane looks exactly as it did before. Meaningless without a folder to
  // run against, so skipped entirely for a host with no repo capability.
  useEffect(() => {
    if (!hasRepo) return;
    void transport.invoke('exec:listDistros').then(setDistros);
  }, [hasRepo, transport]);

  // Seed the form each time it opens — from the project when editing, from the
  // user's global defaults when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    // Needed whichever mode this is; the defaults fetch below only runs for a new project.
    void transport.invoke('settings:get').then((s) => setAppAutoIntegrate(s.autoIntegrate));
    if (project) {
      updatePath(project.path);
      setName(project.name);
      setTicketPrefix(project.ticketPrefix);
      setPrefixTouched(true); // an existing prefix is never overwritten by editing the name
      setEpics(project.jiraEpicKeys.join(', '));
      setColor(project.color);
      setBaseBranch(project.baseBranch);
      setAutoRelease(project.autoRelease);
      setAutoCreatePr(project.autoCreatePr);
      setAutoIntegrate(project.autoIntegrate);
      setModel(project.defaultModel);
      setPlanningModel(project.planningModel);
      setPermMode(project.defaultPermissionMode);
      updateTarget(project.target);
    } else {
      updatePath('');
      setName('');
      setTicketPrefix('');
      setPrefixTouched(false);
      setEpics('');
      setColor('');
      setBaseBranch(''); // follow the checkout, exactly as before this field existed
      setAutoRelease(false); // releasing is opt-in, always
      setAutoIntegrate(null); // and merging follows the app until this project says otherwise
      void transport.invoke('settings:get').then((s) => {
        setModel(s.defaultModel);
        setPlanningModel(s.defaultPlanningModel);
        setPermMode(s.defaultPermissionMode);
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

  const normalizedPrefix = ticketPrefix.trim() ? normalizeTicketPrefix(ticketPrefix) : null;
  const takenBy = normalizedPrefix
    ? projects.find(
        (p) =>
          p.id !== project?.id &&
          p.ticketPrefix &&
          p.ticketPrefix.toUpperCase() === normalizedPrefix,
      )
    : undefined;
  const prefixError =
    ticketPrefix.trim() && !normalizedPrefix
      ? 'Not a usable prefix — needs at least one letter, and cannot be just digits.'
      : takenBy
        ? `Already used by ${takenBy.name}.`
        : null;

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
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          jiraEpicKeys: parseEpicKeys(epics),
          ticketPrefix,
          color,
          target,
          baseBranch,
          autoRelease,
          autoCreatePr,
          autoIntegrate,
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
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          jiraEpicKeys: parseEpicKeys(epics),
          ticketPrefix,
          color,
          target,
          baseBranch,
          autoRelease,
          autoCreatePr,
          autoIntegrate,
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
  // to host a run. A repo here is ALWAYS worktree-enabled, so every git state that breaks
  // isolation applies — hence the hardcoded true.
  const gitNote = describeGitPreflight(gitPreflight, true);

  return (
    <OverlayDrawer
      open={open}
      position="end"
      size="medium"
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

          <Field
            label="Colour"
            hint="A card tagged with this project wears a stripe of this colour, so a mixed column says which project each card is about."
          >
            <ColorSwatches value={color} onChange={setColor} allowNone />
          </Field>

          {repo && path && (
            <BaseBranchField value={baseBranch} onChange={setBaseBranch} preflight={gitPreflight} />
          )}

          {/* Whether a finished branch merges itself, decided per repo. Same three-state
              shape as the release switch below, one level up: this repo's answer, or the
              app's when it has none — and choosing the app's answer hands it back. */}
          {repo && path && (
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
          {repo && path && (
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
          {repo && path && (
            <Field hint='Every card assigned here starts with "Open a PR when finished" already on: its branch is pushed to this repo&apos;s remote and a pull/merge request is opened against the base branch, INSTEAD of the branch being merged locally. Needs a GitHub or GitLab token in Settings.'>
              <Switch
                checked={autoCreatePr}
                label="Open a PR when finished by default"
                onChange={(_e, d) => setAutoCreatePr(d.checked)}
              />
            </Field>
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

          {/* Same pair, and the same reason for no hints inside the row, as the settings
              screen: planning is the run that reads this repo and decides what the work
              is, execution the one that carries out a brief. */}
          {path && (
            <div className={styles.row}>
              <PlanningModelField
                label="Planning model"
                className={styles.grow}
                value={planningModel}
                executionModel={model}
                onChange={setPlanningModel}
              />
              <Field label="Steps execution model" className={styles.grow}>
                <Dropdown
                  value={model}
                  selectedOptions={[model]}
                  onOptionSelect={(_e, d) => setModel(d.optionValue as ClaudeModel)}
                >
                  {MODELS.map((m) => (
                    <Option key={m} value={m}>
                      {m}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
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
            <Body1 className={styles.hint}>
              Each assigned card runs on its own git branch in a separate worktree, merged back into
              the base branch above when the agent finishes.
            </Body1>
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
