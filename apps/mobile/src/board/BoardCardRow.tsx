/**
 * One card in the mobile board's list: `@tm/ui`'s `TaskCard`, unchanged, with a "Move to…"
 * menu underneath it instead of the drag handle a mouse would use.
 *
 * `TaskCard` needs no changes to fit a phone — its `card` rule declares no width at all and
 * every chip inside it is `maxWidth: 100%`/`minWidth: 0` — so the one thing this file adds is
 * the way you move a card without a mouse to drag it with. `draggable`/`dragging`/
 * `onDragStart`/`onDragEnd` are simply never passed: they are optional on `TaskCard` now
 * (the same pattern `TaskDetail`'s `readOnlyNotice` set — an absent prop as the host
 * difference), so this card is never draggable and the four props needed no stand-in no-ops.
 *
 * The menu sits BELOW the card rather than floating over a corner of it: a card is already
 * carrying a project notch, an attention ring and (while a link gesture existed) a handle in
 * that corner on the desktop, and a control you can actually tap without missing wants a real
 * row of its own rather than a few pixels borrowed from the card underneath it.
 */
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, makeStyles } from '@fluentui/react-components';
import { ArrowRoutingRegular } from '@fluentui/react-icons';
import type { BoardColumn } from '@tm/shared/model';
import { COLUMN_META } from '@tm/ui/board/boardColumns';
import { TaskCard, type TaskCardProps } from '@tm/ui/board/TaskCard';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '2px' },
  moveButton: { alignSelf: 'flex-start', minHeight: '32px' },
});

/** The four drag props this card never has a use for — see the header above. */
type NoDragTaskCardProps = Omit<TaskCardProps, 'draggable' | 'dragging' | 'onDragStart' | 'onDragEnd'>;

export interface BoardCardRowProps extends NoDragTaskCardProps {
  /** The column this card is actually in — left out of the menu, since moving there is a no-op. */
  column: BoardColumn;
  /** The columns the menu may offer, in order — `visibleColumns(showDone)`'s own answer, so a
   *  card is never moved somewhere the board isn't currently showing. */
  moveTargets: readonly BoardColumn[];
  onMove: (column: BoardColumn) => void;
}

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

export function BoardCardRow({
  column,
  moveTargets,
  onMove,
  ...cardProps
}: BoardCardRowProps): JSX.Element {
  const styles = useStyles();
  const targets = moveTargets.filter((c) => c !== column);
  return (
    <div className={styles.wrap}>
      <TaskCard {...cardProps} />
      {targets.length > 0 && (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              className={styles.moveButton}
              size="small"
              appearance="subtle"
              icon={<ArrowRoutingRegular />}
            >
              Move to…
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {targets.map((target) => (
                <MenuItem key={target} onClick={() => onMove(target)}>
                  {COLUMN_LABEL[target]}
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
    </div>
  );
}
