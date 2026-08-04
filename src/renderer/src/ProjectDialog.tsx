/**
 * Add / Edit project dialog (Phase 8, Deliverable A).
 *
 * One form, two modes. **Add** collects a folder (Browse), an optional custom
 * **plan file** (Browse — so you can point at an existing `ROADMAP.md` instead of
 * `plan.md`), a display name, model, permission mode, and write-back, then calls
 * `project:add`. **Edit** pre-fills from an existing project (the folder is fixed)
 * and calls `project:update`, re-syncing the plan afterward in case the plan file
 * changed. Model/mode changes take effect on the project's next run.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  SpinButton,
  Switch,
  Textarea,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import { MODELS, type Project } from '@shared/model';
import { RELEASE_DOC } from '@shared/release';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
  type ExecTarget,
} from '@shared/execTarget';
import { distroFromWindowsPath, windowsToLinux } from '@shared/wslPath';
import { describeGitPreflight } from '@shared/gitPreflight';
import { useGitPreflight } from './useGitPreflight';
import { BaseBranchField } from './BaseBranchField';
import { PlanningModelField } from './PlanningModelField';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  grow: { flex: 1 },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

export interface ProjectDialogProps {
  open: boolean;
  mode: 'add' | 'edit';
  /** The project being edited (required in edit mode). */
  project?: Project;
  onClose: () => void;
  /** Called after a successful add/update so the caller can refresh its list. */
  onSaved: () => void;
}

