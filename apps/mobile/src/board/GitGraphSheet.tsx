/**
 * The commit graph, on a phone — `@tm/ui`'s `GitGraphPane`, the same component the desktop
 * and the web draw beside the board, in a full-screen sheet rather than `boardLayout`'s 340px
 * `graph` pane.
 *
 * A fixed side pane is a desktop-window idea: it exists because there is room beside the
 * board for a second, narrower column. There is no "beside" on a 360px screen — a pane that
 * width would leave the board a sliver — so this opens the same picture over the whole
 * screen instead, the way a phone opens anything it means you to look at rather than glance
 * at sideways. `GitGraphPane` itself is unchanged: its root is already `flex: column` with
 * its own internal scroll, so it fills whatever height this sheet gives it.
 */
import {
  Button,
  Dialog,
  DialogSurface,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { Project, Task } from '@tm/shared/model';
import { GitGraphPane } from '@tm/ui/GitGraphPane';

const useStyles = makeStyles({
  surface: {
    width: '100dvw',
    height: '100dvh',
    maxWidth: '100dvw',
    maxHeight: '100dvh',
    margin: 0,
    padding: 0,
    borderRadius: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    flexShrink: 0,
    padding: '8px 8px 8px 16px',
    paddingTop: 'max(8px, env(safe-area-inset-top))',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { flex: 1, minHeight: 0, display: 'flex' },
});

export interface GitGraphSheetProps {
  open: boolean;
  onClose: () => void;
  projects: readonly Project[];
  selectedTask: Task | null;
  tasksById: ReadonlyMap<string, Task>;
  runningTaskIds: ReadonlySet<string>;
}

export function GitGraphSheet({
  open,
  onClose,
  projects,
  selectedTask,
  tasksById,
  runningTaskIds,
}: GitGraphSheetProps): JSX.Element {
  const styles = useStyles();
  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <div className={styles.header}>
          <Subtitle2>Commit graph</Subtitle2>
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            aria-label="Close"
            onClick={onClose}
          />
        </div>
        <div className={styles.body}>
          <GitGraphPane
            projects={projects}
            selectedTask={selectedTask}
            tasksById={tasksById}
            runningTaskIds={runningTaskIds}
          />
        </div>
      </DialogSurface>
    </Dialog>
  );
}
