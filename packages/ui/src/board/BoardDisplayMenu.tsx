/**
 * The board toolbar's **Display** menu: which of a card's optional lines it draws.
 *
 * Switchable here as well as in the desktop's Settings page, because this is where you
 * actually notice the noise — a trip to Settings to quiet a board you are looking at is a
 * trip most people won't make.
 *
 * Nothing in it talks to a host: it takes the current {@link BoardDisplaySettings} and hands
 * back the next one, and each host stores that wherever it keeps preferences (the desktop's
 * settings blob, the browser's `localStorage`). That is the whole reason it could move here
 * unchanged — it was already the one piece of the toolbar with no IPC in it.
 */
import {
  Button,
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { EyeRegular } from '@fluentui/react-icons';
import type { BoardDisplaySettings } from '@tm/shared/settings';

export interface BoardDisplayMenuProps {
  display: BoardDisplaySettings;
  onChange: (next: BoardDisplaySettings) => void;
  /**
   * Off while the settings behind the menu have not arrived — the items would otherwise be
   * checked against a default the host is about to replace, and toggling one would save that
   * default over whatever is on disk.
   */
  disabled?: boolean;
}

export function BoardDisplayMenu({
  display,
  onChange,
  disabled,
}: BoardDisplayMenuProps): JSX.Element {
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<EyeRegular />}>
          Display
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList
          checkedValues={{
            display: [
              ...(display.showLabels ? ['labels'] : []),
              ...(display.showProjectName ? ['project'] : []),
              ...(display.showEpicName ? ['epic'] : []),
              ...(display.showAssignee ? ['assignee'] : []),
              ...(display.showPoints ? ['points'] : []),
            ],
          }}
          onCheckedValueChange={(_e, { checkedItems }) =>
            onChange({
              ...display,
              showLabels: checkedItems.includes('labels'),
              showProjectName: checkedItems.includes('project'),
              showEpicName: checkedItems.includes('epic'),
              showAssignee: checkedItems.includes('assignee'),
              showPoints: checkedItems.includes('points'),
            })
          }
        >
          <MenuItemCheckbox name="display" value="labels" disabled={disabled}>
            JIRA labels
          </MenuItemCheckbox>
          <MenuItemCheckbox name="display" value="project" disabled={disabled}>
            Project name
          </MenuItemCheckbox>
          <MenuItemCheckbox name="display" value="epic" disabled={disabled}>
            Epic
          </MenuItemCheckbox>
          <MenuItemCheckbox name="display" value="assignee" disabled={disabled}>
            Assignee
          </MenuItemCheckbox>
          <MenuItemCheckbox name="display" value="points" disabled={disabled}>
            Story points
          </MenuItemCheckbox>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