export function ProjectDialog({
  open,
  mode,
  project,
  onClose,
  onSaved,
}: ProjectDialogProps): JSX.Element {
  const styles = useStyles();
  const [path, setPath] = useState('');
  const [planPath, setPlanPath] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState<ClaudeModel>('sonnet');
  /** `null` = plan on the execution model, which is what a project that never ruled does. */
  const [planningModel, setPlanningModel] = useState<ClaudeModel | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>('acceptEdits');
  const [concurrency, setConcurrency] = useState(1);
  const [useWorktrees, setUseWorktrees] = useState(true);
  const [baseBranch, setBaseBranch] = useState('');
  const [writeBack, setWriteBack] = useState(false);
  const [autoRelease, setAutoRelease] = useState(false);
  /** `null` = follow the app-wide setting, which is what a project that never ruled does. */
  const [autoIntegrate, setAutoIntegrate] = useState<boolean | null>(null);
  /**
   * What the app-wide merge switch says right now.
   *
   * Needed for more than the label: setting this project's switch to whatever the app
   * already says stores `null` rather than the same value again, which is how a project
   * goes back to following it. Read in BOTH modes — an edited project needs it just as
   * much as a new one, and the add-mode `settings:get` below only runs for new ones.
   */
  const [appAutoIntegrate, setAppAutoIntegrate] = useState(false);
  const [target, setTarget] = useState<ExecTarget>(LOCAL_TARGET);
  const [distros, setDistros] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker only offers distros that actually exist on this machine; when WSL
  // isn't installed the control collapses to "This computer" and never appears.
  useEffect(() => {
    if (!open) return;
    void window.api.invoke('exec:listDistros').then(setDistros);
  }, [open]);

  // The app-wide merge default, in both modes — see `appAutoIntegrate`.
  useEffect(() => {
    if (!open) return;
    void window.api.invoke('settings:get').then((s) => setAppAutoIntegrate(s.autoIntegrate));
  }, [open]);

  // Seed the form whenever the dialog opens (from the project in edit mode, or
  // from the global defaults in add mode).
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && project) {
      setPath(project.path);
      setPlanPath(project.planPath);
      setName(project.name);
      setModel(project.defaultModel);
      setPlanningModel(project.planningModel);
      setPermMode(project.defaultPermissionMode);
      setConcurrency(project.concurrency);
      setUseWorktrees(project.useWorktrees);
      setBaseBranch(project.baseBranch);
      setWriteBack(project.writeBackPlan);
      setAutoRelease(project.autoRelease);
      setAutoIntegrate(project.autoIntegrate);
      setTarget(project.target);
      setInstructions(project.instructions);
    } else {
      setPath('');
      setPlanPath('');
      setName('');
      setInstructions('');
      setUseWorktrees(true); // default on; only engages for git repos
      setBaseBranch(''); // follow the checkout, exactly as before this field existed
      setAutoRelease(false); // releasing is opt-in, always
      setAutoIntegrate(null); // and merging follows the app until this project says otherwise
      void window.api.invoke('settings:get').then((s) => {
        setModel(s.defaultModel);
        setPlanningModel(s.defaultPlanningModel);
        setPermMode(s.defaultPermissionMode);
        setConcurrency(s.concurrency);
        setWriteBack(s.writeBackPlan);
        setTarget(s.defaultExecTarget);
      });
    }
  }, [open, mode, project]);

  /**
   * Browse for the project folder.
   *
   * The Windows picker can walk into a distro, where it returns a
   * `\\wsl.localhost\<distro>\…` path. That single path says both WHERE the project
   * is and WHICH machine it belongs to, so picking it selects the target too, and the
   * path is stored in the Linux form the agent and git will actually use.
   */
  async function browseFolder(): Promise<void> {
    const picked = await window.api.invoke('project:pickDirectory');
    if (!picked) return;
    const distro = distroFromWindowsPath(picked);
    if (distro) {
      setTarget({ kind: 'wsl', distro });
      setPath(windowsToLinux(picked));
    } else {
      setTarget(LOCAL_TARGET);
      setPath(picked);
    }
  }

  async function browsePlan(): Promise<void> {
    const picked = await window.api.invoke('project:pickFile');
    if (picked) setPlanPath(picked);
  }

  const preflight = useGitPreflight(path, target, open);
  const gitNote = describeGitPreflight(preflight, useWorktrees);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'add') {
        if (!path) {
          setError('Choose a project folder first.');
          return;
        }
        await window.api.invoke('project:add', {
          path,
          name: name.trim() || undefined,
          planPath: planPath.trim() || undefined,
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          concurrency,
          useWorktrees,
          baseBranch,
          writeBackPlan: writeBack,
          autoRelease,
          autoIntegrate,
          target,
          instructions,
        });
      } else if (project) {
        await window.api.invoke('project:update', project.id, {
          name: name.trim() || undefined,
          planPath: planPath.trim() || undefined,
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          concurrency,
          useWorktrees,
          baseBranch,
          writeBackPlan: writeBack,
          autoRelease,
          autoIntegrate,
          target,
          instructions,
        });
        // The plan file may have changed — reconcile tasks from the new source.
        await window.api.invoke('project:syncPlan', project.id);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{mode === 'add' ? 'Add project' : 'Edit project'}</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {/* Git state belongs on the form, not in the first parked run: a folder that
                  isn't a repo makes the worktree switch below a no-op, and one with no commits
                  has nothing for a task branch to start from. */}
              <Field
                label="Project folder"
                required
                validationState={gitNote.severity}
                validationMessage={gitNote.message}
              >
                <div className={styles.row}>
                  <Input
                    className={`${styles.grow} ${styles.mono}`}
                    value={path}
                    readOnly
                    placeholder="Choose a folder…"
                  />
                  {mode === 'add' && <Button onClick={() => void browseFolder()}>Browse…</Button>}
                </div>
              </Field>

              <Field
                label="Plan file"
                hint="Defaults to plan.md in the folder. Point at any markdown file."
              >
                <div className={styles.row}>
                  <Input
                    className={`${styles.grow} ${styles.mono}`}
                    value={planPath}
                    onChange={(_e, d) => setPlanPath(d.value)}
                    placeholder="…/plan.md"
                  />
                  <Button onClick={() => void browsePlan()}>Browse…</Button>
                </div>
              </Field>

              {distros.length > 0 && (
                <Field
                  label="Runs on"
                  hint={
                    mode === 'edit'
                      ? 'Changing this clears each task’s saved session and worktrees — they only exist on the machine that created them.'
                      : 'Where this project’s Claude sessions, git and worktrees execute. Browsing into a distro selects it automatically.'
                  }
                >
                  <Dropdown
                    value={execTargetLabel(target)}
                    selectedOptions={[formatExecTarget(target)]}
                    onOptionSelect={(_e, d) => setTarget(parseExecTarget(d.optionValue))}
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

              <Field label="Display name" hint="Defaults to the folder name.">
                <Input
                  value={name}
                  onChange={(_e, d) => setName(d.value)}
                  placeholder="(folder name)"
                />
              </Field>

              {/* The two models side by side, because the left one is only meaningful
                  against the right: planning reads the repo and decides what the work IS,
                  where a step is handed a brief that already says what to do. Neither
                  hints — the "Same as steps execution (…)" option says it, and a hint in
                  one half of a `row` would leave the two dropdowns on different lines. */}
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

              <Field label="Permission mode">
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

              <Field hint="Each task runs on its own git branch in a separate worktree, auto-merged back into the base branch when it completes. Only applies to git repositories — other projects run in the shared folder.">
                <Switch
                  checked={useWorktrees}
                  label="Isolated worktrees (git)"
                  onChange={(_e, d) => setUseWorktrees(d.checked)}
                />
              </Field>

              {/* Only meaningful with isolation on: a shared-folder project has no branch
                  to merge back, so the field would be a setting that does nothing. */}
              {useWorktrees && (
                <BaseBranchField
                  value={baseBranch}
                  onChange={setBaseBranch}
                  preflight={preflight}
                />
              )}

              {/* Merging is per-repo before it is per-app: the repo you own outright wants
                  its branches merged the moment they are green, and the one your team ships
                  from does not. Off the app's default only when this project says so —
                  choosing what the app already says hands it back to following it. */}
              {useWorktrees && (
                <Field
                  hint={
                    autoIntegrate === null
                      ? `Following the app-wide setting (${appAutoIntegrate ? 'merge automatically' : 'you merge from the card'}), so changing that changes this project too. Set it here to decide for this repo alone.`
                      : autoIntegrate
                        ? "Every task here merges its own branch into the base as soon as it finishes. Any card can still say otherwise on the board, right up to the moment it's merged."
                        : 'Every task here leaves its branch alone and offers a Merge button on the card — so you merge work you have looked at. Nothing is discarded either way.'
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

              {/* Same reason as the base-branch field above: with no isolation there is no
                  branch to merge, so there is no merge for a release to follow. */}
              {useWorktrees && (
                <Field
                  hint={`Every task here starts with "Release after merge" already on. When its branch merges, an agent reads ${RELEASE_DOC} in the repo and follows it — the repo's own instructions decide what releasing means, and a repo without one is simply left alone.`}
                >
                  <Switch
                    checked={autoRelease}
                    label="Release after merge by default"
                    onChange={(_e, d) => setAutoRelease(d.checked)}
                  />
                </Field>
              )}

              <Switch
                checked={writeBack}
                label="Tick completed checkboxes back into the plan file"
                onChange={(_e, d) => setWriteBack(d.checked)}
              />

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
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void save()} disabled={saving}>
              {mode === 'add' ? 'Add project' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
