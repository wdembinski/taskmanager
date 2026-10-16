/**
 * This ticket's own copy of `ticketLink:list` — unless a caller already holds one.
 *
 * Both boards now pass `provided` (a `useTicketRegistries().links`, wired through by
 * F12.6), which skips the fetch entirely and makes this hook the identity function. It
 * is still the fallback for every other host — Projects, until F12.7 wires it through
 * too — which loads and subscribes itself, the same way `TicketLinksEditor` always has.
 */
import { useEffect, useState } from 'react';
import type { TicketLink } from '@tm/shared/model';
import { useTransport } from '../transport';

export function useTicketLinks(provided?: readonly TicketLink[]): readonly TicketLink[] {
  const transport = useTransport();
  const [loaded, setLoaded] = useState<TicketLink[]>([]);
  const selfLoad = provided === undefined;

  useEffect(() => {
    if (!selfLoad) return;
    let live = true;
    void transport.invoke('ticketLink:list').then((all) => {
      if (live) setLoaded(all);
    });
    const off = transport.on('ticketLink:changed', setLoaded);
    return () => {
      live = false;
      off();
    };
  }, [transport, selfLoad]);

  return provided ?? loaded;
}
