/**
 * ProjectAdmin — the ticket-project list, and the drawer that adds or edits one.
 *
 * The same two-part shape as the desktop's `AgentProjects` pane (a `Card` per row, an
 * `OverlayDrawer` form), because that pane already worked out what "list projects, edit one
 * in a drawer" should look like in this app. What is deliberately absent is everything about
 * a REPO: no folder field, no `BaseBranchField`, no "Runs on" target picker. A ticket project
 * (`Project.kind === 'ticket'`) has no directory at all — `path` and `planPath` are forced to
 * `''` by the store regardless of what is sent — so a form offering to browse for one would be
 * offering a choice that does nothing.
 *
 * Lives in `packages/ui` because both hosts manage ticket projects the same way: unlike an
 * agent project (a folder on a machine, desktop-only by decision — see `shell-parity.test.ts`),
 * a ticket project is nothing but rows in the shared store, reachable over the same relayed
 * channels either host can call.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
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
  Text,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { Project } from '@tm/shared/model';
import { ColorSwatches } from '../ColorSwatches';
import { useTransport } from '../transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px', cursor: 'pointer' },
  cardSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  prefix: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '380px' },
});

export interface ProjectAdminProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectAdmin({
  projects,
  selectedProjectId,
  onSelect,
}: ProjectAdminProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await transport.invoke('ticketProject:remove', project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Body1 className={styles.hint}>
          No ticket projects yet — add one to start filing tickets this app tracks itself.
        </Body1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => (
            <Card
              key={project.id}
              className={
                project.id === selectedProjectId
                  ? `${styles.card} ${styles.cardSelected}`
                  : styles.card
              }
              onClick={() => onSelect(project.id)}
              selected={project.id === selectedProjectId}
            >
              <CardHeader
                header={
                  <div className={styles.headerText}>
                    <div className={styles.nameRow}>
                      {project.color && (
                        <span
                          className={styles.colorDot}
                          style={{ backgroundColor: project.color }}
                          title={`Board colour ${project.color}`}
                        />
                      )}
                      <Text weight="semibold">{project.name}</Text>
                      {project.ticketPrefix && (
                        <Badge appearance="tint" color="informative" className={styles.prefix}>
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                  </div>
                }
                action={
                  <div className={styles.cardActions}>
                    <Button
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ open: true, project });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(project);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                }
              />
            </Card>
          ))}
        </div>
      )}

      <ProjectDialog
        open={dialog.open}
        project={dialog.project}
        onClose={() => setDialog({ open: false })}
        onSaved={(id) => onSelect(id)}
      />
    </div>
  );
}

interface ProjectDialogProps {
  open: boolean;
  /** The project being edited; absent means "add". */
  project?: Project;
  onClose: () => void;
  /** The saved project's id — so the caller can select it straight away. */
  onSaved: (id: string) => void;
}

/** Add / edit form — name, key prefix and board colour. Nothing about a repo: see the file
 *  header for why. */
function ProjectDialog({ open, project, onClose, onSaved }: ProjectDialogProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [name, setName] = useState('');
  const [ticketPrefix, setTicketPrefix] = useState('');
  const [color, setColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form each time it opens — from the project when editing, blank when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(project?.name ?? '');
    setTicketPrefix(project?.ticketPrefix ?? '');
    setColor(project?.color ?? '');
  }, [open, project]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (project) {
        const updated = await transport.invoke('ticketProject:update', project.id, {
          name: name.trim() || undefined,
          ticketPrefix,
          color,
        });
        if (!updated) throw new Error('That project no longer exists.');
        onSaved(updated.id);
      } else {
        const created = await transport.invoke('ticketProject:add', {
          // A ticket project has no folder — the store forces `path`/`planPath` to `''`
          // regardless of what is sent, but `AddProjectInput.path` is still required to type.
          path: '',
          name: name.trim() || undefined,
          kind: 'ticket',
          ticketPrefix,
          color,
        });
        onSaved(created.id);
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
      size="medium"
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
          {project ? 'Edit project' : 'Add project'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.form}>
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <Field label="Name" required hint="Defaults to the key prefix.">
            <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="Project name" />
          </Field>

          <Field
            label="Key prefix"
            hint="Tickets are numbered under this — TM-1, TM-2, … Renaming it re-keys every ticket the project owns."
          >
            <Input
              className={styles.prefix}
              value={ticketPrefix}
              onChange={(_e, d) => setTicketPrefix(d.value)}
              placeholder="TM"
            />
          </Field>

          <Field
            label="Colour"
            hint="A card tagged with this project wears a stripe of this colour, so a mixed column says which project each card is about."
          >
            <ColorSwatches value={color} onChange={setColor} allowNone />
          </Field>

          <Caption1 className={styles.hint}>
            A ticket project has no repository — it is a key prefix and the tickets it owns, tracked
            by this app itself.
          </Caption1>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button appearance="primary" onClick={() => void save()} disabled={saving}>
          {project ? 'Save' : 'Add project'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
