/**
 * Which desktop this tab is driving, in the status bar — a label until a second Client
 * shows up, and a menu the moment one does.
 *
 * Only the label when there is one Client, because a picker with a single option is a
 * control that cannot do anything: it takes a click to tell you what the line already said.
 * The common case (one machine, one browser) therefore looks exactly as it did before this
 * existed, and the choice appears only for the human who actually has a choice to make.
 *
 * Not shared into `@tm/ui`: the desktop app IS a Client and never picks one.
 */
import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import type { ClientPresence } from '@tm/protocol/wire';
import { describeClient, describeClientDetail } from './targetClient';

export interface ClientPickerProps {
  /** The live Clients, most recently seen first — `BoardResponse.clients`. */
  clients: readonly ClientPresence[];
  /** The one commands are going to now, which is always one of `clients` when it is live. */
  selected: ClientPresence;
  onSelect: (clientId: string) => void;
  /** The status bar's own link styling — the bar owns its fill, so this can't be set here. */
  className: string;
}

export function ClientPicker({
  clients,
  selected,
  onSelect,
  className,
}: ClientPickerProps): JSX.Element {
  const label = `Driving ${describeClient(selected)}`;

  if (clients.length < 2) {
    return <span title={describeClientDetail(selected)}>{label}</span>;
  }

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        {/* A plain button rather than a Fluent one: this sits on the status bar's saturated
            fill, where a Button brings its own background and border and reads as a chip
            dropped into a coloured strip. Same treatment as Sign out beside it. */}
        <button type="button" className={className} title={describeClientDetail(selected)}>
          {label} ▾
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList
          checkedValues={{ client: [selected.id] }}
          onCheckedValueChange={(_e, { checkedItems }) => {
            // Radio semantics: the newly checked item is the one that is not already
            // selected. Ignoring a re-click of the current target keeps this from writing a
            // preference nobody changed.
            const next = checkedItems.find((id) => id !== selected.id);
            if (next) onSelect(next);
          }}
        >
          {clients.map((client) => (
            <MenuItemRadio key={client.id} name="client" value={client.id}>
              {describeClientDetail(client)}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
