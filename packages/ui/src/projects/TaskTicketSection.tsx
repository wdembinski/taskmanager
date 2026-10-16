/**
 * The Ticket section of `TaskDetail`'s band — a native ticket's twelve fields
 * (`TicketFieldsSection`), folded behind a header that still names what's inside it
 * (`ticketSummaryLine`) when it is shut.
 *
 * Folded by default and remembered per DEVICE, not per card (`useDeviceFold`): a ticket's
 * fields are reference material you check, not something you are mid-edit on every time you
 * open a different card, so the fold should not re-ask on every single one.
 *
 * `addLink`: `TaskDetail` sets this when the Links section (`TaskLinksSection`) has nothing
 * to show — a native ticket with no ticket links and no chain links otherwise has no way to
 * draw its first link at all, since that add row normally lives at the bottom of the Links
 * section itself.
 */
import { Caption1, Text, makeStyles } from '@fluentui/react-components';
import type { Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import { FoldToggle } from '../FoldToggle';
import { useDeviceFold } from './deviceFold';
import { ticketSummaryLine } from './ticketSummary';
import { TicketFieldsSection } from './TicketFieldsSection';
import { TicketLinkAddRow, type LinkCandidate } from './TicketLinksEditor';

const useStyles = makeStyles({
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  linksBox: { display: 'flex', flexDirection: 'column', gap: '6px' },
});

export interface TaskTicketSectionProps {
  ticket: Task;
  /** This project's other tickets — epic candidates. */
  tickets: Task[];
  /** App-wide roster, for the assignee/reporter pickers. */
  people: Person[];
  /** The repos a ticket can be delegated to — the read-only agent indicator. */
  agentProjects: Project[];
  /** This project's label registry. */
  labels: TicketLabel[];
  /** This project's milestones. */
  milestones: Milestone[];
  /** Set when the Links section is absent — candidates for this ticket's first link. */
  addLink?: { candidates: LinkCandidate[] };
  /** Set when the host relaying ticket writes is unreachable — every field and the add-link
   *  row below are disabled, the manager popovers hidden, but the fold still reads. */
  readOnly?: boolean;
}

export function TaskTicketSection({
  ticket,
  tickets,
  people,
  agentProjects,
  labels,
  milestones,
  addLink,
  readOnly = false,
}: TaskTicketSectionProps): JSX.Element {
  const styles = useStyles();
  const [open, toggle] = useDeviceFold('tm.taskDetail.ticketOpen', false);

  return (
    <div className={styles.box}>
      <FoldToggle open={open} onToggle={toggle} summary={ticketSummaryLine(ticket, { milestones })}>
        <Text weight="semibold">Ticket</Text>
      </FoldToggle>
      {open && (
        <TicketFieldsSection
          ticket={ticket}
          tickets={tickets}
          people={people}
          agentProjects={agentProjects}
          labels={labels}
          milestones={milestones}
          readOnly={readOnly}
        />
      )}
      {open && addLink && (
        <div className={styles.linksBox}>
          <Caption1>Links</Caption1>
          <TicketLinkAddRow ticket={ticket} candidates={addLink.candidates} disabled={readOnly} />
        </div>
      )}
    </div>
  );
}
