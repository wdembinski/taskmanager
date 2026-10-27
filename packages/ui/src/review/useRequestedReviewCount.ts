/**
 * The sidebar Reviews row's count (F15.14b): how many rows wait in *Requested from me*. Reads
 * `review:queues` once — a cached answer, so it is cheap — then follows `review:queues:changed`.
 * A failed read (the web with its desktop offline) answers `undefined`, so the row draws without
 * a count rather than an error; the next `changed` push fills it in.
 */
import { useEffect, useState } from 'react';
import { useTransport } from '../transport';
import { requestedCount } from './reviewWorkspaceModel';

export function useRequestedReviewCount(): number | undefined {
  const transport = useTransport();
  const [count, setCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void transport.invoke('review:queues').then(
      (snapshot) => alive && setCount(requestedCount(snapshot)),
      () => alive && setCount(undefined),
    );
    const off = transport.on('review:queues:changed', (snapshot) =>
      setCount(requestedCount(snapshot)),
    );
    return () => {
      alive = false;
      off();
    };
  }, [transport]);

  return count;
}
