/**
 * Agent projects pane (Settings → Agents).
 *
 * An *agent project* is the lightweight successor to the plan.md-driven Projects
 * tab: just a repo directory plus the JIRA epics it owns. When you delegate a My
 * Tasks card to an agent, the card's ticket is matched against these epics to pick
 * the repo the agent works in — and the model/permission mode below seed that
 * assignment's defaults.
 *
 * There is no plan file and no queue: an agent project never runs anything on its
 * own, it only ever answers "which directory does this card's agent work in?".
 * Managing them lives in Settings for now, until the replacement projects
 * framework exists.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  OverlayDrawer,
  Subtitle2,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
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
import { distroFromWindowsPath, pathSuitsHost, windowsToLinux } from '@shared/wslPath';
import { describeGitPreflight } from '@shared/gitPreflight';
import { useGitPreflight } from './useGitPreflight';
import { BaseBranchField } from './BaseBranchField';
import { ColorSwatches } from './ColorSwatches';
import { PaneLoading } from './PaneLoading';
import { PlanningModelField } from './PlanningModelField';
import { useInitialLoad } from './useInitialLoad';

const useStyles = makeStyles({
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '520px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  /** The project's board colour, so the list reads the way the board does. */
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  path: { color: tokens.colorNeutralForeground3, fontFamily: 'ui-monospace, Consolas, monospace' },
  epics: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  grow: { flex: 1 },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

/**
 * How a project's models read in the list. One name while planning follows execution —
 * which is every project until someone splits them — and both, labelled, once they differ,
 * since at that point "sonnet" alone would be a half-truth about what this repo costs.
 */
export function modelCaption(project: Pick<Project, 'defaultModel' | 'planningModel'>): string {
  const planning = project.planningModel;
  return !planning || planning === project.defaultModel
    ? project.defaultModel
    : `${planning} planning · ${project.defaultModel} steps`;
}

/** Split a free-text epic list ("ABC-1, ABC-2") into keys; the engine normalizes them. */
function parseEpicKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

