/**
 * AssignAgentDialog — delegate one My Tasks card to an agent.
 *
 * The card never leaves the Personal board; what this picks is the **agent project**
 * (a repo directory, managed in the desktop app's Settings → Agents) the run happens in,
 * plus the model and permission mode that run uses. The project is pre-filled from the
 * ticket's epic (`resolveAgentProject`), so for a linked epic the whole dialog is usually
 * one click.
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
 * machine the engine runs on), and the web's Settings has no Agents section to send anyone
 * to: an instruction that is true in one host and a dead end in the other reads as a broken
 * screen rather than as the decision it is.
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
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import { MODELS } from '@tm/shared/model';
import type { Project, Task } from '@tm/shared/model';
import { cardModelFromOption, projectDefaultLabel, PROJECT_DEFAULT } from './modelChoice';
import {
  BRANCH_TYPES,
  buildBranchName,
  inferBranchType,
  validateBranchName,
  type BranchType,
} from '@tm/shared/branchName';
import { resolveAgentProject } from '@tm/shared/agentProjects';
import { useTransport } from './transport';

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
  surface: { maxWidth: 'min(720px, calc(100vw - 48px))', width: '100%' },
  body: { maxHeight: 'calc(100vh - 160px)' },
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
  ticket: { color: tokens.colorNeutralForeground2 },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

export interface AssignAgentDialogProps {
  open: boolean;
  /** The card being delegated (null closes the dialog's content). */
  task: Task | null;
  /** Every agent project (from `agentProject:list`), for the picker. */
  agentProjects: Project[];
  onClose: () => void;
  /** The updated task, so the board can patch the card without a refresh. */
  onAssigned: (task: Task) => void;
}

export function AssignAgentDialog({
  open,
  task,
  agentProjects,
  onClose,
  onAssigned,
}: AssignAgentDialogProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [projectId, setProjectId] = useState<string>('');
  // Null = "follow the agent project", and the dialog's default. See the seeding below.
  const [model, setModel] = useState<ClaudeModel | null>(null);
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  const [notes, setNotes] = useState('');
  // The branch, and the Conventional Commits type it is proposed from. `branchTouched`
  // is what stops re-proposing over a name the human has edited.
  const [branchType, setBranchType] = useState<BranchType>('feat');
  const [branch, setBranch] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed once per opening — keyed on the card, not the task object, so a background
  // JIRA sync replacing it can't wipe what the user is halfway through typing.
  const latest = useRef({ task, agentProjects });
  latest.current = { task, agentProjects };
  useEffect(() => {
    if (!open) return;
    const { task: card, agentProjects: projects } = latest.current;
    if (!card) return;
    setError(null);
    setNotes('');
    const resolved = resolveAgentProject(card, projects) ?? projects[0] ?? null;
    setProjectId(resolved?.id ?? '');
    // The card's own model ONLY: reading the project's in as a seed made a fresh assignment
    // save an override nobody asked for, pinning the card to the repo's execution model and
    // quietly excluding it from the repo's planning one. An untouched field now stores null,
    // and the card follows the project the way an unopened dialog would have left it.
    //
    // The one-shot in `store.ts` let go of the overrides this dialog had already written;
    // this line is what stops it writing them again.
    setModel(card.agentModel ?? null);
    setMode(card.agentMode ?? resolved?.defaultPermissionMode ?? 'acceptEdits');
    setBranchTouched(false);
    const type = inferBranchType(card.title, card.externalType);
    setBranchType(type);
    // The card's saved branch wins: re-opening the dialog on an assigned card must show
    // the branch its worktree is actually on, not a fresh proposal that disagrees with it.
    void transport
      .invoke('settings:get')
      .then((settings) => {
        setPrefix(settings.branchPrefix);
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
    const picked = agentProjects.find((p) => p.id === id);
    if (picked) setMode(picked.defaultPermissionMode);
  }

  async function assign(start: boolean): Promise<void> {
    if (!task || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await transport.invoke('task:assignAgent', task.id, {
        agentProjectId: projectId,
        mode,
        // Omitted rather than null: `task:assignAgent` maps a missing model to null, which
        // is the same "follow the project" this dialog means by it.
        model: model ?? undefined,
        notes: notes.trim() || undefined,
        branch: branch.trim() || undefined,
        start,
      });
      onAssigned(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selected = agentProjects.find((p) => p.id === projectId) ?? null;
  // Validated on every keystroke with the SAME rules the engine applies before cutting a
  // worktree, so a name that will be rejected is rejected here — where you can still fix
  // it — rather than several seconds later inside git's stderr.
  const trimmedBranch = branch.trim();
  const branchCheck = trimmedBranch ? validateBranchName(trimmedBranch) : null;
  const branchError =
    trimmedBranch && branchCheck && !branchCheck.ok
      ? `That won't work: ${branchCheck.reason}.`
      : null;
  const ticket = task?.externalKey ? `${task.externalKey} — ${task.title}` : (task?.title ?? '');

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody className={styles.body}>
          <DialogTitle>Assign to an agent</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              <Body1 className={styles.ticket}>{ticket}</Body1>

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {agentProjects.length === 0 ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    No agent projects yet. Add one in the desktop app, under Settings → Agents (a
                    repository folder, plus the JIRA epics it owns), and then assign this card.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <>
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

                  <div className={styles.row}>
                    {/* Left alone, this card runs on whatever the repo above resolves to —
                        including its planning model when the run is a planning one. Picking
                        a name here overrides BOTH, for every run of this card. */}
                    <Field
                      label="Model"
                      className={styles.grow}
                      hint={model ? 'Overrides the project, planning included.' : undefined}
                    >
                      <Dropdown
                        className={styles.dropdown}
                        value={model ?? projectDefaultLabel(selected)}
                        selectedOptions={[model ?? PROJECT_DEFAULT]}
                        onOptionSelect={(_e, d) => setModel(cardModelFromOption(d.optionValue))}
                      >
                        <Option value={PROJECT_DEFAULT} text={projectDefaultLabel(selected)}>
                          {projectDefaultLabel(selected)}
                        </Option>
                        {MODELS.map((m) => (
                          <Option key={m} value={m}>
                            {m}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field label="Permission mode" className={styles.grow}>
                      <Dropdown
                        className={styles.dropdown}
                        value={PERMISSION_MODE_LABELS[mode]}
                        selectedOptions={[mode]}
                        onOptionSelect={(_e, d) => setMode(d.optionValue as PermissionMode)}
                      >
                        {MODES.map((m) => (
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
                    <Textarea
                      value={notes}
                      resize="vertical"
                      onChange={(_e, d) => setNotes(d.value)}
                      placeholder="Anything the ticket doesn't say — where to start, what to avoid…"
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
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {/* Assigning and starting used to be the same act, which left no way to
                discuss a card with its agent before it began changing files. */}
            <Button
              appearance="secondary"
              onClick={() => void assign(false)}
              disabled={busy || !projectId || branchError !== null}
              title="Set the agent up on this card without starting it."
            >
              Assign
            </Button>
            <Button
              appearance="primary"
              onClick={() => void assign(true)}
              disabled={busy || !projectId || branchError !== null}
            >
              {busy ? 'Starting…' : 'Assign & start'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
