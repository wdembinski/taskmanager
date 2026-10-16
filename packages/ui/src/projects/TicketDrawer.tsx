/**
 * TicketDrawer — the one place every field of a native ticket has to be edited (Phase 24).
 *
 * Title, description and priority are deliberately absent: they go through the channels
 * every other card already uses (`task:setDescription`, `task:setPriority`), same as
 * `TicketPatch`'s own doc comment says. The twelve ticket-only fields, the two registries a
 * ticket draws from (labels, milestones) and the delegated-agent indicator live in
 * `TicketFieldsSection` (F12.1), which this drawer renders until F12.8 retires it in favour
 * of `TaskDetail`'s own panel. The relationships a ticket can have to other tickets stay
 * here rather than in three separate screens, because a label or milestone only ever needs
 * editing from the ticket that is about to wear it.
 *
 * `ticket`/`onClose` make this a controlled drawer: the caller (`BacklogTable`) owns which
 * ticket is selected, and passes the live row straight through — every field in
 * `TicketFieldsSection` saves itself the moment it changes, and the resulting
 * `project:tasksChanged` broadcast updates the caller's list, which flows back down as a new
 * `ticket` prop, with no callback needed here.
 */
import {
  Button,
  Divider,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import { TicketFieldsSection } from './TicketFieldsSection';
import { TicketLinksEditor } from './TicketLinksEditor';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  key: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
});

export interface TicketDrawerProps {
  /** The ticket being edited; `null` means the drawer is closed. */
  ticket: Task | null;
  /** This project's other tickets — epic candidates and ticket-link candidates. */
  tickets: Task[];
  /** App-wide roster, for the assignee/reporter pickers. */
  people: Person[];
  /** The repos a ticket can be delegated to — resolves `ticket.agentProjectId` to a name
   *  for the read-only agent indicator beside the (still human-editable) Assignee field. */
  agentProjects: Project[];
  /** This project's label registry. */
  labels: TicketLabel[];
  /** This project's milestones. */
  milestones: Milestone[];
  onClose: () => void;
}

export function TicketDrawer({
  ticket,
  tickets,
  people,
  agentProjects,
  labels,
  milestones,
  onClose,
}: TicketDrawerProps): JSX.Element {
  const styles = useStyles();

  const otherTickets = tickets.filter((t) => t.id !== ticket?.id);

  return (
    <OverlayDrawer
      open={ticket !== null}
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
          {ticket && (
            <>
              {ticket.ticketKey && <span className={styles.key}>{ticket.ticketKey}</span>}{' '}
              {ticket.title}
            </>
          )}
        </DrawerHeaderTitle>
      </DrawerHeader>
      {ticket && (
        <>
          <DrawerBody>
            <div className={styles.form}>
              <TicketFieldsSection
                ticket={ticket}
                tickets={tickets}
                people={people}
                agentProjects={agentProjects}
                labels={labels}
                milestones={milestones}
              />

              <Divider />

              <Subtitle2>Linked tickets</Subtitle2>
              <TicketLinksEditor ticket={ticket} candidates={otherTickets} />
            </div>
          </DrawerBody>
          <DrawerFooter>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DrawerFooter>
        </>
      )}
    </OverlayDrawer>
  );
}
