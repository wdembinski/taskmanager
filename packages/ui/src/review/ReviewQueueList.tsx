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
 *
 * **Ask AI to review** (F16.13) is a row's context menu: a right-click opens it, so no visible
 * button is added (v9-6's rows have none). Its one item is disabled, with the reason as its
 * title, when `askAiReason` knows one. With no `onAskAi`, a row has no menu at all.
 */
import type { JSX } from 'react';
import {
  Avatar,
  Badge,
  Caption1,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { BotRegular, ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { ReviewQueue, ReviewQueueItem, ReviewQueuesSnapshot } from '@tm/shared/review';
import { PIPELINE_WORD } from '../issues/IssueBuilt';
import { MONO } from '../theme';
import { PIPELINE_VAR } from '../tokens';
import { groupQueue, knownPipeline } from './reviewWorkspaceModel';

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

/** A queue row's context menu: one *Ask AI to review*, disabled with `reason` as its title. */
export function AskAiMenuList({
  subjectId,
  reason,
  onAskAi,
}: {
  subjectId: string;
  reason: string | null;
  onAskAi: (subjectId: string) => void;
}): JSX.Element {
  return (
    <MenuList>
      <MenuItem
        icon={<BotRegular />}
        disabled={reason !== null}
        title={reason ?? undefined}
        data-ask-ai={subjectId}
        onClick={() => onAskAi(subjectId)}
      >
        Ask AI to review
      </MenuItem>
    </MenuList>
  );
}

export interface ReviewQueueListProps {
  snapshot: ReviewQueuesSnapshot;
  selectedSubjectId: string | null;
  collapsed: readonly ReviewQueue[];
  onToggleGroup: (queue: ReviewQueue) => void;
  onSelect: (item: ReviewQueueItem) => void;
  /** Starts an AI review of a row's subject — its context menu's one item. */
  onAskAi?: (subjectId: string) => void;
  /** Why a row's subject cannot be asked about, or null when it can (or nothing is known). */
  askAiReason?: (subjectId: string) => string | null;
}

export function ReviewQueueList({
  snapshot,
  selectedSubjectId,
  collapsed,
  onToggleGroup,
  onSelect,
  onAskAi,
  askAiReason,
}: ReviewQueueListProps): JSX.Element {
  const styles = useStyles();

  /** `row` wrapped in its context menu — see the module header. */
  function withMenu(subjectId: string, row: JSX.Element): JSX.Element {
    if (!onAskAi) return row;
    return (
      <Menu key={subjectId} openOnContext>
        <MenuTrigger disableButtonEnhancement>{row}</MenuTrigger>
        <MenuPopover>
          <AskAiMenuList
            subjectId={subjectId}
            reason={askAiReason?.(subjectId) ?? null}
            onAskAi={onAskAi}
          />
        </MenuPopover>
      </Menu>
    );
  }

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
                  return withMenu(
                    item.subjectId,
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
                    </div>,
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
