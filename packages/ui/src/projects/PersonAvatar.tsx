/**
 * A person's face, drawn the same way everywhere they appear — `PeopleSettings`' roster, and
 * the assignee/reporter pickers in `TicketDrawer`.
 *
 * `initials`/`color` are Fluent's own `Avatar` props, not a derivation this component makes:
 * `Person.initials` and `.color` are *stored*, precisely because two people can share a name
 * and only a human can say which gets which — see `seedInitials` (`@tm/shared/tickets`) for
 * where the seed comes from and why it stops being read the moment the row exists.
 */
import { Avatar } from '@fluentui/react-components';
import type { Person } from '@tm/shared/model';

export interface PersonAvatarProps {
  person: Pick<Person, 'name' | 'initials' | 'color'>;
  size?: 16 | 20 | 24 | 28 | 32;
}

export function PersonAvatar({ person, size = 24 }: PersonAvatarProps): JSX.Element {
  return (
    <Avatar
      name={person.name}
      initials={person.initials || undefined}
      size={size}
      color={person.color ? undefined : 'colorful'}
      style={person.color ? { backgroundColor: person.color, color: '#fff' } : undefined}
    />
  );
}
