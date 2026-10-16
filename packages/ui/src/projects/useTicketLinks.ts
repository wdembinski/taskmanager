/**
 * This ticket's own copy of `ticketLink:list` — unless a caller already holds one.
 *
 * `TaskDetail`'s Links section needs to work on today's board, where nothing upstream of it
 * loads ticket links yet. Passing `provided` (a `useTicketRegistries().links`, once F12.6
 * wires it through) skips the fetch entirely and this hook becomes the identity function;
 * until then, it loads and subscribes itself, the same way `TicketLinksEditor` always has.
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