export function AgentProjects(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });

  const refresh = useCallback(async () => {
    setProjects(await window.api.invoke('agentProject:list'));
  }, []);

  const initial = useInitialLoad(refresh);

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await window.api.invoke('agentProject:remove', project.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!projects) {
    return (
      <PaneLoading
        label="Loading agent projects…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  return (
    <div className={styles.pane}>
      <Subtitle2>Agent projects</Subtitle2>
      <Body1 className={styles.hint}>
        Repositories an agent can work in when you assign a My Tasks card to it. Link the JIRA epics
        a repo owns and a ticket under one of them picks its project automatically. A repo can live
        inside WSL — browse into the distro and the project runs there.
      </Body1>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add agent project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Body1 className={styles.hint}>No agent projects yet.</Body1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => (
            <Card key={project.id} className={styles.card}>
              <CardHeader
                header={
                  <div className={styles.headerText}>
                    <div className={styles.nameRow}>
                      {project.color && (
                        <span
                          className={styles.colorDot}
                          style={{ backgroundColor: project.color }}
                          title={`Board colour ${project.color}`}
                        />
                      )}
                      <Text weight="semibold">{project.name}</Text>
                    </div>
                    <Caption1 className={styles.path}>{project.path}</Caption1>
                    <Caption1 className={styles.hint}>
                      {modelCaption(project)} ·{' '}
                      {PERMISSION_MODE_LABELS[project.defaultPermissionMode]}
                    </Caption1>
                  </div>
                }
                action={
                  <div className={styles.cardActions}>
                    <Button size="small" onClick={() => setDialog({ open: true, project })}>
                      Edit
                    </Button>
                    <Button size="small" onClick={() => void remove(project)}>
                      Remove
                    </Button>
                  </div>
                }
              />
              {project.jiraEpicKeys.length > 0 && (
                <div className={styles.epics}>
                  {project.jiraEpicKeys.map((key) => (
                    <Badge key={key} appearance="tint" color="informative">
                      {key}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <AgentProjectDialog
        open={dialog.open}
        project={dialog.project}
        onClose={() => setDialog({ open: false })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

interface AgentProjectDialogProps {
  open: boolean;
  /** The project being edited; absent means "add". */
  project?: Project;
  onClose: () => void;
  onSaved: () => void;
}

/** Add / edit form. The folder is editable in both modes — an agent project is little else. */
function AgentProjectDialog({
  open,
  project,
  onClose,
  onSaved,
}: AgentProjectDialogProps): JSX.Element {
  const styles = useStyles();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [epics, setEpics] = useState('');
  const [color, setColor] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [autoRelease, setAutoRelease] = useState(false);
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

  // Only offer targets that exist here: with no WSL installed the control never
  // appears, and the pane looks exactly as it did before.
  useEffect(() => {
    void window.api.invoke('exec:listDistros').then(setDistros);
  }, []);

  // Seed the form each time it opens — from the project when editing, from the
  // user's global defaults when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    // Needed whichever mode this is; the defaults fetch below only runs for a new repo.
    void window.api.invoke('settings:get').then((s) => setAppAutoIntegrate(s.autoIntegrate));
    if (project) {
      setPath(project.path);
      setName(project.name);
      setEpics(project.jiraEpicKeys.join(', '));
      setColor(project.color);
      setBaseBranch(project.baseBranch);
      setAutoRelease(project.autoRelease);
      setAutoIntegrate(project.autoIntegrate);
      setModel(project.defaultModel);
      setPlanningModel(project.planningModel);
      setPermMode(project.defaultPermissionMode);
      setTarget(project.target);
    } else {
      setPath('');
      setName('');
      setEpics('');
      setColor('');
      setBaseBranch(''); // follow the checkout, exactly as before this field existed
      setAutoRelease(false); // releasing is opt-in, always
      setAutoIntegrate(null); // and merging follows the app until this repo says otherwise
      void window.api.invoke('settings:get').then((s) => {
        setModel(s.defaultModel);
        setPlanningModel(s.defaultPlanningModel);
        setPermMode(s.defaultPermissionMode);
        setTarget(s.defaultExecTarget);
      });
    }
  }, [open, project]);

  /**
   * Browse for the repo folder.
   *
   * The Windows picker can walk into a distro, where it hands back a
   * `\\wsl.localhost\<distro>\…` path. That one path says both WHERE the repo is and
   * WHICH machine it belongs to, so picking it selects the target too, and the path is
   * stored in the Linux form the agent, git and the worktrees will actually use —
   * handing a UNC path to a Linux shell would fail at the first `cd`.
   *
   * Same rule as the plan-project dialog: an agent project is a working directory like
   * any other, and the two must not disagree about what picking a WSL folder means.
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

  async function save(): Promise<void> {
    if (!path) {
      setError('Choose a repository folder first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (project) {
        await window.api.invoke('agentProject:update', project.id, {
          path,
          name: name.trim() || undefined,
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          jiraEpicKeys: parseEpicKeys(epics),
          color,
          target,
          baseBranch,
          autoRelease,
          autoIntegrate,
        });
      } else {
        await window.api.invoke('agentProject:add', {
          path,
          name: name.trim() || undefined,
          defaultModel: model,
          planningModel,
          defaultPermissionMode: permMode,
          jiraEpicKeys: parseEpicKeys(epics),
          color,
          target,
          baseBranch,
          autoRelease,
          autoIntegrate,
        });
      }
      onSaved();
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
  // to host a run. An agent project is ALWAYS worktree-enabled (`store.addProject`, there is no
  // switch here), so every git state that breaks isolation applies — hence the hardcoded true.
  const preflight = useGitPreflight(path, target, open && !targetMismatch);
  const gitNote = describeGitPreflight(preflight, true);

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
          {project ? 'Edit agent project' : 'Add agent project'}
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
            label="Repository folder"
            required
            hint={
              distros.length > 0
                ? 'Browse into a distro (\\\\wsl.localhost\\…) and both the path and "Runs on" follow — or type a Linux path such as /home/you/repo directly.'
                : undefined
            }
            validationState={gitNote.severity}
            validationMessage={gitNote.message}
          >
            <div className={styles.row}>
              {/* Typeable, unlike the plan dialog's: a distro folder the Windows
                      picker cannot reach (a path outside \\wsl.localhost, or a headless
                      distro) would otherwise be unreachable, and an agent project is
                      nothing but this folder. */}
              <Input
                className={`${styles.grow} ${styles.mono}`}
                value={path}
                onChange={(_e, d) => setPath(d.value)}
                placeholder="Choose a folder, or type /home/you/repo…"
              />
              <Button onClick={() => void browseFolder()}>Browse…</Button>
            </div>
          </Field>

          {distros.length > 0 && (
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

          <Field
            label="Colour"
            hint="A card tagged with this project wears a stripe of this colour, so a mixed column says which repo each card is about."
          >
            <ColorSwatches value={color} onChange={setColor} allowNone />
          </Field>

          <BaseBranchField value={baseBranch} onChange={setBaseBranch} preflight={preflight} />

          {/* Whether a finished branch merges itself, decided per repo. Same three-state
              shape as the release switch below, one level up: this repo's answer, or the
              app's when it has none — and choosing the app's answer hands it back. */}
          <Field
            hint={
              autoIntegrate === null
                ? `Following the app-wide setting (${appAutoIntegrate ? 'merge automatically' : 'you merge from the card'}), so changing that changes this repo too. Set it here to decide for this repo alone.`
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

          {/* The project's PREFERENCE, not its decision: every card can still say
              otherwise in its Details Panel, and one that never does follows this. */}
          <Field
            hint={`Every card assigned here starts with "Release after merge" already on. When its branch merges, an agent reads ${RELEASE_DOC} in this repo and follows it — so the repo has to have one, and it is the repo's instructions that decide what releasing means.`}
          >
            <Switch
              checked={autoRelease}
              label="Release after merge by default"
              onChange={(_e, d) => setAutoRelease(d.checked)}
            />
          </Field>

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

          {/* Same pair, and the same reason for no hints inside the row, as the
              plan-project dialog: planning is the run that reads this repo and decides
              what the work is, execution the one that carries out a brief. */}
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

          <Body1 className={styles.hint}>
            Each assigned card runs on its own git branch in a separate worktree, merged back into
            the base branch above when the agent finishes.
          </Body1>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button appearance="primary" onClick={() => void save()} disabled={saving}>
          {project ? 'Save' : 'Add agent project'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
