/**
 * TaskAgentPanel — the "Agent" section of the My Tasks detail pane.
 *
 * Everything a human does with a delegated card lives here: assign it to an agent
 * project (or reassign it, which restarts the run with fresh settings), START it when it
 * was assigned without being started, stop it, RESUME it afterwards — same conversation,
 * same worktree — and, while a run is parked, **answer it inline**, without a detour to
 * the Attention inbox.
 *
 * The parked asks arrive as a prop from the board's single `useAttentionIndex`, oldest
 * first. One is shown at a time and answering it reveals the next, because the index
 * drops only the item that resolved. This panel used to mount its own subscription, which
 * showed only the first item and blanked the slot on `attention:resolved` — so a card
 * with two asks lost the second, and the pane around it held a second, disagreeing copy.
 *
 * Model and permission mode are shown read-only: both are captured when the run
 * starts, so changing them means reassigning (the button says so).
 *
 * Three icon toggles sit in the header row, beside the actions they pre-answer — Merge,
 * Create PR, and (via the chain) a release — each a standing answer to "what happens
 * without anyone pressing a button", rather than a stack of switches with their own hint
 * text. Their explanations live in the tooltip and `aria-label` instead (see
 * `agentAutoToggles`), since an icon-only control has no `Field` hint paragraph beside it.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Field,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  Textarea,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  BranchRequestRegular,
  MergeRegular,
  PlayCircleRegular,
  RecordStopRegular,
  RocketRegular,
} from '@fluentui/react-icons';
import { AgentGlyph } from './AgentGlyph';
import { autoCreatePrTooltip, autoMergeTooltip, autoReleaseTooltip } from './agentAutoToggles';
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';
import { canResumeWork, canStopWork, hasAgentWorked, parkedStep } from '@tm/shared/board';
import type { Project, Task } from '@tm/shared/model';
import { autoIntegrateOn, projectAutoIntegrate } from '@tm/shared/integrate';
import { autoReleaseOn } from '@tm/shared/release';
import { autoCreatePrOn } from '@tm/shared/pullRequest';
import { mrAbbrev, mrIsSettled, mrNoun, mrRef, type MergeRequest } from '@tm/shared/mergeRequest';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import { AssignAgentDialog } from './AssignAgentDialog';
import { stepPosition } from './board/boardColumns';
import { draftKey, useDraft } from './drafts';
import { cardModelCaption } from './modelChoice';
import { STATUS_LABEL } from './taskStatus';
import { AgentQuestionForm } from './AgentQuestionForm';
import { Markdown } from './chat/MarkdownView';
import { useTransport } from './transport';
import { UNREAD_ORANGE as ASK_ORANGE } from '@tm/shared/accent';

const useStyles = makeStyles({
  /**
   * A **section** of the pane's details cell, not a card of its own — the cell owns the
   * shade and the border. The parked-ask block below keeps its orange frame: that one is
   * an alert, and it is meant to interrupt.
   */
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  // `flexWrap`/`rowGap`: the row can hold up to eight controls (four actions, three
  // auto-toggles, Assign/Reassign) and the pane is narrow, so it wraps onto a second line
  // rather than overflowing.
  head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', rowGap: '4px' },
  // White, matching the board card's delegation glyph.
  icon: { fontSize: '18px', display: 'flex', color: '#ffffff' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  ask: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `2px solid ${ASK_ORANGE}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /**
   * "This card is waiting for another one, and here is how to go anyway."
   *
   * Deliberately NOT the orange `ask` frame above it. That frame means *something is
   * blocked on you* and is meant to interrupt; a chain link is a standing fact about the
   * card that will read the same tomorrow. The board draws the same distinction with its
   * monochrome chip — colour is for things that move.
   */
  blocked: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // No `fontFamily`/`pre-wrap` any more: the body is rendered markdown, which brings its
  // own monospace exactly where it belongs — inside code — rather than everywhere.
  prompt: { maxHeight: '220px', overflowY: 'auto' },
  /**
   * The plan itself: longer than a prompt, so it gets its own scroll box — and taller
   * than it was, because this is the one thing in the app you have to READ before you can
   * answer, and 260px of a twenty-step plan is a keyhole.
   */
  plan: {
    maxHeight: '420px',
    overflowY: 'auto',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: '2px' },
  step: { display: 'flex', gap: '6px' },
  stepIndex: { color: tokens.colorNeutralForeground4, minWidth: '18px' },
  choices: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  /** Whose ask this is, when it belongs to a step rather than to the card. */
  stepOwner: { color: ASK_ORANGE },
  answerRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
  /** The release toggle, when it is on but the repo has no RELEASE.md yet — the warning
   * `Field.validationState` used to carry before the switch became an icon button. */
  warn: { color: tokens.colorPaletteYellowForeground1 },
});

export interface TaskAgentPanelProps {
  task: Task;
  /** This card's steps, in order — the chain whose parked step the panel must surface. */
  subtasks?: Task[];
  /** Every agent project (from `project:list`), owned by the board so it's fetched once. */
  agentProjects: Project[];
  /**
   * Everything the inbox is holding for this card and its steps, newest last, from the
   * board's single `useAttentionIndex`.
   *
   * A prop rather than a hook of its own: this panel and the detail pane around it were
   * each mounting `usePendingAttention`, which surfaced only the FIRST item and, on
   * `attention:resolved`, set null without re-querying — so answering one of two pending
   * asks silently swallowed the other, and a question raised while you were reading the
   * card could fail to appear at all.
   */
  items?: readonly AttentionItem[];
  /** Open another task in the pane (used to jump to the step that stopped the chain). */
  onOpenTask?: (taskId: string) => void;
  /** Called with the updated task after an assign/stop so the board can patch the card. */
  onTaskChanged: (task: Task) => void;
  /**
   * Whether the agent is working right now, which pulses the header glyph.
   *
   * A prop rather than a `runPhase` call of its own: the pane holds the `liveRunTaskIds`
   * snapshot and this panel does not, so computing it here would miss the window before a
   * spawned run is persisted as `running` — and the pane's own comment is that the card, the
   * pane and the composer strip must never disagree about this.
   */
  running?: boolean;
  /**
   * The task ids the engine has a live run for (`scheduler:activeRuns`), so **Stop** is
   * offered for a run that has spawned but is not yet persisted as `running` — the same
   * window the spinner needs it for (see `canStopWork`).
   */
  liveRunTaskIds?: ReadonlySet<string>;
  /**
   * Whether this card's branch is being merged right now (`scheduler:integrating`).
   *
   * The engine's fact, not a local flag set on click, because the merge outlives the IPC
   * call that starts it by a long way: `task:integrate` resolves as soon as the rebase has
   * been *handed off*, and the git work then runs for as long as it runs with nothing else
   * to show for it. A purely local spinner would stop at the wrong moment — the one thing
   * worse than no feedback is feedback that lies.
   */
  merging?: boolean;
  /**
   * The chained cards this one is still waiting on (`@tm/shared/taskChain`). Present and
   * non-empty is exactly the condition for offering **Release now**: the chain would not
   * start this card yet, and the human may know better.
   */
  waitingOn?: readonly Task[];
  /**
   * The subset of {@link waitingOn} waiting on nothing but a merge (`awaitingMerge`) — each
   * of those gets a **Merge** button beside its **Open**.
   *
   * The one thing standing between this card and starting by itself is then a click away
   * from where the human already is. Sending them to the other card to find the same button
   * is how a chain ends up looking stalled for a day.
   */
  mergeHeld?: readonly Task[];
  /**
   * The merge requests the pane is already showing for this card (`<MergeRequests>`).
   *
   * Read here so the **Create PR** slot can hold a LINK to an open one instead of a second
   * button that would only ever come back "there is already one of those". It is the same
   * list, passed down rather than fetched again: two sources for "does this card have a PR"
   * is exactly how a card ends up offering to create one it is displaying underneath.
   */
  mergeRequests?: readonly MergeRequest[];
}

export function TaskAgentPanel({
  task,
  subtasks = [],
  agentProjects,
  items = [],
  onOpenTask,
  onTaskChanged,
  running = false,
  liveRunTaskIds,
  merging = false,
  waitingOn = [],
  mergeHeld = [],
  mergeRequests = [],
}: TaskAgentPanelProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [assignOpen, setAssignOpen] = useState(false);
  // The card's own ask, or one belonging to a step: a card executing a plan stays
  // `in-progress` while a STEP holds the run, so its inbox item is keyed to the step and
  // was unreachable from here before Phase 12.
  //
  // One at a time, oldest first — answering it reveals the next, because the index drops
  // only the item that was resolved rather than blanking the whole slot.
  const item = items[0] ?? null;
  const queued = Math.max(0, items.length - 1);
  /**
   * What you are typing back to the agent, as a DRAFT (`./drafts`): looking at another card
   * to work out the answer — which is most of what answering an ask involves — no longer
   * empties the box on the way back.
   */
  const replyDraft = useDraft(draftKey(task.id, 'reply'), '');
  const reply = replyDraft.value;
  // Pulled out because `answer` below is memoised: the hook's own callbacks are stable per
  // card, while the object holding them is a fresh one every render.
  const resetReply = replyDraft.reset;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Merge has been pressed but the engine has not said so yet.
   *
   * Only ever bridges the round trip: it is raised on click and lowered when `merging`
   * arrives (or when the call comes back refused). Without it the button would sit inert
   * for the length of one IPC hop — small, but it is precisely the moment the human is
   * looking for a response, and "nothing happened when I clicked" is the bug.
   */
  const [mergePressed, setMergePressed] = useState(false);
  const mergeBusy = mergePressed || merging;
  /**
   * A PREDECESSOR whose Merge was pressed from here, if any.
   *
   * Not lowered when the call resolves, unlike `mergePressed` above: `merging` only ever
   * reports THIS card, so nothing would take over the way it does for our own branch, and
   * the git work runs on well past the hand-off. The block disappears of its own accord the
   * moment that card's `landedAt` arrives, which is the honest end of the wait; a refusal
   * lowers it, because then there is a sentence to read and something to press again.
   */
  const [mergingOther, setMergingOther] = useState<string | null>(null);
  /**
   * Create PR has been pressed and the engine has not answered yet.
   *
   * Local, unlike `merging`, and that is honest here where it would not be for the merge: the
   * IPC call resolves when the pull request EXISTS — push, POST, row and note are all inside
   * it — so the round trip is the whole of the wait rather than the start of it.
   */
  const [creatingPrNow, setCreatingPrNow] = useState(false);

  const taskId = task.id;
  // Which step (if any) the shown item belongs to, and which step has stopped the chain
  // when there is no item at all — the case a restart leaves behind, since items live in
  // the scheduler's memory and the step's status is all that survives.
  const itemStep =
    item && item.taskId !== taskId ? (subtasks.find((s) => s.id === item.taskId) ?? null) : null;
  const itemStepPosition = itemStep ? stepPosition(subtasks, itemStep.id) : null;
  const stuck = parkedStep(subtasks);
  const stuckPosition = stuck ? stepPosition(subtasks, stuck.id) : null;
  const isStep = Boolean(task.parentTaskId);
  const live = task.status === 'running' || task.status === 'waiting-input';
  /**
   * A card's own steps — and a STEP's nothing.
   *
   * `subtasks` is the chain this pane is showing, which for a step is its SIBLINGS. Stop
   * stops the id it is drawn for, so a step must be weighed on its own state alone; asking
   * about its siblings would put a button on step 3 that claims to stop step 2.
   */
  const ownSteps = isStep ? [] : subtasks;
  /**
   * Is there work here to stop? Asked of {@link canStopWork} rather than of `task.status`,
   * which was blind to the two commonest cases: a card whose STEP holds the run (the card
   * stays `in-progress`, so the pane that offers the button had none), and the moment
   * between a run spawning and being persisted as `running`. A limit-parked card has no
   * process to kill but is still stoppable — that is what keeps it from silently resuming
   * when the limit lifts.
   */
  const stoppable = canStopWork(task, ownSteps, liveRunTaskIds);
  /** Whether pressing Stop reaches into the card's PLAN, which the tooltip should say. */
  const stopsChain = ownSteps.some(
    (s) => s.status === 'running' || s.status === 'waiting-input' || s.status === 'pending',
  );
  /**
   * Is there stopped work here to pick back up? Asked of {@link canResumeWork}, the mirror of
   * the call above and given the same three arguments — the same `ownSteps`, so a step is
   * judged on its own stop rather than on whichever sibling was stopped last.
   *
   * Mutually exclusive with {@link stoppable} by construction, which is why both can sit in
   * one header row without either of them having to know about the other.
   */
  const resumable = canResumeWork(task, ownSteps, liveRunTaskIds);
  /**
   * Whether pressing Resume re-queues the card's PLAN as well as rejoining the session — the
   * half of what the button does that the tooltip would otherwise leave unsaid, since a
   * stopped chain has nothing runnable in it until those steps go back to `pending`.
   */
  const resumesChain = ownSteps.some((s) => s.status === 'stopped');
  const assigned = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;
  // An agent is on the card, nothing is running, and nothing ever ran: it was assigned
  // without being started. "Has it run" is the test rather than the status, because a
  // staged card and a queued one are both `pending`.
  //
  // Not while Resume is offered, which is the one case both can be true at once: a card
  // stopped so early that nothing was written to `workedAt` still reads as never-started,
  // and the row would then hold two primary buttons each claiming to begin the work.
  // Resume wins — it rejoins the session if there is one and falls through to the ordinary
  // start path if there is not, so it is Start plus what Start forgets.
  const staged =
    Boolean(task.agentProjectId) &&
    !hasAgentWorked(task, ownSteps) &&
    task.status === 'pending' &&
    !resumable;
  /**
   * Whether to offer Merge: a delegated card that has actually run, in a repo that uses
   * worktrees. Derived here rather than asked of the engine, which would mean an async
   * round trip on every selection to answer a question the card already implies.
   *
   * Optimistic on purpose — if the branch turns out to be gone, `task:integrate` says so
   * in one line, which beats hiding the only button that can finish the job.
   *
   * `hasAgentWorked` and NOT `task.sessionId`, which is the bug this panel is best known
   * for: a card that finishes an approved plan has its session cleared on purpose
   * (`finishParentChain`), so all three controls below — Merge, "Merge when finished",
   * "Release after merge" — disappeared at exactly the moment the card's own timeline said
   * "review it, then choose Merge on the card". The branch was still sitting there.
   */
  const canIntegrate =
    Boolean(task.agentProjectId) &&
    hasAgentWorked(task, ownSteps) &&
    Boolean(assigned?.useWorktrees);
  /**
   * What happens when this card's branch merges: the card's own answer when it has one,
   * else the agent project's preference (`@tm/shared/release`).
   */
  const releasing = autoReleaseOn(task, assigned);
  /**
   * This card's OPEN merge request, if it has one. A settled one is the card's history —
   * it merged last Tuesday — and must not stop a new pull request being opened for new work.
   */
  const openMr = mergeRequests.find((mr) => !mrIsSettled(mr)) ?? null;
  /**
   * What to CALL a pull request here.
   *
   * Taken from the merge request the card already carries when there is one, because that is
   * the only forge this card is demonstrably on. With nothing to read it from, "pull
   * request" is the label — the neutral choice is not available (there isn't one), and GitHub
   * is what an unconfigured install most often means. The engine never guesses: it reads the
   * repo's own remote, and its refusal names the host if that turns out to be GitLab.
   */
  const prNoun = openMr ? mrNoun(openMr.provider) : 'pull request';
  /**
   * The same answer in two letters, for the button face and the toggle's tooltip/aria-label.
   *
   * Read off the PROVIDER, not off `prNoun` — both of these used to ask whether the noun
   * happened to equal the string `'merge request'`, which is a question about how
   * `@tm/shared/mergeRequest` words itself rather than about which forge this card is on. The
   * fallback is the same one `prNoun` takes, and for the same reason.
   */
  const prAbbrev = openMr ? mrAbbrev(openMr.provider) : 'PR';
  const prLabel = `Create ${prAbbrev}`;
  /**
   * Whether this card's branch is pushed and a PR opened when the work finishes, instead of
   * being merged here: the card's own answer when it has one, else the project's.
   */
  const creatingPr = autoCreatePrOn(task, assigned);
  /**
   * The app-wide merge default, which this card resolves through its project.
   *
   * Held here rather than passed down: the pane is reached from two different boards and
   * neither carries settings, and re-read on `settings:changed` so flipping the global
   * switch in Settings is reflected on an open card instead of on the next mount.
   */
  const [appAutoIntegrate, setAppAutoIntegrate] = useState(false);
  /**
   * Whether this card's branch merges itself when the work finishes: the card's own
   * answer when it has one, else the project's, else the app's (`@tm/shared/integrate`).
   */
  const autoMerging = autoIntegrateOn(task, assigned, { autoIntegrate: appAutoIntegrate });
  /** What this card would do if it stopped overriding — the value that means "inherit". */
  const inheritedIntegrate = projectAutoIntegrate(assigned, { autoIntegrate: appAutoIntegrate });
  /**
   * Whether the repo actually has release instructions. `null` while we are asking —
   * which is a real third state, not a false: rendering "no RELEASE.md" for the half
   * second before the answer arrives would tell every card a lie it then took back.
   */
  const [hasReleaseDoc, setHasReleaseDoc] = useState<boolean | null>(null);

  // The asks arrive as a prop; only the draft reply is local — and it is a draft, so
  // switching card parks it rather than clearing it (see `useDraft`).
  //
  // `error` and `busy` are cleared here for a reason worth keeping: this panel is not
  // remounted per card (the pane renders one instance and swaps its `task` prop), so
  // everything left in local state follows the selection. A refusal on one card was
  // therefore shown on the next card, and the next — including a card just created, which
  // opened already displaying a failure of something nobody had pressed on it. An error is
  // a fact about one attempt on one card; it cannot outlive the card it happened to.
  useEffect(() => {
    setError(null);
    setBusy(false);
    setMergePressed(false);
    setMergingOther(null);
    setCreatingPrNow(false);
  }, [taskId]);

  // Hand over cleanly: once the engine is reporting the merge, the local bridge lets go.
  // Lowering it on the IPC call resolving instead would blink, because that call returns
  // the moment the merge is handed off — before, or at best alongside, the first push.
  useEffect(() => {
    if (merging) setMergePressed(false);
  }, [merging]);

  // The app-wide merge default, kept live. A card that has not ruled and a project that
  // has not either both read straight through to this, so a switch flipped in Settings has
  // to reach an open card — otherwise the pane would keep showing yesterday's answer to a
  // question the engine will ask again at merge time.
  useEffect(() => {
    let alive = true;
    void transport
      .invoke('settings:get')
      .then((s) => alive && setAppAutoIntegrate(s.autoIntegrate))
      .catch(() => undefined);
    const off = transport.on('settings:changed', (next) => setAppAutoIntegrate(next.autoIntegrate));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Asked per project, and re-asked whenever the pane shows a different one: the file
  // appears the moment someone writes it, and this is the cheapest place to notice.
  useEffect(() => {
    const projectId = assigned?.id;
    if (!projectId) {
      setHasReleaseDoc(null);
      return;
    }
    let live = true;
    setHasReleaseDoc(null);
    void transport
      .invoke('project:hasReleaseDoc', projectId)
      .then((found) => live && setHasReleaseDoc(found))
      // A failed lookup must not disable the toggle — the engine checks the file again
      // at merge time, and that check is the one that decides anything.
      .catch(() => live && setHasReleaseDoc(true));
    return () => {
      live = false;
    };
  }, [assigned?.id]);

  const answer = useCallback(
    async (a: AttentionAnswer): Promise<void> => {
      if (!item) return;
      setBusy(true);
      setError(null);
      try {
        await transport.invoke('attention:answer', item.id, a);
        // No local clear of the ITEM: the engine emits `attention:resolved` and the board's
        // index drops exactly this one, leaving any sibling ask standing. The reply itself
        // has been sent, so its draft is spent.
        resetReply();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [item, resetReply],
  );

  /**
   * Merge this card's branch into base, on the human's say-so.
   *
   * Note what this call does NOT wait for: it resolves once the merge has been handed to
   * git, and the rebase-and-fast-forward that follows can run for a minute afterwards. So
   * the spinner is not tied to this promise — `merging` is, and it comes from the engine
   * (see `useIntegratingTasks`). `busy` is deliberately left alone here for the same
   * reason: it would go back down while the merge was still running and re-enable every
   * button on the panel.
   */
  async function integrate(): Promise<void> {
    setMergePressed(true);
    setError(null);
    try {
      await transport.invoke('task:integrate', taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Whatever happened, stop bridging: either `merging` has taken over by now, or the
      // merge was refused and the error above says why. Leaving this raised on a refusal
      // is the one way this could spin forever.
      setMergePressed(false);
    }
  }

  /**
   * Merge a PREDECESSOR's branch — the one thing this card is waiting for.
   *
   * The same `task:integrate` call as `integrate` above, addressed at the other card, and
   * for the same reason it is safe to offer optimistically: every refusal ("no branch",
   * "not a worktree repo", a conflict) arrives as one thrown sentence and lands in `error`
   * below. Nothing here has to know whether that card can merge; the merge itself knows.
   *
   * Once it lands, the chain does the rest — this card starts by itself, with no second
   * thing for the human to remember to press.
   */
  async function integrateOther(id: string): Promise<void> {
    setMergingOther(id);
    setError(null);
    try {
      await transport.invoke('task:integrate', id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMergingOther(null);
    }
  }

  /**
   * Turn auto-release on or off for THIS card.
   *
   * Choosing what the project already prefers stores `null` rather than the same value
   * again, which puts the card back to inheriting: a human who agrees with the default
   * has not disagreed with it, and should keep following it when it changes.
   */
  async function setAutoRelease(on: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(
        await transport.invoke('task:setAgentOptions', taskId, {
          autoRelease: on === Boolean(assigned?.autoRelease) ? null : on,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Turn auto-merge on or off for THIS card.
   *
   * Same rule as the release toggle above, one level deeper: choosing what the card would
   * have done anyway stores `null`, which puts it back to inheriting from the project (and
   * through it from the app). Agreeing with a default is not disagreeing with it.
   */
  async function setAutoIntegrate(on: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(
        await transport.invoke('task:setAgentOptions', taskId, {
          autoIntegrate: on === inheritedIntegrate ? null : on,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Turn "open a PR when finished" on or off for THIS card.
   *
   * Same rule as the release toggle: choosing what the project already prefers stores `null`
   * rather than the same value again, which puts the card back to inheriting.
   */
  async function setAutoCreatePr(on: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(
        await transport.invoke('task:setAgentOptions', taskId, {
          autoCreatePr: on === Boolean(assigned?.autoCreatePr) ? null : on,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Push this card's branch and open a pull request for it, on the human's say-so.
   *
   * Unlike `integrate`, this one really is finished when the promise is: the engine pushes,
   * POSTs, writes the row and files the note before it resolves. The row arriving is what
   * makes the button turn into a link — nothing here has to set that itself.
   *
   * A pull request that was ALREADY open is not an error and is not announced: the card is
   * about to show it, which is the answer the human wanted.
   */
  async function createPullRequest(): Promise<void> {
    setCreatingPrNow(true);
    setError(null);
    try {
      await transport.invoke('task:createPullRequest', taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingPrNow(false);
    }
  }

  /**
   * Re-enter a chain that stopped: run the parked step again in the card's worktree.
   *
   * `task:run` throws for every wall a human has to clear, so the catch below is still the
   * whole error path. What it does NOT throw for is a usage limit — the step is parked in
   * the gate and starts at the reset — and that one arrives as a `{ refused }` outcome
   * instead. Nothing to report: leaving `error` clear is deliberate, because the step's own
   * row is already showing the hold the engine wrote on it.
   */
  async function runStep(stepId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('task:run', stepId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Start this card despite the chain (the human override).
   *
   * The link is deliberately NOT removed: plenty of chains are drawn as a reminder of the
   * order things ought to be looked at, and erasing the arrow to get one card moving would
   * throw that record away to solve a problem it did not cause. The engine files a note on
   * the card saying it went ahead of its predecessors, so the timeline still reads straight.
   */
  async function releaseNow(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // A refusal comes back as a sentence, not as a throw — see `chain:releaseNow`.
      setError(await transport.invoke('chain:releaseNow', taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(await transport.invoke('task:stopAgent', taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pick stopped work back up — the inverse of {@link stop}, and the same shape as it.
   *
   * The returned task is handed on even though the engine also emits `task:changed`: exactly
   * as Stop does, so the card the human is looking at is right on the next paint rather than
   * on the next event. That hand-on is also what makes a resume the LIMIT parks read as
   * "held" rather than as "nothing happened" — it no longer throws, it resolves with the
   * parked card, and painting that card is what puts "Paused — usage limit" in the pane
   * instead of an error line claiming the resume failed.
   *
   * The sign-out gate still arrives as a throw and lands in `error` below, and must: it
   * writes nothing on the card (`CARD_RECORDS_PARK`), so that sentence is the only place
   * the human is ever told to sign in.
   */
  async function resume(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(await transport.invoke('task:resumeAgent', taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        {/* Pulses while the agent works, exactly as the board card's does. The band at the
            bottom of the pane keeps its spinner and its words — there the sentence IS the
            point, rather than a third telling of it. */}
        <AgentGlyph running={running} size="18px" />
        <Text weight="semibold">Agent</Text>
        {assigned ? (
          <Badge appearance="tint" color="informative">
            {assigned.name}
          </Badge>
        ) : task.agentProjectId ? (
          <Badge appearance="tint" color="danger">
            project removed
          </Badge>
        ) : (
          <Caption1 className={styles.hint}>Not assigned</Caption1>
        )}
        <span className={styles.grow} />
        {/* The three auto-toggles: what happens to this card's branch without anyone
            pressing a button. They live here, in the header row, next to the actions they
            pre-answer — Merge, Create PR, and (via the chain) a release — rather than in a
            stack of their own, because each is a standing answer to "what does that button
            do by itself", not a separate decision screen.

            Offered on the same terms as Merge: a delegated card that has actually run, in a
            worktree repo, and not a step (a step inherits the card's answers, it does not
            hold its own). An icon-only control has no `Field` hint paragraph beside it, so
            the full explanation — including the current on/off state, which the label used
            to say — moves into the tooltip; see `agentAutoToggles`. */}
        {canIntegrate && !isStep && (
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<MergeRegular />}
            checked={autoMerging}
            // Not while one is running: the answer has already been taken for this branch,
            // and a toggle that appeared to change it would be describing the past.
            disabled={busy || mergeBusy}
            title={autoMergeTooltip({
              on: autoMerging,
              baseBranch: assigned?.baseBranch,
              projectName: assigned?.name,
              inherited: inheritedIntegrate,
            })}
            aria-label={`Merge when finished, ${autoMerging ? 'on' : 'off'}`}
            onClick={() => void setAutoIntegrate(!autoMerging)}
          />
        )}
        {canIntegrate && !isStep && (
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<BranchRequestRegular />}
            checked={creatingPr}
            // Read when the work settles, so once a merge is under way the answer has been
            // taken and changing it could only describe the past.
            disabled={busy || mergeBusy}
            title={autoCreatePrTooltip({
              on: creatingPr,
              prNoun,
              projectName: assigned?.name,
              projectDefaultOn: Boolean(assigned?.autoCreatePr),
            })}
            aria-label={`Open a ${prAbbrev} when finished, ${creatingPr ? 'on' : 'off'}`}
            onClick={() => void setAutoCreatePr(!creatingPr)}
          />
        )}
        {canIntegrate && !isStep && (
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<RocketRegular />}
            checked={releasing}
            className={hasReleaseDoc === false && releasing ? styles.warn : undefined}
            // The merge is the deadline this toggle is read at, so once one is running the
            // answer is already taken — changing it now could only mislead.
            disabled={busy || mergeBusy}
            title={autoReleaseTooltip({
              on: releasing,
              projectName: assigned?.name,
              hasReleaseDoc,
            })}
            aria-label={`Release after merge, ${releasing ? 'on' : 'off'}`}
            onClick={() => void setAutoRelease(!releasing)}
          />
        )}
        {/* The one control that ends a run. Its branch and worktree are left where they
            are, so this is a pause you can pick up again — send the agent a message and
            the session resumes. Said in the tooltip, because a button that reads "Stop"
            next to a working agent is otherwise scarier than what it does. */}
        {stoppable && (
          <Button
            size="small"
            icon={<RecordStopRegular />}
            disabled={busy}
            title={
              stopsChain
                ? 'Stop the agent: the step that is running is stopped and the steps queued ' +
                  "behind it are cancelled. The card's branch and worktree are kept."
                : 'Stop the agent working on this card. Its branch and worktree are kept, so ' +
                  'you can pick the work up again.'
            }
            onClick={() => void stop()}
          >
            Stop
          </Button>
        )}
        {/* Stop's inverse, in Stop's place — the two are mutually exclusive by construction
            (see `canResumeWork`), so the slot only ever holds one of them and the row does
            not shuffle when work starts or ends.

            The tooltip says the thing the word "Resume" cannot: this is not a fresh start.
            The agent rejoins the conversation it was in, in the worktree it left, and so it
            already knows what it had done — which is exactly what makes pressing this
            different from pressing Start, and worth saying before the click. */}
        {resumable && (
          <Button
            size="small"
            appearance="primary"
            icon={<PlayCircleRegular />}
            disabled={busy}
            title={
              resumesChain
                ? 'Pick the work up in the same conversation: the agent carries on from where ' +
                  "it stopped, in this card's worktree, and the steps queued behind it are " +
                  'queued again.'
                : 'Pick the work up in the same conversation: the agent carries on from where ' +
                  "it stopped, in this card's worktree."
            }
            onClick={() => void resume()}
          >
            Resume
          </Button>
        )}
        {/* Assigned but never started (Phase 17). The affordance for a staged card —
            sending it a message starts it too, but a card you have nothing to say to yet
            still needs a way to begin. */}
        {/* Merging is the human's call: a branch is merged when it has been reviewed,
            not at the instant the agent happened to stop.

            It is also the slowest thing on this panel and the only one that used to look
            instantaneous: a rebase onto a base that has moved can take a minute, and the
            button simply sat there unchanged for all of it. So it wears the spinner and
            says what it is doing until the engine reports the merge has settled. */}
        {canIntegrate && !isStep && !live && (
          <Button
            size="small"
            disabled={busy || mergeBusy}
            icon={mergeBusy ? <Spinner size="tiny" /> : undefined}
            title={
              mergeBusy
                ? 'Rebasing this branch onto its base and fast-forwarding — this can take a minute.'
                : "Merge this card's branch into its base branch."
            }
            onClick={() => void integrate()}
          >
            {mergeBusy ? 'Merging…' : 'Merge branch'}
          </Button>
        )}
        {/* The other way a branch leaves this card: pushed to the forge with a pull request
            on it, rather than merged here. Offered on the same terms as Merge — a delegated
            card that has run, in a worktree repo, not a step and not mid-run — and only
            while there is nothing open: once there IS a pull request the slot becomes a link
            to it, because a second create would only ever be refused as a duplicate. */}
        {canIntegrate && !isStep && !live && !openMr && (
          <Button
            size="small"
            disabled={busy || mergeBusy || creatingPrNow}
            icon={creatingPrNow ? <Spinner size="tiny" /> : undefined}
            title={
              creatingPrNow
                ? "Pushing this card's branch and opening a request for it."
                : `Push this card's branch and open a ${prNoun} against its base branch, ` +
                  `instead of merging it here.`
            }
            onClick={() => void createPullRequest()}
          >
            {creatingPrNow ? 'Opening…' : prLabel}
          </Button>
        )}
        {canIntegrate && !isStep && openMr && (
          <Button
            size="small"
            as="a"
            href={openMr.webUrl}
            target="_blank"
            rel="noreferrer"
            title={`Open ${mrRef(openMr)} on the forge — this card already has one.`}
          >
            {mrRef(openMr)}
          </Button>
        )}
        {staged && (
          <Button
            size="small"
            appearance="primary"
            disabled={busy}
            title="Start the agent on this card now."
            onClick={() => void runStep(taskId)}
          >
            Start
          </Button>
        )}
        {/* A step is never delegated on its own: it inherits the card's agent project
            and runs in the card's worktree, in its turn. Stop is still offered. */}
        {isStep ? (
          <Caption1 className={styles.hint}>Runs with its card</Caption1>
        ) : (
          <Button
            size="small"
            appearance={task.agentProjectId ? 'secondary' : 'primary'}
            // Not while its branch is being merged either: reassigning restarts the run in
            // the same worktree, which is the directory the rebase is standing in.
            disabled={live || mergeBusy}
            title={
              live
                ? 'Stop the agent before reassigning this card.'
                : mergeBusy
                  ? 'Wait for the merge to finish before reassigning this card.'
                  : undefined
            }
            onClick={() => setAssignOpen(true)}
          >
            {task.agentProjectId ? 'Reassign…' : 'Assign to an agent…'}
          </Button>
        )}
      </div>

      {task.agentProjectId && (
        <Caption1 className={styles.hint}>
          {task.agentBranch ? `${task.agentBranch} · ` : ''}
          {cardModelCaption(task, assigned)} ·{' '}
          {
            PERMISSION_MODE_LABELS[
              task.agentMode ?? assigned?.defaultPermissionMode ?? 'acceptEdits'
            ]
          }
          {assigned ? ` · ${assigned.path}` : ''}
        </Caption1>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Chained behind something that has not finished. The engine will start this card by
          itself the moment its predecessors land — so this block exists for the case where
          the human does not want to wait: some chains only ever record the order things
          ought to be LOOKED at, and there the gate is an obstacle rather than a safeguard. */}
      {waitingOn.length > 0 && !isStep && !live && (
        <div className={styles.blocked}>
          <Text weight="semibold">
            {waitingOn.length === 1
              ? 'Waiting on another card'
              : `Waiting on ${waitingOn.length} other cards`}
          </Text>
          <Caption1 className={styles.hint}>
            This card is chained to run after{' '}
            {waitingOn.map((t) => t.externalKey || t.title).join(', ')}, and starts by itself when{' '}
            {waitingOn.length === 1 ? 'it is' : 'they are'} done. Release it now to go ahead anyway
            — the chain keeps the ordering either way.
          </Caption1>
          {/* The part that is actually YOURS to do. Named separately from the sentence above
              because "starts by itself when it is done" is true and, for a card that finished
              days ago and is sitting in review, deeply misleading: nothing further is going to
              happen until somebody merges it. */}
          {mergeHeld.length > 0 && (
            <Caption1 className={styles.hint}>
              {mergeHeld.length === 1
                ? `${mergeHeld[0].externalKey || mergeHeld[0].title} has already finished — its branch just has not been merged yet.`
                : `${mergeHeld.length} of them have already finished — their branches just have not been merged yet.`}{' '}
              Merge {mergeHeld.length === 1 ? 'it' : 'them'} here and this card starts on its own.
            </Caption1>
          )}
          <div className={styles.choices}>
            <Button disabled={busy} onClick={() => void releaseNow()}>
              Release now
            </Button>
            {waitingOn.map((t) => (
              <Fragment key={t.id}>
                <Button appearance="subtle" disabled={busy} onClick={() => onOpenTask?.(t.id)}>
                  Open {t.externalKey || t.title}
                </Button>
                {mergeHeld.some((h) => h.id === t.id) && (
                  <Button
                    disabled={busy || mergingOther !== null}
                    icon={mergingOther === t.id ? <Spinner size="tiny" /> : undefined}
                    title={`Merge ${t.externalKey || t.title}'s branch into its base — the one thing this card is waiting for.`}
                    onClick={() => void integrateOther(t.id)}
                  >
                    {mergingOther === t.id ? 'Merging…' : `Merge ${t.externalKey || t.title}`}
                  </Button>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {/* The chain stopped and its inbox item is gone (items live in the scheduler, so a
          restart loses them). Nothing here can resolve it, but the step can be re-run —
          and saying so beats a card that silently never finishes. */}
      {!item && stuck && (
        <div className={styles.ask}>
          <Text weight="semibold">
            {stuckPosition !== null
              ? `The plan stopped at step ${stuckPosition} of ${subtasks.length}`
              : 'The plan has stopped'}
          </Text>
          <Caption1 className={styles.hint}>
            {stuck.title} is {STATUS_LABEL[stuck.status].toLowerCase()}, so the remaining steps are
            waiting. Open it to read what happened, or run it again — it picks up in this
            card&apos;s worktree.
          </Caption1>
          <div className={styles.choices}>
            <Button appearance="primary" disabled={busy} onClick={() => void runStep(stuck.id)}>
              Run this step again
            </Button>
            <Button disabled={busy} onClick={() => onOpenTask?.(stuck.id)}>
              Open step
            </Button>
          </div>
        </div>
      )}

      {item && (
        <div className={styles.ask}>
          {itemStep && (
            <Caption1 className={styles.stepOwner}>
              {itemStepPosition !== null
                ? `Step ${itemStepPosition} of ${subtasks.length} — ${itemStep.title}`
                : itemStep.title}
            </Caption1>
          )}
          <div className={styles.head}>
            <Text weight="semibold">
              {item.kind === 'permission'
                ? 'The agent needs permission'
                : item.kind === 'merge-conflict'
                  ? 'Merge conflict — resolve it in the worktree'
                  : item.kind === 'plan-approval'
                    ? 'The agent finished planning — approve to run it'
                    : item.kind === 'task-failed'
                      ? // A failure has resolutions, not answers — saying "question" here
                        // (as this did before Phase 12) hid what the buttons below do.
                        `The run failed — pick how to continue${itemStep ? ', and the chain resumes' : ''}`
                      : item.kind === 'agent-question'
                        ? 'The agent is asking you to choose'
                        : 'The agent has a question'}
            </Text>
          </div>
          {/* Markdown, not raw monospace: agents write backticked identifiers, lists and
              headings into these, and showing the source made a plan unreadable. */}
          <div className={styles.prompt}>
            <Markdown source={item.prompt} />
          </div>
          {/* Say that more is waiting. Silence here is what made answering one ask feel
              like it had swallowed the others. */}
          {queued > 0 && (
            <Caption1 className={styles.hint}>
              {queued} more {queued === 1 ? 'ask' : 'asks'} waiting after this one.
            </Caption1>
          )}
          {item.reason && (
            <Caption1 className={styles.hint}>Held because it {item.reason}.</Caption1>
          )}
          {item.worktreePath && (
            <Caption1 className={styles.hint} title={item.worktreePath}>
              Worktree: {item.worktreePath}
            </Caption1>
          )}

          {item.kind === 'plan-approval' && (
            <>
              {item.plan && (
                <div className={styles.plan}>
                  <Markdown source={item.plan} />
                </div>
              )}
              {(item.steps?.length ?? 0) > 0 ? (
                <>
                  <Caption1 className={styles.hint}>
                    Approving creates {item.steps!.length} step
                    {item.steps!.length === 1 ? '' : 's'}, run one at a time in their own sessions
                    on this card&apos;s branch:
                  </Caption1>
                  <div className={styles.steps}>
                    {item.steps!.map((step, i) => (
                      <div key={`${i}-${step}`} className={styles.step}>
                        <Caption1 className={styles.stepIndex}>{i + 1}.</Caption1>
                        <Caption1>{step}</Caption1>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Caption1 className={styles.hint}>
                  No plan text was captured, so approving would leave this card with nothing to run
                  — re-plan instead.
                </Caption1>
              )}
            </>
          )}

          {/* A structured question gets the real form: several questions, multi-select,
              and the per-option descriptions that are the whole reason the CLI asks this
              way rather than in prose. The flat `options` path below cannot carry any of
              that, which is what made these unreadable. */}
          {item.kind === 'agent-question' && (item.questions?.length ?? 0) > 0 ? (
            <AgentQuestionForm
              // Keyed to the ask: this slot shows one item at a time, and the form
              // initialises its selections ONCE, so without a key the next ask inherits
              // the previous one's answers.
              key={item.id}
              questions={item.questions!}
              busy={busy}
              onAnswer={(a) => void answer(a)}
            />
          ) : item.kind === 'permission' ||
            item.kind === 'merge-conflict' ||
            item.kind === 'plan-approval' ? (
            <div className={styles.answerRow}>
              <Field className={styles.grow} label="Optional note to the agent">
                <Textarea
                  value={reply}
                  resize="vertical"
                  onChange={(_e, d) => replyDraft.set(d.value)}
                  placeholder="Add guidance (optional)…"
                />
              </Field>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() =>
                  void answer({ decision: 'approve', note: reply.trim() || undefined })
                }
              >
                {item.kind === 'merge-conflict'
                  ? 'Resolved — finish merge'
                  : item.kind === 'plan-approval'
                    ? 'Approve plan'
                    : 'Approve'}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void answer({ decision: 'deny', note: reply.trim() || undefined })}
              >
                {item.kind === 'merge-conflict'
                  ? 'Abandon'
                  : item.kind === 'plan-approval'
                    ? 'Re-plan'
                    : 'Deny'}
              </Button>
            </div>
          ) : (
            <>
              {item.options.length > 0 && (
                <div className={styles.choices}>
                  {item.options.map((option) => (
                    <Button
                      key={option}
                      appearance={option === item.options[0] ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() =>
                        void answer({
                          decision: 'reply',
                          text: option,
                          note: reply.trim() || undefined,
                        })
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <div className={styles.answerRow}>
                <Field
                  className={styles.grow}
                  label={
                    item.kind === 'task-failed'
                      ? 'Optional note (sent with the resolution you pick)'
                      : item.options.length > 0
                        ? 'Or answer in your own words'
                        : 'Your answer'
                  }
                >
                  <Textarea
                    value={reply}
                    resize="vertical"
                    onChange={(_e, d) => replyDraft.set(d.value)}
                    placeholder="Type your reply…"
                  />
                </Field>
                {/* A failure is resolved by choosing one of the buttons above; free text
                    would only re-park it, so there is no Send here. */}
                {item.kind !== 'task-failed' && (
                  <Button
                    appearance="primary"
                    disabled={busy || reply.trim().length === 0}
                    onClick={() => void answer({ decision: 'reply', text: reply.trim() })}
                  >
                    Send
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <AssignAgentDialog
        open={assignOpen}
        task={task}
        agentProjects={agentProjects}
        onClose={() => setAssignOpen(false)}
        onAssigned={onTaskChanged}
      />
    </div>
  );
}
