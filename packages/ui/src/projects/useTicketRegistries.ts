/**
 * The four app-wide registries a ticket points at — people, milestones, labels and the links
 * between tickets — loaded once and scoped to whichever project a screen is showing.
 *
 * Seeded in one `Promise.all`, not per project: `Projects.tsx` used to carry this same seed
 * and comment, and a project switch should not re-fetch the roster any more than a roster
 * edit should re-fetch every project's tickets. `people` and `links` are app-wide already
 * (a link can point across projects, same as `agentProjectId`); `milestones` and `labels`
 * are scoped here via `scopeTicketRegistries` so every screen narrows them the same way.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Milestone, Person, TicketLabel, TicketLink } from '@tm/shared/model';
import { pickableMilestones } from '@tm/shared/trackerArchive';
import { useTransport } from '../transport';
import { useInitialLoad, type InitialLoad } from '../useInitialLoad';
import {
  offeredMilestones as offeredMilestonesOf,
  scopeTicketRegistries,
} from './ticketRegistries';

export interface TicketRegistries extends Pick<InitialLoad, 'error' | 'retry'> {
  /** App-wide roster — never scoped, same as a ticket's `assigneeId`/`reporterId`. */
  people: Person[];
  /** This project's milestones, closed ones included — for display. */
  milestones: Milestone[];
  /** The milestone picker's own rule over this project's milestones — closed ones dropped
   *  ({@link offeredMilestones}) and archived ones dropped (`pickableMilestones`), both
   *  except the ticket's own current milestone — curried so a caller supplies only that id. */
  offeredMilestones: (currentId?: string | null) => Milestone[];
  /** This project's labels. */
  labels: TicketLabel[];
  /** App-wide ticket links — never scoped, since a link can point across projects. */
  links: TicketLink[];
  /** True once the seed has resolved at least once. */
  loaded: boolean;
}

export function useTicketRegistries(projectId: string | null): TicketRegistries {
  const transport = useTransport();
  const [people, setPeople] = useState<Person[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [loaded, setLoaded] = useState(false);

  const seed = useCallback(async () => {
    const [allPeople, allMilestones, allLabels, allLinks] = await Promise.all([
      transport.invoke('person:list'),
      transport.invoke('milestone:list'),
      transport.invoke('label:list'),
      transport.invoke('ticketLink:list'),
    ]);
    setPeople(allPeople);
    setMilestones(allMilestones);
    setLabels(allLabels);
    setLinks(allLinks);
    setLoaded(true);
  }, [transport]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offPeople = transport.on('person:changed', setPeople);
    const offMilestones = transport.on('milestone:changed', setMilestones);
    const offLabels = transport.on('label:changed', setLabels);
    const offLinks = transport.on('ticketLink:changed', setLinks);
    return () => {
      offPeople();
      offMilestones();
      offLabels();
      offLinks();
    };
  }, [transport]);

  const scoped = useMemo(
    () => scopeTicketRegistries(projectId, milestones, labels),
    [projectId, milestones, labels],
  );
  const offeredMilestones = useCallback(
    (currentId?: string | null) =>
      pickableMilestones(offeredMilestonesOf(scoped.milestones, currentId), currentId),
    [scoped.milestones],
  );

  return {
    people,
    milestones: scoped.milestones,
    offeredMilestones,
    labels: scoped.labels,
    links,
    loaded,
    error: initial.error,
    retry: initial.retry,
  };
}
