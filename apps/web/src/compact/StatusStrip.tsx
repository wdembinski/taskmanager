/**
 * The compact shell's `strip` slot (F3.2) — one line, replacing the wide layout's status bar
 * plus its up-to-three banners with a single summary, since a phone has no room to stack
 * them.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **`connection` wins outright when it is non-null.** It is the result of
 *   `worstConnectionState` (`../board/connectionState.ts`) already applied to this tab's
 *   three inputs; rendering it is just `connectionStripText(connection)` — its `text` with
 *   its `intent` colouring the line (error/warning, the same two intents the wide banners
 *   use).
 * - **The calm state — `connection === null` — reuses `StatusDot`** from
 *   `@tm/ui/shell/StatusBar` (ok = a live target Client) followed by `describeClient(client)`
 *   and the caller's precomputed `syncLabel` (`syncStatusLabel`'s own string, from
 *   `syncGate.ts`) — the exact three things the wide status bar already shows for "everything
 *   is fine", condensed onto one line instead of spread across several `Caption1`s.
 * - **No relayed read anywhere in this component** — every prop here is something
 *   `SignedInBoard`/`CompactApp` already computed for the wide layout; see `CompactApp.tsx`'s
 *   own header for why that invariant matters.
 * - **Overflow is an ellipsis, not a wrap.** The strip is one line by construction
 *   (`CompactShell`'s slot). The full text is repeated in an `aria-label` on the line's
 *   container so it is still available to a screen reader or on tap-and-hold; a tap-to-expand
 *   interaction is explicitly out of scope for v1.
 */
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import type { ClientPresence } from '@tm/protocol/wire';
import { StatusDot } from '@tm/ui/shell/StatusBar';
import { connectionStripText, type ConnectionState } from '../board/connectionState';
import { describeClient } from '../board/targetClient';

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    flexShrink: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  text: { overflow: 'hidden', textOverflow: 'ellipsis' },
  error: { color: tokens.colorStatusDangerForeground1 },
  warning: { color: tokens.colorStatusWarningForeground1 },
});

export interface StatusStripProps {
  /** `worstConnectionState`'s verdict, or `null` for the calm state. See the module header. */
  connection: ConnectionState | null;
  /** The desktop Client this tab is driving, for the calm state's `describeClient` — `null`
   *  when none has ever synced. */
  client: ClientPresence | null;
  /** `syncStatusLabel`'s precomputed string — the calm state's "synced Ns ago" / "syncing…". */
  syncLabel: string;
}

export function StatusStrip({ connection, client, syncLabel }: StatusStripProps): JSX.Element {
  const styles = useStyles();

  if (connection) {
    const { intent, text } = connectionStripText(connection);
    return (
      <div className={styles.strip} aria-label={text}>
        <Caption1
          className={`${styles.text} ${intent === 'error' ? styles.error : styles.warning}`}
        >
          {text}
        </Caption1>
      </div>
    );
  }

  const text = `${client ? describeClient(client) : 'No desktop app'} · ${syncLabel}`;
  return (
    <div className={styles.strip} aria-label={text}>
      <StatusDot ok={client !== null} />
      <Caption1 className={styles.text}>{text}</Caption1>
    </div>
  );
}
