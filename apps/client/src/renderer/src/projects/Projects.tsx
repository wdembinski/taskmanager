/**
 * Projects screen (nav rail) — the one place a project is created and edited.
 *
 * A project here is whatever it needs to be: a bare repo an agent can work in, a
 * ticket-owning backlog with no folder at all, or both at once — capabilities are
 * derived from which fields are set (`hasRepo`/`ownsTickets` in `@shared/model`)
 * rather than picked from a `kind`. This screen replaces the old Settings → Agents
 * pane (`AgentProjects.tsx`, gone) now that a project is a first-class nav item
 * rather than something folded into settings.
 *
 * Every project `project:list` returns lands here — including one that predates
 * this screen and still carries a `plan.md` (`hasPlan`), which just means the
 * repo-only fields below apply to it exactly as they do to any other repo.
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
import { normalizeTicketPrefix, suggestTicketPrefix } from '@shared/ticketKey';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
  type ExecTarget,
} from '@shared/execTarget';
import { distroFromWindowsPath, pathSuitsHost, windowsToLinux } from '@shared/wslPath';
import { describeGitPreflight } from '@shared/gitPreflight';
import { useGitPreflight } from '../useGitPreflight';
import { BaseBranchField } from '@ui/BaseBranchField';
import { ColorSwatches } from '@ui/ColorSwatches';
import { modelCaption } from '@ui/modelChoice';
import { PaneLoading } from '@ui/PaneLoading';
import { PlanningModelField } from '@ui/PlanningModelField';
import { useInitialLoad } from '@ui/useInitialLoad';

const useStyles = makeStyles({
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '760px',
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

/** Split a free-text epic list ("ABC-1, ABC-2") into keys; the engine normalizes them. */
function parseEpicKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

export function Projects(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });

  const refresh = useCallback(async () => {
    const all = await window.api.invoke('project:list');
    setProjects(all.map((p) => p.project));
  }, []);

  const initial = useInitialLoad(refresh);

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await window.api.invoke('project:remove', project.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!projects) {
    return (
      <PaneLoading
        label="Loading projects…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  return (
    <div className={styles.pane}>
      <Subtitle2>Projects</Subtitle2>
      <Body1 className={styles.hint}>
        Every project the board knows about. Attach a repository so an agent can work a card&apos;s
        tickets, or leave one bare and use it purely to file and number tickets. Link the JIRA epics
        a repo owns and a ticket under one of them is assigned there automatically.
      </Body1>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Body1 className={styles.hint}>No projects yet.</Body1>
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
                      {project.ticketPrefix && (
                        <Badge appearance="tint" color="brand">
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                    {project.path ? (
                      <>
                        <Caption1 className={styles.path}>{project.path}</Caption1>
                        <Caption1 className={styles.hint}>
                          {modelCaption(project)} ·{' '}
                          {PERMISSION_MODE_LABELS[project.defaultPermissionMode]}
                        </Caption1>
                      </>
                    ) : (
                      <Caption1 className={styles.hint}>
                        No repository — files and numbers tickets only.
                      </Caption1>
                    )}
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

      <ProjectDialog
        open={dialog.open}
        project={dialog.project}
        projects={projects}
        onClose={() => setDialog({ open: false })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

interface ProjectDialogProps {
  open: boolean;
  /** The project being edited; absent means "add". */
  project?: Project;
  /** Every other project, so a chosen ticket prefix can be checked against theirs. */
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}

/** Add / edit drawer. Repo-only fields (branch, merge, release, epics, models, mode) hide
 *  while the folder is empty — there is nothing for them to mean yet. */
function ProjectDialog({
  open,
  project,
  projects,
  onClose,
  onSaved,
}: ProjectDialogProps): JSX.Element {
  const styles = useStyles();
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
    // Needed whichever mode this is; the defaults fetch below only runs for a new project.
    void window.api.invoke('settings:get').then((s) => setAppAutoIntegrate(s.autoIntegrate));
    if (project) {
      setPath(project.path);
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
      setTarget(project.target);
    } else {
      setPath('');
      setName('');
      setTicketPrefix('');
      setPrefixTouched(false);
      setEpics('');
      setColor('');
      setBaseBranch(''); // follow the checkout, exactly as before this field existed
      setAutoRelease(false); // releasing is opt-in, always
      setAutoIntegrate(null); // and merging follows the app until this project says otherwise
      void window.api.invoke('settings:get').then((s) => {
        setModel(s.defaultModel);
        setPlanningModel(s.defaultPlanningModel);
        setPermMode(s.defaultPermissionMode);
        setTarget(s.defaultExecTarget);
      });
    }
  }, [open, project]);

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
        await window.api.invoke('project:update', project.id, {
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
      } else {
        await window.api.invoke('project:add', {
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
  // to host a run. A repo here is ALWAYS worktree-enabled, so every git state that breaks
  // isolation applies — hence the hardcoded true.
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
                onChange={(_e, d) => setPath(d.value)}
                placeholder="Choose a folder, or type /home/you/repo…"
              />
              <Button onClick={() => void browseFolder()}>Browse…</Button>
            </div>
          </Field>

          {path && distros.length > 0 && (
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

          {path && (
            <BaseBranchField value={baseBranch} onChange={setBaseBranch} preflight={preflight} />
          )}

          {/* Whether a finished branch merges itself, decided per repo. Same three-state
              shape as the release switch below, one level up: this repo's answer, or the
              app's when it has none — and choosing the app's answer hands it back. */}
          {path && (
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
          {path && (
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
          {path && (
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
