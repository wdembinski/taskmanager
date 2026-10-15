/**
 * Which host a gate's trust prompt is actually asking on (F8.13).
 *
 * A gate's "Trust and run" button only means something on the desktop that would run the
 * command — the web has no machine of its own behind it, only the desktop it is relaying
 * through. `AttentionItem`/`GateStepViewInput` cannot say this themselves; it is a fact
 * about the HOST rendering the row, not about the step. A context carries it instead of a
 * prop because the components that need it — `Attention`/`CompactInbox`'s `InboxItem`, and
 * `TaskSteps`'s `GateRow` four levels under `TaskDetail` — take no such prop today, and
 * threading one through every intermediate layer just for this would touch far more files
 * than the fact itself is worth.
 *
 * The default, `{ canTrust: true, name: null }`, is the desktop's own answer — it IS the
 * machine a gate command runs on, so it needs no provider at all; only the web wraps its
 * tree in one (`apps/web/src/App.tsx`).
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface GateTrustHost {
  /** Whether trusting a gate command can be done from HERE. */
  canTrust: boolean;
  /** What to call the desktop the command would actually run on, or null when unknown. */
  name: string | null;
}

const DEFAULT_GATE_TRUST_HOST: GateTrustHost = { canTrust: true, name: null };

const GateTrustHostContext = createContext<GateTrustHost>(DEFAULT_GATE_TRUST_HOST);

export function GateTrustHostProvider({
  value,
  children,
}: {
  value: GateTrustHost;
  children: ReactNode;
}): JSX.Element {
  return <GateTrustHostContext.Provider value={value}>{children}</GateTrustHostContext.Provider>;
}

export function useGateTrustHost(): GateTrustHost {
  return useContext(GateTrustHostContext);
}
