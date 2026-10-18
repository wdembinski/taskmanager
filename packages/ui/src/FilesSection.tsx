/**
 * FilesSection — every attachment of the card AND of its steps, in one place.
 *
 * Step attachments render only inside `TaskSteps`' own step editor
 * (`attachmentsInScope`), so a file an agent dropped on a step that isn't the one open —
 * or that finished and folded shut — was reachable from nowhere else. This section is the
 * card panel's own answer: one list, grouped by whichever task (the card itself, or one of
 * its steps) the file actually hangs off, newest group first and newest file first within
 * a group — the same order a human reading "what just happened" wants.
 *
 * Deliberately NOT gated on `shotPairs`/visual sign-off's own rules: a plain log file or a
 * hand-attached PDF belongs here even though it is never a "screen".
 */
import { Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { Task } from '@tm/shared/model';
import type { TaskAttachment } from '@tm/shared/attachments';
import { AttachmentGallery } from './AttachmentGallery';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px' },
  group: { display: 'flex', flexDirection: 'column', gap: '4px' },
  groupHead: { color: tokens.colorNeutralForeground3 },
});

export interface FilesSectionProps {
  /** The card's own id — the heading for its own group of files. */
  cardId: string;
  cardTitle: string;
  /** The card's own attachments. */
  attachments: readonly TaskAttachment[];
  /** Every one of the card's steps' own attachments, flat — grouped here by `taskId`. */
  subtaskAttachments: readonly TaskAttachment[];
  /** The card's steps, read only for each group's own heading. */
  subtasks: readonly Task[];
}

interface FileGroup {
  id: string;
  title: string;
  attachments: readonly TaskAttachment[];
  latest: number;
}

function newestFirst(attachments: readonly TaskAttachment[]): TaskAttachment[] {
  return [...attachments].sort((a, b) => b.createdAt - a.createdAt);
}

/** Renders nothing when neither the card nor any of its steps carries a single file. */
export function FilesSection({
  cardId,
  cardTitle,
  attachments,
  subtaskAttachments,
  subtasks,
}: FilesSectionProps): JSX.Element | null {
  const styles = useStyles();

  const titleByStepId = new Map(subtasks.map((s) => [s.id, s.title]));
  const byStep = new Map<string, TaskAttachment[]>();
  for (const a of subtaskAttachments) {
    const list = byStep.get(a.taskId);
    if (list) list.push(a);
    else byStep.set(a.taskId, [a]);
  }

  const groups: FileGroup[] = [];
  if (attachments.length > 0) {
    groups.push({
      id: cardId,
      title: cardTitle,
      attachments,
      latest: Math.max(...attachments.map((a) => a.createdAt)),
    });
  }
  for (const [stepId, list] of byStep) {
    groups.push({
      id: stepId,
      // A step that was since deleted (re-planned away) still owns the file on disk — the
      // group still has to show it, just without a title the step no longer has.
      title: titleByStepId.get(stepId) ?? 'Removed step',
      attachments: list,
      latest: Math.max(...list.map((a) => a.createdAt)),
    });
  }
  if (groups.length === 0) return null;
  groups.sort((a, b) => b.latest - a.latest);

  return (
    <div className={styles.root} data-files-section>
      <Text weight="semibold">Files</Text>
      {groups.map((group) => (
        <div key={group.id} className={styles.group}>
          <Caption1 className={styles.groupHead}>{group.title}</Caption1>
          <AttachmentGallery attachments={newestFirst(group.attachments)} />
        </div>
      ))}
    </div>
  );
}
