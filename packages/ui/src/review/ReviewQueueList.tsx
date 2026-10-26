/**
 * The review workspace's queue column: three collapsible groups in `QUEUE_ORDER`, each with
 * its count. Each row is two lines: the faint mono PR ref (`!412`/`#88`; a task row has none),
 * the title, the author's avatar and — only when there are drafts — a draft count; then a faint
 * meta caption, `author · +a −d · pipeline`, joining only the parts the row knows. Pure: the snapshot, the selection and which groups are collapsed
 * all come in as props, so the parent owns the state and this renders under
 * `renderToStaticMarkup`.
 *
 * Monochrome (memory *board-colour-budget*): a ref, an author and a draft count are static
 * facts about a row, so nothing here takes a hue — except the pipeline dot, because a pipeline
 * moves. The selected row reuses the tree's own selected background.
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
import type { PipelineStatus } from '@tm/shared/mergeRequest';
import type { ReviewQueue, ReviewQueueItem, ReviewQueuesSnapshot } from '@tm/shared/review';
import { PIPELINE_WORD } from '../issues/IssueBuilt';
import { MONO } from '../theme';
import { PIPELINE_VAR } from '../tokens';
import { groupQueue } from './reviewWorkspaceModel';

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
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  selected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  line: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  ref: { flexShrink: 0, fontFamily: MONO, color: tokens.colorNeutralForeground3 },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  trailing: { flexShrink: 0, display: 'flex', alignItems: 'center', columnGap: '4px' },
  meta: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '4px',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
});

/** A pipeline worth naming on a row — `unknown` and `none` say nothing a reader can use. */
function knownPipeline(item: ReviewQueueItem): PipelineStatus | null {
  const status = item.pipeline ?? null;
  return status === null || status === 'unknown' || status === 'none' ? null : status;
}

/**
 * A row's meta line before the pipeline: the author, then `+a −d` once both counts are known.
 * Only the parts the row knows are joined, so a row with nothing yields `[]`.
 */
export function queueRowMeta(item: ReviewQueueItem): string[] {
  const parts: string[] = [];
  if (item.author) parts.push(item.author);
  if (item.additions != null && item.deletions != null) {
    parts.push(`+${item.additions} −${item.deletions}`);
  }
  return parts;
}

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
                  const meta = queueRowMeta(item);
                  const pipeline = knownPipeline(item);
                  return (
                    <div
                      key={item.subjectId}
                      role="option"
                      aria-selected={selected}
                      data-subject-id={item.subjectId}
                      className={mergeClasses(styles.row, selected && styles.selected)}
                      onClick={() => onSelect(item)}
                    >
                      <div className={styles.line}>
                        {item.ref !== '' && (
                          <Caption1 className={styles.ref} data-ref>
                            {item.ref}
                          </Caption1>
                        )}
                        <span className={styles.title} title={item.title}>
                          {item.title}
                        </span>
                        <span className={styles.trailing}>
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
                          )}
                          <Avatar name={item.author} size={20} />
                        </span>
                      </div>
                      {(meta.length > 0 || pipeline) && (
                        <Caption1 className={styles.meta} data-meta>
                          {meta.join(' · ')}
                          {pipeline && (
                            <>
                              {meta.length > 0 && ' · '}
                              <span
                                className={styles.dot}
                                style={{ backgroundColor: PIPELINE_VAR[pipeline] }}
                                aria-hidden
                              />
                              {PIPELINE_WORD[pipeline]}
                            </>
                          )}
                        </Caption1>
                      )}
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
