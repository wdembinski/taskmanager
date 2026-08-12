/**
 * The one door this package uses to reach an engine.
 *
 * Everything under board/, chat/ and TaskDetail's own tree used to call `window.api`
 * directly — the preload bridge apps/client's Electron main process exposes. That is
 * fine for apps/client, but this package is also apps/web's board and detail pane, and a
 * browser tab has no `window.api`: it has to reach the same channels over HTTP.
 *
 * `Transport` is the preload bridge's own shape (`PreloadApi`, `apps/client/src/preload/
 * index.ts`) — invoke/on/pathForFile, typed against `@tm/shared`'s `IpcApi`/`IpcEvents` —
 * copied here as an interface rather than imported, because importing the preload module
 * itself would pull `electron` into a package apps/web also depends on. `window.api`
 * already satisfies this structurally, so apps/client's provider is just
 * `<TransportProvider transport={window.api}>`; apps/web's is an HTTP client with the
 * same three methods.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { IpcApi, IpcEvents } from '@tm/shared/ipc';

export interface Transport {
  /** Request/response call to whatever is on the other end of this channel name. */
  invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>): ReturnType<IpcApi[K]>;
  /** Subscribe to a pushed event; returns an unsubscribe function. */
  on<K extends keyof IpcEvents>(channel: K, callback: (payload: IpcEvents[K]) => void): () => void;
  /**
   * The absolute path of a file the user dropped on the window, or `''` when the host
   * cannot answer that (there is no such thing as a "path" for a file picked in a browser).
   */
  pathForFile(file: File): string;
  /**
   * Where to fetch an attachment's bytes from — a host fact, because the two hosts store
   * them in completely different places.
   *
   * Electron answers `vipper-attachment://a/<id>`, a custom scheme registered by the main
   * process (`ipc.ts`) so a locked-down window can show an image it is never told the path
   * of. That scheme does not exist in a browser, so every `<img src>` in the shared
   * attachment strip was simply broken there; the web answers an HTTP download URL instead.
   *
   * Optional so a host that has not implemented it yet still satisfies `Transport`; callers
   * fall back to `@tm/shared/attachments`'s `attachmentUrl`, which is the Electron answer.
   */
  attachmentUrl?(id: string): string;
}

const TransportContext = createContext<Transport | null>(null);

export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}): JSX.Element {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

/** Every component under board/, chat/ and TaskDetail reaches the engine through this. */
export function useTransport(): Transport {
  const transport = useContext(TransportContext);
  if (!transport) throw new Error('useTransport() called outside a <TransportProvider>');
  return transport;
}
