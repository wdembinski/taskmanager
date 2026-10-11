import { useEffect, useRef, useState } from 'react';
import { makeStyles } from '@fluentui/react-components';
import type { ClientPresence } from '@tm/protocol/wire';
import type { Automation } from '@tm/shared/automation';
import { AutomationsView } from '@tm/ui/automations/AutomationsView';
import { useTransport } from '@tm/ui/transport';
import { OwnerDesktopBanner } from './OwnerDesktopBanner';
import {
  mergeLastSeen,
  ownerDesktopState,
  ownerDisplayName,
  type RememberedClient,
} from './ownerDesktop';

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: 0 },
  banners: { display: 'flex', flexDirection: 'column', gap: '8px' },
  body: { flex: 1, minHeight: 0 },
});

/**
 * The web's Automations tab: the same `AutomationsView` the desktop renders (F1.17's whole
 * parity point), fronted by a banner per distinct desktop that owns one of this account's
 * automations — see `OwnerDesktopBanner`'s own docstring for why that matters here and not
 * on the desktop, which only ever owns its own.
 *
 * Fetches `automation:list` itself, alongside `AutomationsView`'s own identical fetch. The
 * duplicate read is deliberate rather than threaded through a prop: it is the same cheap,
 * mirrored GET `httpTransport.ts` already serves with no desktop Client involved, and
 * keeping the banner's data independent means a change to `AutomationsView`'s internals
 * can never silently break the banner above it.
 */
export function AutomationsScreen({
  clients,
  now,
  onOpenTask,
}: {
  /** The account's live desktop Clients, as of the last board poll — `board.state.clients`. */
  clients: readonly ClientPresence[];
  now: number;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [owners, setOwners] = useState<readonly string[]>([]);
  const rememberedRef = useRef<ReadonlyMap<string, RememberedClient>>(new Map());
  const [, forceRender] = useState(0);

  useEffect(() => {
    let live = true;
    const applyOwners = (automations: readonly Automation[]): void => {
      if (!live) return;
      const distinct = [
        ...new Set(automations.map((a) => a.ownerClientId).filter((id) => id !== null)),
      ];
      setOwners(distinct);
    };
    void transport
      .invoke('automation:list')
      .then(applyOwners)
      .catch(() => undefined);
    const off = transport.on('automations:changed', applyOwners);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  // Remembered in a ref rather than state: `clients` arrives on every board poll (every
  // couple of seconds), and only the MAP's identity needs to survive renders — forcing one
  // on every tick this hook merges nothing new into would just be churn, same reasoning as
  // `useCloudBoard.ts`'s own target-client ref.
  useEffect(() => {
    const next = mergeLastSeen(rememberedRef.current, clients);
    if (next !== rememberedRef.current) {
      rememberedRef.current = next;
      forceRender((n) => n + 1);
    }
  }, [clients]);

  return (
    <div className={styles.pane}>
      <div className={styles.banners}>
        {owners.map((ownerClientId) => {
          const remembered = rememberedRef.current.get(ownerClientId) ?? null;
          const state = ownerDesktopState({ lastSeen: remembered?.lastSeen ?? null, now });
          return (
            <OwnerDesktopBanner
              key={ownerClientId}
              name={ownerDisplayName(ownerClientId, rememberedRef.current)}
              state={state}
              lastSeen={remembered?.lastSeen ?? null}
              now={now}
            />
          );
        })}
      </div>
      <div className={styles.body}>
        <AutomationsView onOpenTask={onOpenTask} />
      </div>
    </div>
  );
}
