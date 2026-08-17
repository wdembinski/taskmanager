/**
 * PeopleSettings — the app-wide roster a ticket's assignee/reporter pickers draw from
 * (Phase 24). Lives in `@tm/ui` and reaches the engine through `useTransport`, same as
 * `ProjectAdmin` — a person is nothing but a row in the shared store, reachable over the same
 * relayed channels either host can call, unlike `AgentProjects` (a folder on a machine,
 * desktop-only by decision).
 *
 * Wired as the `'people'` section in both `apps/client/src/renderer/src/Settings.tsx` and
 * `apps/web/src/settings/SettingsScreen.tsx` — app-wide, where a roster belongs, rather than
 * per ticket project the way labels and milestones are.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  OverlayDrawer,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { Person } from '@tm/shared/model';
import { seedInitials } from '@tm/shared/tickets';
import { ColorSwatches } from '../ColorSwatches';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { PersonAvatar } from './PersonAvatar';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  name: { display: 'flex', alignItems: 'center', gap: '6px' },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '360px' },
  row: { display: 'flex', gap: '12px' },
  cell: { flex: 1, minWidth: 0 },
});

export function PeopleSettings(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; person?: Person }>({ open: false });

  const seed = useCallback(
    async () => setPeople(await transport.invoke('person:list')),
    [transport],
  );
  const initial = useInitialLoad(seed);

  useEffect(() => transport.on('person:changed', setPeople), [transport]);

  async function remove(person: Person): Promise<void> {
    setError(null);
    try {
      await transport.invoke('person:remove', person.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setMe(person: Person): Promise<void> {
    setError(null);
    try {
      await transport.invoke('person:setMe', person.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (people === null) {
    return (
      <PaneLoading
        label="Loading people…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  return (
    <div className={styles.root}>
      <Text weight="semibold">People</Text>
      <Body1 className={styles.hint}>
        Everyone a ticket can be assigned to or reported by — shared across every project, since a
        person works across more than one.
      </Body1>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add person
        </Button>
      </div>

      {people.length === 0 ? (
        <Body1 className={styles.hint}>Nobody yet — add whoever tickets get assigned to.</Body1>
      ) : (
        <div className={styles.list}>
          {people.map((person) => (
            <Card key={person.id} className={styles.card}>
              <CardHeader
                image={<PersonAvatar person={person} size={32} />}
                header={
                  <div className={styles.name}>
                    <Text weight="semibold">{person.name}</Text>
                    {person.isMe && (
                      <Badge appearance="tint" color="brand">
                        You
                      </Badge>
                    )}
                  </div>
                }
                description={person.email || undefined}
                action={
                  <div className={styles.cardActions}>
                    {!person.isMe && (
                      <Button size="small" onClick={() => void setMe(person)}>
                        Set as me
                      </Button>
                    )}
                    <Button size="small" onClick={() => setDialog({ open: true, person })}>
                      Edit
                    </Button>
                    <Button size="small" onClick={() => void remove(person)}>
                      Remove
                    </Button>
                  </div>
                }
              />
            </Card>
          ))}
        </div>
      )}

      <PersonDialog
        open={dialog.open}
        person={dialog.person}
        onClose={() => setDialog({ open: false })}
      />
    </div>
  );
}

interface PersonDialogProps {
  open: boolean;
  /** The person being edited; absent means "add". */
  person?: Person;
  onClose: () => void;
}

function PersonDialog({ open, person, onClose }: PersonDialogProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [initials, setInitials] = useState('');
  const [color, setColor] = useState('');
  const [isMe, setIsMe] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form each time it opens — from the person when editing, blank when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(person?.name ?? '');
    setEmail(person?.email ?? '');
    setInitials(person?.initials ?? '');
    setColor(person?.color ?? '');
    setIsMe(person?.isMe ?? false);
  }, [open, person]);

  async function save(): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Give this person a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (person) {
        await transport.invoke('person:update', person.id, {
          name: trimmedName,
          email,
          initials: initials || seedInitials(trimmedName),
          color,
          isMe,
        });
      } else {
        await transport.invoke('person:add', {
          name: trimmedName,
          email,
          initials,
          color,
          isMe,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OverlayDrawer
      open={open}
      position="end"
      size="small"
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          {person ? 'Edit person' : 'Add person'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.form}>
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <Field label="Name" required>
            <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="Full name" />
          </Field>

          <div className={styles.row}>
            <Field label="Email" className={styles.cell} hint="Never used to send anything.">
              <Input
                value={email}
                onChange={(_e, d) => setEmail(d.value)}
                placeholder="name@example.com"
              />
            </Field>
            <Field
              label="Initials"
              className={styles.cell}
              hint="Seeded from the name; two people can share one, so edit it if they do."
            >
              <Input
                value={initials}
                onChange={(_e, d) => setInitials(d.value.slice(0, 3).toUpperCase())}
                placeholder={name ? seedInitials(name) : ''}
              />
            </Field>
          </div>

          <Field label="Avatar colour">
            <ColorSwatches value={color} onChange={setColor} allowNone />
          </Field>

          <Switch label="This is me" checked={isMe} onChange={(_e, d) => setIsMe(d.checked)} />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button appearance="primary" onClick={() => void save()} disabled={saving}>
          {person ? 'Save' : 'Add person'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
