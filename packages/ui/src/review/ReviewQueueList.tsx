/**
 * The review workspace's queue column: three collapsible groups in `QUEUE_ORDER`, each with
 * its count, each row the faint mono ref, the title, the author's avatar and — only when there
 * are drafts — a draft count. Pure: the snapshot, the selection and which groups are collapsed
 * all come in as props, so the parent owns the state and this renders under
 * `renderToStaticMarkup`.
 *
 * Monochrome (memory *board-colour-budget*): a ref, an author and a draft count are static
 * facts about a row, so nothing here takes a hue; the selected row reuses the tree's own
 * selected background.
 */
import type { JSX } from 'react';
import {
  Avatar,
  Badge,
  Caption1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { ReviewQueue, ReviewQueueItem, ReviewQueuesSnapshot } from '@tm/shared/review';
import { MONO } from '../theme';
import { groupQueue } from './reviewWorkspaceView';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    width: '100%',
    padding: '4px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    textAlign: 'left',
  },
  count: { marginLeft: 'auto', color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    columnGap: '8px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  selected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  ref: { fontFamily: MONO, color: tokens.colorNeutralForeground3 },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

export interface ReviewQueueListProps {
  snapshot: ReviewQueuesSnapshot;
  selectedSubjectId: string | null;
  collapsed: readonly ReviewQueue[];
  onToggleGroup: (queue: ReviewQueue) => void;
  onSelect: (item: ReviewQueueItem) => void;
}

export function ReviewQueueList({
  snapshot,
  selectedSubjectId,
  collapsed,
  onToggleGroup,
  onSelect,
}: ReviewQueueListProps): JSX.Element {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      {groupQueue(snapshot).map((group) => {
        const open = !collapsed.includes(group.queue);
        return (
          <section key={group.queue} data-queue={group.queue}>
            <button
              type="button"
              className={styles.header}
              aria-expanded={open}
              onClick={() => onToggleGroup(group.queue)}
            >
              {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
              <span>{group.label}</span>
              <Caption1 className={styles.count} data-count>
                {group.items.length}
              </Caption1>
            </button>
            {open && (
              <div role="listbox" aria-label={group.label} className={styles.list}>
                {group.items.map((item) => {
                  const selected = item.subjectId === selectedSubjectId;
                  return (
                    <div
                      key={item.subjectId}
                      role="option"
                      aria-selected={selected}
                      data-subject-id={item.subjectId}
                      className={mergeClasses(styles.row, selected && styles.selected)}
                      onClick={() => onSelect(item)}
                    >
                      <Caption1 className={styles.ref}>{item.ref}</Caption1>
                      <span className={styles.title} title={item.title}>
                        {item.title}
                      </span>
                      <span>
                        {item.draftCount > 0 && (
                          <Badge
                            appearance="outline"
                            color="informative"
                            size="small"
                            data-drafts
                            title={`${item.draftCount} unsent`}
                          >
                            {item.draftCount}
                          </Badge>
                        )}{' '}
                        <Avatar name={item.author} size={20} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
