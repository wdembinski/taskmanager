/**
 * A card, full screen — `@tm/ui`'s `TaskDetail`, the same component the desktop draws in
 * its 40% pane, with nothing forked inside it: `TaskDetail`'s root is already `flex: 1;
 * minWidth: 0` with no fixed width anywhere in the file, and 24 of its ~25 props are
 * optional (docs/plan/README.md, Phase 27 step 2 — "already shared, staying in `@tm/ui`
 * unchanged"). What this file adds is only the frame a phone needs around it: a header
 * with a BACK chevron rather than the desktop's side-by-side layout, since selecting a
 * card here is a screen pushed over the whole board rather than a pane opening beside it.
 *
 * `readOnlyNotice` carries the same warning `apps/web`'s own `BoardScreen` wears
 * (`RELAY_NOTICE`): mobile edits travel the identical `@tm/cloud` `HttpTransport` relay a
 * browser tab does, so the same "carried out by your desktop app" sentence applies here.
 * It is absent on the desktop only because the desktop applies its own edits in-process.
 *
 * `chainLinks`/`chainTasksById`/`onUnlinkChain` are what let `TaskDetail`'s own `TaskChain`
 * section stand in for the chain overlay this app dropped (step 2, "Dropped" — an arrow has
 * nothing to span when the board shows one column at a time): the same "Waiting on" /
 * "Releases" list the web's pane reads, reachable without a mouse.
 *
 * The keyboard is handled at the document level, not here: `index.html`'s
 * `interactive-widget=resizes-content` (added this step) makes `100dvh` shrink for the
 * on-screen keyboard the same way it already shrinks for the browser's own chrome
 * (`MobileShell.tsx`'s own comment) — so `TaskDetail`'s fixed bottom composer band, pinned
 * by this screen's `100dvh` height, stays above the keyboard rather than under it.
 */
import { Button, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { ChevronLeftRegular } from '@fluentui/react-icons';
import type { Project, Task } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { TaskLink } from '@tm/shared/taskChain';
import type { PriorityDisplay } from '@tm/shared/settings';
import type { StatusKeyword } from '@tm/shared/statusKeywords';
import { TaskDetail } from '@tm/ui/TaskDetail';
import type { AttentionIndex } from '@tm/ui/attentionIndex';

const useStyles = makeStyles({
  root: {
    position: 'fixed',
    inset: 0,
    width: '100dvw',
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    zIndex: 1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    padding: '4px 8px 4px 4px',
    paddingTop: 'max(4px, env(safe-area-inset-top))',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: { flex: 1, minHeight: 0, display: 'flex', paddingBottom: 'env(safe-area-inset-bottom)' },
});

/** The same warning `apps/web`'s own `RELAY_NOTICE` wears — see the file header. */
export const RELAY_NOTICE =
  'Edits here are carried out by your desktop app and show up on its next sync — a few ' +
  'seconds. A few controls (file pickers, credentials, window buttons) only work over there.';

export interface TaskScreenProps {
  task: Task;
  agentProjects: Project[];
  subtasks: Task[];
  parentTask: Task | null;
  mergeRequests: MergeRequest[];
  attachments: readonly TaskAttachment[];
  parentAttachments: readonly TaskAttachment[];
  statusKeywords: readonly StatusKeyword[];
  priorityDisplay: PriorityDisplay;
  attention: AttentionIndex;
  liveRunTaskIds: ReadonlySet<string>;
  mergingTaskIds: ReadonlySet<string>;
  chainWaitingOn?: readonly Task[];
  chainMergeHeld?: readonly Task[];
  chainLinks: readonly TaskLink[];
  chainTasksById: ReadonlyMap<string, Task>;
  onUnlinkChain: (linkId: string) => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
  onStatusChanged: (task: Task) => void;
  onSubtasksChanged: () => void;
}

export function TaskScreen({ task, onClose, ...detail }: TaskScreenProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button
          appearance="transparent"
          icon={<ChevronLeftRegular />}
          aria-label="Back to the board"
          onClick={onClose}
        />
        <Subtitle2 className={styles.title}>{task.title}</Subtitle2>
      </div>
      <div className={styles.body}>
        <TaskDetail task={task} readOnlyNotice={RELAY_NOTICE} {...detail} />
      </div>
    </div>
  );
}
