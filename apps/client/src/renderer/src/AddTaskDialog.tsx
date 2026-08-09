/**
 * Add-task dialog (Phase 8, Deliverable C1).
 *
 * Create an ad-hoc task directly in a project — no plan file required. This makes
 * plan-less projects usable and lets you add work on the fly; the task is tagged
 * `source: 'adhoc'`, so plan re-syncs never remove it. An optional phase groups it
 * under a milestone (reuse an existing one or type a new one).
 *
 * On a board that passes `parents` (My Tasks, Phase 11), the dialog can also add a
 * **step** under an existing card: pick the card and write the step's brief, and it
 * joins that card's chain — the hand-written equivalent of an approved plan.
 *
 * And on a board that passes `chainCandidates`, it can draw the card's first chain link
 * as it is created: *Runs after…* names the card this one waits for. Most chained cards
 * are known to be chained at the moment somebody thinks of them, and making a new card,
 * finding it on the board and dragging an arrow to it is three steps for one intent.
 *
 * The three things a card is made of are all asked for here, and none of them exclude the
 * others: **which project** it is filed under, **what it is** (its description), and —
 * optionally — **a JIRA ticket** for it. The ticket used to be an either/or that replaced
 * the card, which is why filing and a description had to be added afterwards, in a pane,
 * on a card that already existed. The card is written locally first and the ticket is
 * linked onto it, so JIRA being unreachable costs you the ticket and not the card.
 *
 * Files are the fourth, and the one thing here that cannot be written when it is asked for:
 * an attachment hangs off a task id, and there is no task yet. So they are **staged** — held
 * as paths while the form is filled in, and copied once the row exists. See
 * {@link stageAttachments} for why the `@name` you cite before that is the name you get.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
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
  mergeClasses,
  MessageBar,
  MessageBarBody,
  Option,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { Switch } from '@fluentui/react-components';
import { AttachRegular } from '@fluentui/react-icons';
import type { Project, Task, TaskType } from '@shared/model';
import type { JiraIssueTypeOption, JiraProjectOption } from '@shared/ipc';
import { attachmentName, insertAttachmentRef } from '@shared/attachments';
import { LINK_GATE_LABEL, LINK_REFUSAL_MESSAGE } from '@shared/taskChain';
import { isFileDrag } from './AttachmentStrip';

/** The task types offered in the picker, with their display labels. */
const TASK_TYPES: Array<{ value: TaskType; label: string }> = [
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' },
];

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
  /**
   * The staged files, skinned like `AttachmentStrip` — the same control at a different
   * moment, so it should not look like a different one. Transparent border until a file is
   * over it, so nothing moves when the drop zone appears.
   */
  files: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '6px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorTransparentStroke}`,
  },
  over: {
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' },
  chipName: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'inherit',
    font: 'inherit',
    padding: 0,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipX: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'inherit',
    padding: '0 0 0 4px',
    fontSize: tokens.fontSizeBase300,
    lineHeight: 1,
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** Sentinel for "no parent" in the parent dropdown (an Option needs a value). */
const NO_PARENT = '';
/** The same, for "chained after nothing" — the ordinary case, and the default. */
const NO_LINK = '';
/** The same again, for a card filed under no project at all. */
const NO_PROJECT = '';

/** Everything the form holds, as the plan below reads it. */
export interface AddTaskForm {
  title: string;
  /** The card's brief, or the step's — see {@link AddTaskPlan}. */
  description: string;
  type: TaskType;
  phase: string;
  /** The project the card is filed under; `''` for none. */
  projectTagId: string;
  /** The card this is a step OF; `''` for a card of its own. */
  parentId: string;
  /** Whether a JIRA ticket should be created for this card as well. */
  asJira: boolean;
  jiraProjectKey: string;
  jiraTypeId: string;
}

/**
 * What Add does, worked out from the form alone — the writes, in order, with nothing
 * asked of the engine yet.
 *
 * Pure and separate from the dialog because this is where the rules live: a step takes a
 * brief and nothing else (no filing, no ticket — its plan already decides where it runs),
 * a card takes all of it, and a ticket is an addition to a card rather than a replacement
 * for one.
 */
export type AddTaskPlan =
  /** Nothing can be created yet. `error` is null when the only thing missing is the
   *  title, which the disabled Add button already says. */
  | { kind: 'incomplete'; error: string | null }
  /** One step appended to `parentId`'s chain. */
  | { kind: 'step'; parentId: string; step: { title: string; description: string | null } }
  /** A card, and — when `ticket` is set — a JIRA issue linked onto it afterwards. */
  | {
      kind: 'card';
      card: {
        title: string;
        phase?: string;
        type: TaskType;
        description?: string;
        projectTagId: string | null;
      };
      ticket: {
        projectKey: string;
        issueTypeId: string;
        summary: string;
        description?: string;
      } | null;
    };

/** Work out what Add should do. See {@link AddTaskPlan}. */
export function addTaskPlan(form: AddTaskForm): AddTaskPlan {
  const title = form.title.trim();
  const description = form.description.trim();
  if (!title) return { kind: 'incomplete', error: null };

  if (form.parentId) {
    return {
      kind: 'step',
      parentId: form.parentId,
      step: { title, description: description || null },
    };
  }

  // A ticket the instance cannot place is not a ticket; refuse before the card is
  // written, so Add never half-succeeds on something the form could have caught.
  if (form.asJira && (!form.jiraProjectKey || !form.jiraTypeId)) {
    return { kind: 'incomplete', error: 'Pick a JIRA project and issue type first.' };
  }

  return {
    kind: 'card',
    card: {
      title,
      phase: form.phase.trim() || undefined,
      type: form.type,
      description: description || undefined,
      projectTagId: form.projectTagId || null,
    },
    // The same text on both: the description you typed is what the ticket is about.
    ticket: form.asJira
      ? {
          projectKey: form.jiraProjectKey,
          issueTypeId: form.jiraTypeId,
          summary: title,
          description: description || undefined,
        }
      : null,
  };
}

/** One file the dialog is holding on to until there is a task row to hang it off. */
export interface StagedAttachment {
  /** The absolute path main handed back — from its picker, or `pathForFile` on a drop. */
  path: string;
  /** What it will be called once it is attached, and so what a brief may cite as `@name`. */
  name: string;
}

/**
 * Add `picked` to what is already staged: deduped by absolute path, and named.
 *
 * Deliberately **not** part of {@link AddTaskPlan} — that type describes writes derivable
 * from the form, and copying bytes is a side effect that happens after the row exists.
 *
 * **The invariant that makes staging correct:** the renderer derives provisional names with
 * the same pure `attachmentName` main will use, and for a brand-new task the "already taken"
 * list is empty on both sides — so the `@name` typed into the description and the name main
 * assigns after `task:create` agree by construction. Which is why the names are re-derived
 * over the WHOLE list on every change rather than appended to: `attachmentName` is a
 * function of the list before it, so a file un-staged from the middle must give back the
 * `-2` it was pushing onto the one after it, exactly as main's own run over these paths will.
 * (A ref already typed for a file then un-staged is left where it is: a token naming no
 * attachment is prose — see `parseAttachmentRefs` — so it costs nothing to leave and would
 * cost an edit of the human's own words to remove.)
 *
 * The dedupe is on the exact string, since that is the only comparison that is right on
 * both platforms the app runs on — the same file reached by two different paths is two
 * files here, and lands as `shot.png` and `shot-2.png` rather than as a lost pick.
 */
export function stageAttachments(
  staged: readonly StagedAttachment[],
  picked: readonly string[],
): StagedAttachment[] {
  const paths = staged.map((s) => s.path);
  for (const path of picked) if (!paths.includes(path)) paths.push(path);
  const taken: string[] = [];
  return paths.map((path) => {
    const name = attachmentName(path, taken);
    taken.push(name);
    return { path, name };
  });
}

export interface AddTaskDialogProps {
  open: boolean;
  projectId: string | null;
  /** Existing phase names in the project, offered as a hint. */
  phases: string[];
  /**
   * Cards the new task may be added under as a step. Omit (or pass an empty list) to
   * hide the picker entirely — only the My Tasks board has chains.
   */
  parents?: Task[];
  /** Preselected parent, when the dialog is opened from a card's Steps section. */
  defaultParentId?: string | null;
  /**
   * Cards the new one may be chained AFTER. Omit (or pass an empty list) to hide the
   * picker — only the My Tasks board has a chain to join.
   *
   * The same cards `parents` offers, and a different question: `parents` makes this task a
   * STEP of one card's plan, while this makes it a card of its own that waits for another.
   */
  chainCandidates?: Task[];
  /**
   * The projects the new card may be FILED under (`Task.projectTagId`) — the agent
   * projects, the same list the detail pane's Project dropdown offers. Omit (or pass an
   * empty list) to hide the picker; a board with no repos has nothing to file under.
   *
   * Filing, never delegation: it says what the card is about, and starts nothing.
   */
  projects?: Project[];
  /**
   * Whether this board can also create a real JIRA issue for the task. Set only by My
   * Tasks with JIRA on — the dialog is also used from Projects, where a ticket makes
   * no sense.
   */
  jiraEnabled?: boolean;
  onClose: () => void;
  onCreated: () => void;
  /**
   * Something the board should say once this dialog has gone.
   *
   * The chain link is drawn AFTER the card exists, so a refusal there cannot be reported
   * where an error normally is: the card was created, the dialog is closing, and an error
   * bar inside it would either vanish or invite a second Add. It goes to the board, which
   * is where the new card now is.
   */
  onNotice?: (message: string) => void;
}

export function AddTaskDialog({
  open,
  projectId,
  phases,
  parents = [],
  defaultParentId = null,
  chainCandidates = [],
  projects = [],
  jiraEnabled = false,
  onClose,
  onCreated,
  onNotice,
}: AddTaskDialogProps): JSX.Element {
  const styles = useStyles();
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState('');
  const [type, setType] = useState<TaskType>('feature');
  const [description, setDescription] = useState('');
  /** The project the card is filed under — tagging, not delegation. */
  const [projectTagId, setProjectTagId] = useState<string>(NO_PROJECT);
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  /** The card this one runs after, drawn as a link the moment the card exists. */
  const [runsAfterId, setRunsAfterId] = useState<string>(NO_LINK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Create in JIRA. Off by default: the fast path is still a local card, and a ticket
  // is a thing other people see.
  const [asJira, setAsJira] = useState(false);
  const [jiraProjects, setJiraProjects] = useState<JiraProjectOption[]>([]);
  const [jiraTypes, setJiraTypes] = useState<JiraIssueTypeOption[]>([]);
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [jiraTypeId, setJiraTypeId] = useState('');
  const [loadingMeta, setLoadingMeta] = useState(false);
  /** Files picked before there was anything to attach them to — see {@link stageAttachments}. */
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  /** True while a file is over the strip, for the border that says it will be taken. */
  const [over, setOver] = useState(false);
  /** The description's textarea, so a chip can write `@name` where the caret actually is. */
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPhase('');
      setType('feature');
      setDescription('');
      setProjectTagId(NO_PROJECT);
      setParentId(defaultParentId ?? NO_PARENT);
      setRunsAfterId(NO_LINK);
      setError(null);
      setAsJira(false);
      // Nothing staged survives a close: the paths were for the card being written, and a
      // second card silently carrying the first one's files is the worst kind of surprise.
      setStaged([]);
      setOver(false);
    }
  }, [open, defaultParentId]);

  // The projects list is only worth fetching once the switch is on — it is a network
  // call, and most cards are still local. Seeded from what was created last time.
  useEffect(() => {
    if (!open || !asJira) return;
    let live = true;
    setLoadingMeta(true);
    void Promise.all([window.api.invoke('jira:projects'), window.api.invoke('settings:get')]).then(
      ([projects, settings]) => {
        if (!live) return;
        setJiraProjects(projects);
        const last = settings.jira.lastCreateProjectKey;
        setJiraProjectKey((current) => {
          if (current) return current;
          return last && projects.some((p) => p.key === last) ? last : (projects[0]?.key ?? '');
        });
        setLoadingMeta(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, asJira]);

  // Issue types depend on the project, so they load after one is picked.
  useEffect(() => {
    if (!asJira || !jiraProjectKey) {
      setJiraTypes([]);
      return;
    }
    let live = true;
    void Promise.all([
      window.api.invoke('jira:issueTypes', jiraProjectKey),
      window.api.invoke('settings:get'),
    ]).then(([types, settings]) => {
      if (!live) return;
      setJiraTypes(types);
      const last = settings.jira.lastCreateIssueTypeId;
      setJiraTypeId(last && types.some((t) => t.id === last) ? last : (types[0]?.id ?? ''));
    });
    return () => {
      live = false;
    };
  }, [asJira, jiraProjectKey]);

  const parent = useMemo(() => parents.find((p) => p.id === parentId) ?? null, [parents, parentId]);
  const isStep = parent !== null;
  /** A ticket belongs to a card, so a step is never offered one (nor filed, nor typed). */
  const canJira = jiraEnabled && !isStep;
  const filedProject = useMemo(
    () => projects.find((p) => p.id === projectTagId) ?? null,
    [projects, projectTagId],
  );
  const runsAfter = useMemo(
    () => chainCandidates.find((c) => c.id === runsAfterId) ?? null,
    [chainCandidates, runsAfterId],
  );

  /**
   * Draw the arrow the picker asked for — `created` runs after `fromTaskId`.
   *
   * Deliberately not part of `save`'s try: the card is already on the board by the time
   * this runs, so a link that will not draw is a note to the human rather than a failure of
   * the whole dialog. It takes the default `after-merge` gate, changed on the arrow itself
   * afterwards — a strict default is the one you can loosen once you have seen the chain.
   */
  async function chainAfter(fromTaskId: string, createdId: string): Promise<void> {
    const excuse = (why: string): void =>
      onNotice?.(`The card was created, but it could not be chained — ${why}.`);
    try {
      const result = await window.api.invoke('chain:link', fromTaskId, createdId);
      if (result.status === 'refused') excuse(LINK_REFUSAL_MESSAGE[result.reason]);
    } catch (e) {
      excuse(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Raise the ticket the switch asked for, on the card that now exists.
   *
   * Reported the way a refused chain link is, and for the same reason: by the time this
   * runs the card is on the board, so JIRA being unreachable is a note to the human
   * rather than a failure of the whole dialog. Losing what you typed because a network
   * call failed is the outcome writing the card first exists to prevent.
   */
  async function ticketFor(
    createdId: string,
    ticket: { projectKey: string; issueTypeId: string; summary: string; description?: string },
  ): Promise<void> {
    try {
      await window.api.invoke('jira:createTask', { ...ticket, adoptTaskId: createdId });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      onNotice?.(`The card was created, but its JIRA ticket was not — ${why}`);
    }
  }

  /**
   * Copy the staged files onto the row that now exists.
   *
   * Reported the way a refused chain link and an unraised ticket are, and for the reason
   * they give: by the time this runs the card is on the board, so a file that would not
   * copy is a note to the human rather than a failure of the whole dialog. Losing what you
   * typed because one of five picked files was locked is the outcome writing the row first
   * exists to prevent — and main attaches what it can and reports the rest, so a refusal
   * here does not mean nothing landed.
   */
  async function attachTo(createdId: string, paths: string[]): Promise<void> {
    try {
      await window.api.invoke('attachment:add', createdId, paths);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      onNotice?.(
        `The ${isStep ? 'step' : 'card'} was created, but its files were not attached — ${why}`,
      );
    }
  }

  /**
   * Write `@name` into the description at the caret — the same fold, and the same reason
   * for it, as the detail pane's strip: each call would otherwise read the same
   * `description` from this render, so a pick of five files would cite only the fifth. With
   * no caret to speak of the refs go on the end, which is where they belong when nothing
   * was being pointed at.
   */
  function insertRefs(names: readonly string[]): void {
    let text = description;
    let caret = textareaRef.current?.selectionStart ?? description.length;
    for (const name of names) ({ text, caret } = insertAttachmentRef(text, caret, name));
    setDescription(text);
    // After React has written the new value, or the browser puts the caret back at the end
    // of the old one and the next thing typed lands somewhere else entirely.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  /** Take paths on, and cite whatever was actually new — attaching writes the `@name` for you. */
  function stage(paths: string[]): void {
    const next = stageAttachments(staged, paths);
    const before = new Set(staged.map((s) => s.path));
    setStaged(next);
    const added = next.filter((s) => !before.has(s.path));
    if (added.length) insertRefs(added.map((s) => s.name));
  }

  /**
   * Drop one again. Back through {@link stageAttachments} rather than a plain `filter`, so
   * the names left behind are re-derived: the one that was wearing `-2` because of the file
   * just removed gets its plain name back, which is the name main will give it.
   */
  function unstage(path: string): void {
    setStaged((prev) =>
      stageAttachments(
        [],
        prev.filter((s) => s.path !== path).map((s) => s.path),
      ),
    );
  }

  /** The OS picker. Main owns it — the renderer only holds the paths until Add. */
  async function pickFiles(): Promise<void> {
    setError(null);
    try {
      stage(await window.api.invoke('attachment:pick'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save(): Promise<void> {
    if (!projectId) return;
    const plan = addTaskPlan({
      title,
      description,
      type,
      phase,
      projectTagId,
      // A step is created through its parent whatever else the form says, so this is the
      // one field that decides which shape the plan takes.
      parentId: parent?.id ?? NO_PARENT,
      asJira: canJira && asJira,
      jiraProjectKey,
      jiraTypeId,
    });
    if (plan.kind === 'incomplete') {
      setError(plan.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The card the chain link is drawn to, once there is one. A step never has it: its
      // order comes from the plan it belongs to, and `canLink` refuses steps at either end.
      let created: Task | null = null;
      // The row the files hang off, which a step DOES have — `task:addSubtask` returns the
      // step it made. A separate local rather than reusing `created`, which must stay null
      // for a step so the chain link below is never drawn for one.
      let createdId: string;
      // A step is created through its parent (it inherits the delegation and joins
      // the chain); everything else is an ordinary ad-hoc card.
      if (plan.kind === 'step') {
        createdId = (await window.api.invoke('task:addSubtask', plan.parentId, plan.step)).id;
      } else {
        created = await window.api.invoke('task:create', projectId, plan.card);
        createdId = created.id;
        if (plan.ticket) await ticketFor(created.id, plan.ticket);
      }
      // Only now is there a `taskId` to hang a file off — the whole reason they were staged.
      if (staged.length) {
        await attachTo(
          createdId,
          staged.map((s) => s.path),
        );
      }
      if (created && runsAfter) await chainAfter(runsAfter.id, created.id);
      onCreated();
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
          <DialogTitle>{isStep ? 'Add step' : 'Add task'}</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field label={isStep ? 'Step' : 'Task'} required>
                <Input
                  value={title}
                  onChange={(_e, d) => setTitle(d.value)}
                  placeholder="What should Claude do?"
                />
              </Field>
              {parents.length > 0 && (
                <Field
                  label="Step of (optional)"
                  hint={
                    isStep
                      ? 'Runs in its turn on the card’s branch, in its own session.'
                      : 'Pick a card to make this one of its steps.'
                  }
                >
                  <Dropdown
                    value={parent?.title ?? 'Standalone task'}
                    selectedOptions={[parentId]}
                    onOptionSelect={(_e, d) => setParentId(d.optionValue ?? NO_PARENT)}
                  >
                    <Option value={NO_PARENT}>Standalone task</Option>
                    {parents.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.title}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {/* Chain it as it is created. Never offered for a step — a step's order is
                  the plan's, and a second, contradictory ordering over the top of it could
                  only ever mean the two disagree (see `canLink`). */}
              {chainCandidates.length > 0 && !isStep && (
                <Field
                  label="Runs after… (optional)"
                  hint={
                    runsAfter
                      ? // The gate the link is drawn with, said in the same words the board
                        // and the detail pane use for it — one phrase, three surfaces.
                        `Runs ${LINK_GATE_LABEL['after-merge']}, then starts by itself. Change the gate on the board's arrow.`
                      : 'Chain this card after another one, instead of drawing the arrow afterwards.'
                  }
                >
                  <Dropdown
                    value={runsAfter?.title ?? 'Nothing — it can start whenever'}
                    selectedOptions={[runsAfterId]}
                    onOptionSelect={(_e, d) => setRunsAfterId(d.optionValue ?? NO_LINK)}
                  >
                    <Option value={NO_LINK}>Nothing — it can start whenever</Option>
                    {chainCandidates.map((c) => (
                      <Option key={c.id} value={c.id} text={c.title}>
                        {c.externalKey ? `${c.externalKey} · ${c.title}` : c.title}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {/* Which project the card is ABOUT. Filing, not delegation — it gives the
                  card its colour stripe and pre-answers "which repo" if you later assign
                  an agent, but nothing runs because of it. A step inherits its parent's,
                  so it is never asked. */}
              {projects.length > 0 && !isStep && (
                <Field
                  label="Project (optional)"
                  hint="What this card is about. It files the card — nothing is started."
                >
                  <Dropdown
                    value={filedProject?.name ?? 'None'}
                    selectedOptions={[projectTagId]}
                    onOptionSelect={(_e, d) => setProjectTagId(d.optionValue ?? NO_PROJECT)}
                  >
                    <Option value={NO_PROJECT} text="None">
                      None
                    </Option>
                    {projects.map((p) => (
                      <Option key={p.id} value={p.id} text={p.name}>
                        {p.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {/* One description field, whatever the card turns out to be: a step's brief
                  is what its session is given, a card's is what the agent's prompt quotes,
                  and with the switch on it is also the ticket's body. Asking for it here
                  saves creating the card and then opening it to say what it is. */}
              <Field
                label={isStep ? 'Brief for this step' : 'Description (optional)'}
                hint={
                  isStep
                    ? 'The only context the step’s session gets — say what “done” means.'
                    : canJira && asJira
                      ? 'The agent’s prompt quotes this, and it becomes the ticket’s description.'
                      : 'What this card is, and what done means. The agent’s prompt quotes it.'
                }
              >
                <Textarea
                  value={description}
                  resize="vertical"
                  textarea={{ ref: textareaRef }}
                  onChange={(_e, d) => setDescription(d.value)}
                  placeholder={isStep ? 'What this step must deliver…' : 'What this card is about…'}
                />
              </Field>
              {/* The files the work is ABOUT, picked while the brief is being written rather
                  than afterwards in a pane — the screenshot is on the clipboard at the moment
                  somebody thinks of the card, not ten minutes later. Nothing is copied yet:
                  an attachment hangs off a task id and there is none until Add. No thumbnail
                  for the same reason — a preview is served BY id (`vipper-attachment://`),
                  and `img-src` does not allow a local file, which is the point of it. */}
              <Field
                label="Files (optional)"
                hint={
                  staged.length
                    ? `Copied onto the ${isStep ? 'step' : 'card'} when you press Add. Name one as @file in the text above and the agent running this gets the real file.`
                    : 'Attach a screenshot, a mockup, a log — the agent gets the file, not a description of it.'
                }
              >
                <div
                  className={mergeClasses(styles.files, over && styles.over)}
                  onDragOver={(e) => {
                    // Not ours — and a `dragover` handler may only read the type list, not
                    // the payload. Returning without `preventDefault` is what lets anything
                    // else land where it was aimed; the window itself refuses the rest.
                    if (!isFileDrag(e.dataTransfer.types) || saving) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    if (!over) setOver(true);
                  }}
                  onDragLeave={(e) => {
                    // Only when the pointer really leaves the strip, not every child it enters.
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
                  }}
                  onDrop={(e) => {
                    if (!isFileDrag(e.dataTransfer.types) || saving) return;
                    e.preventDefault();
                    setOver(false);
                    // `File.path` was removed in Electron 32, so the path comes from the
                    // preload bridge. Something with no file on disk answers '' and is dropped.
                    const paths = Array.from(e.dataTransfer.files)
                      .map((file) => window.api.pathForFile(file))
                      .filter((path) => path !== '');
                    if (paths.length) stage(paths);
                    else setError('That has no file on disk to attach.');
                  }}
                >
                  {staged.length > 0 && (
                    <div className={styles.chips}>
                      {staged.map((s) => (
                        <Badge
                          key={s.path}
                          appearance="tint"
                          color="informative"
                          icon={<AttachRegular />}
                          title={`${s.path} · cite it as @${s.name}`}
                        >
                          <button
                            type="button"
                            className={styles.chipName}
                            title={`Write @${s.name} into the text above`}
                            onClick={() => insertRefs([s.name])}
                          >
                            {s.name}
                          </button>
                          <button
                            type="button"
                            className={styles.chipX}
                            aria-label={`Don’t attach ${s.name}`}
                            title="Don’t attach this one"
                            disabled={saving}
                            onClick={() => unstage(s.path)}
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className={styles.row}>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<AttachRegular />}
                      disabled={saving}
                      onClick={() => void pickFiles()}
                    >
                      Attach
                    </Button>
                    <Caption1 className={styles.hint}>
                      {staged.length === 0
                        ? 'Drop files here, or pick them.'
                        : 'Click a file to write its @name where the caret is.'}
                    </Caption1>
                  </div>
                </div>
              </Field>
              {/* A ticket AS WELL as the card, not instead of it: the card is written
                  first and the issue is linked onto it, so everything above still applies
                  and a JIRA that will not answer costs you the ticket alone. Never offered
                  for a step — a step is part of a card's chain, not a thing JIRA knows
                  about. */}
              {canJira && (
                <Field
                  label="Also create a JIRA ticket"
                  hint={
                    asJira
                      ? 'Raises the issue and links it to this card, which then follows the ticket like any synced one.'
                      : 'Off: this stays a local card on your board.'
                  }
                >
                  <Switch checked={asJira} onChange={(_e, d) => setAsJira(d.checked)} />
                </Field>
              )}

              {canJira && asJira && (
                <>
                  <Field
                    label="JIRA project"
                    required
                    hint={
                      loadingMeta
                        ? 'Reading your projects…'
                        : jiraProjects.length
                          ? undefined
                          : 'No projects came back. JIRA only lists the ones you may create in, so this may be a permissions answer rather than a fault.'
                    }
                  >
                    <Dropdown
                      value={jiraProjects.find((p) => p.key === jiraProjectKey)?.name ?? ''}
                      selectedOptions={[jiraProjectKey]}
                      disabled={loadingMeta || !jiraProjects.length}
                      onOptionSelect={(_e, d) => setJiraProjectKey(d.optionValue ?? '')}
                    >
                      {jiraProjects.map((p) => (
                        <Option key={p.key} value={p.key} text={p.name}>
                          {`${p.name} (${p.key})`}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="Issue type" required>
                    <Dropdown
                      value={jiraTypes.find((t) => t.id === jiraTypeId)?.name ?? ''}
                      selectedOptions={[jiraTypeId]}
                      disabled={!jiraTypes.length}
                      onOptionSelect={(_e, d) => setJiraTypeId(d.optionValue ?? '')}
                    >
                      {jiraTypes.map((t) => (
                        <Option key={t.id} value={t.id}>
                          {t.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </>
              )}

              {!isStep && !asJira && (
                <>
                  <Field label="Type">
                    <Dropdown
                      value={TASK_TYPES.find((t) => t.value === type)?.label ?? ''}
                      selectedOptions={[type]}
                      onOptionSelect={(_e, d) => setType(d.optionValue as TaskType)}
                    >
                      {TASK_TYPES.map((t) => (
                        <Option key={t.value} value={t.value}>
                          {t.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field
                    label="Phase / milestone (optional)"
                    hint={
                      phases.length ? `Existing: ${phases.join(' · ')}` : 'e.g. "Phase 1 — Setup"'
                    }
                  >
                    <Input
                      value={phase}
                      onChange={(_e, d) => setPhase(d.value)}
                      placeholder="(ungrouped)"
                    />
                  </Field>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void save()}
              disabled={saving || !title.trim()}
            >
              {isStep ? 'Add step' : 'Add task'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
