/**
 * ShelfStrip — the board's parked shelf (`settings.features.shelf`): a full-width,
 * foldable band below the columns holding cards parked "for later."
 *
 * A shelved card keeps whatever status it had; it is only taken out of `cardsByColumn`'s
 * bucketing (see `partitionShelved`) and drawn here instead, with `TaskCard`'s `shelved`
 * prop so it says nothing about a column it no longer has.
 *
 * The drop zone rides the same native HTML5 DnD every `KanbanColumn` already uses — the
 * dragged task id travels on `text/plain`, and `isChainLinkDrag` still has to be checked
 * first so drawing a chain arrow across the shelf is not read as dropping a card onto it.
 */
import { useState } from 'react';
import { Caption1, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { Person, Task } from '@tm/shared/model';
import type { StatusKeyword } from '@tm/shared/statusKeywords';
import type { BoardDisplaySettings } from '@tm/shared/settings';
import { TaskCard } from './TaskCard';
import type { BoardCard } from './boardColumns';
import { isChainLinkDrag } from './chainDrag';
import { useBoardLayoutStyles } from './boardLayout';

const useStyles = makeStyles({
  chevron: { display: 'flex', flexShrink: 0 },
});

export interface ShelfStripProps {
  /** The shelved cards, each carrying the steps that travel with it. */
  cards: BoardCard[];
  /** Whether the strip is collapsed to its header — `settings.shelfFolded`. */
  folded: boolean;
  onToggleFolded: () => void;
  projectNameOf: (task: Task) => string | undefined;
  agentNameOf: (task: Task) => string | undefined;
  projectColorOf: (task: Task) => string | undefined;
  epicNameOf?: (task: Task) => string | undefined;
  assigneeOf?: (task: Task) => Pick<Person, 'name' | 'initials' | 'color'> | undefined;
  showSprint?: boolean;
  statusKeywords?: readonly StatusKeyword[];
  attentionTaskIds?: ReadonlySet<string>;
  liveRunTaskIds?: ReadonlySet<string>;
  mergingTaskIds?: ReadonlySet<string>;
  display?: BoardDisplaySettings;
  selectedTaskId: string | null;
  draggingId: string | null;
  onStopTask?: (id: string) => void;
  onResumeTask?: (id: string) => void;
  onSelectTask: (id: string) => void;
  onDragStartTask: (id: string) => void;
  onDragEndTask: () => void;
  /** "Return to board", from a shelved card's own menu. */
  onToggleShelved: (id: string) => void;
  /** A card dropped onto the strip — always shelves it, whichever column it came from. */
  onDropOnShelf: (id: string) => void;
  /** `settings.features.afterMergePipeline` — passed straight through to each `TaskCard`. */
  afterMergePipeline?: boolean;
}

export function ShelfStrip(props: ShelfStripProps): JSX.Element {
  const layout = useBoardLayoutStyles();
  const styles = useStyles();
  const [over, setOver] = useState(false);

  return (
    <div
      className={mergeClasses(layout.shelf, over && layout.shelfOver)}
      onDragOver={(e) => {
        if (isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (isChainLinkDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('text/plain');
        if (id) props.onDropOnShelf(id);
      }}
    >
      <button
        type="button"
        className={layout.shelfHeader}
        onClick={props.onToggleFolded}
        aria-expanded={!props.folded}
        title={props.folded ? 'Expand the shelf' : 'Collapse the shelf'}
      >
        <span className={styles.chevron}>
          {props.folded ? <ChevronRightRegular /> : <ChevronDownRegular />}
        </span>
        <Text weight="semibold" size={200} className={layout.shelfHeaderLabel}>
          SHELF
        </Text>
        <Caption1 className={layout.shelfCount}>({props.cards.length})</Caption1>
      </button>
      {!props.folded && (
        <div className={layout.shelfList}>
          {props.cards.length === 0 ? (
            <Caption1 className={layout.shelfEmpty}>
              Nothing parked — drag a card here, or use its menu.
            </Caption1>
          ) : (
            props.cards.map(({ task, subtasks, mergeRequests }) => (
              <div key={task.id} className={layout.shelfCard}>
                <TaskCard
                  task={task}
                  projectName={props.projectNameOf(task)}
                  epicName={props.epicNameOf?.(task)}
                  assignee={props.assigneeOf?.(task)}
                  agentName={props.agentNameOf(task)}
                  projectColor={props.projectColorOf(task)}
                  showSprint={props.showSprint}
                  subtasks={subtasks}
                  mergeRequests={mergeRequests}
                  statusKeywords={props.statusKeywords}
                  attentionTaskIds={props.attentionTaskIds}
                  liveRunTaskIds={props.liveRunTaskIds}
                  mergingTaskIds={props.mergingTaskIds}
                  display={props.display}
                  selected={task.id === props.selectedTaskId}
                  selectedTaskId={props.selectedTaskId}
                  shelved
                  onToggleShelved={() => props.onToggleShelved(task.id)}
                  afterMergePipeline={props.afterMergePipeline}
                  onStop={props.onStopTask && (() => props.onStopTask?.(task.id))}
                  onResume={props.onResumeTask && (() => props.onResumeTask?.(task.id))}
                  draggable
                  dragging={task.id === props.draggingId}
                  onSelect={() => props.onSelectTask(task.id)}
                  onSelectSubtask={props.onSelectTask}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', task.id);
                    e.dataTransfer.effectAllowed = 'move';
                    props.onDragStartTask(task.id);
                  }}
                  onDragEnd={() => props.onDragEndTask()}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
