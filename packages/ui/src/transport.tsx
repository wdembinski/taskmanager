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
import type { TaskAttachment } from '@tm/shared/attachments';
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
   * attachment strip was simply broken there.
   *
   * Optional so a host that has not implemented it yet still satisfies `Transport`; callers
   * fall back to `@tm/shared/attachments`'s `attachmentUrl`, which is the Electron answer.
   *
   * `''` means "this host cannot serve these bytes", and is a real answer rather than a
   * failure: the strip shows the chip and skips the thumbnail. A host that pointed at a URL
   * it could not actually serve would look identical on screen and be a lie in the code.
   *
   * The whole ROW rather than an id, because whether a host can serve an attachment is a
   * question about that attachment and not just about the host: the cloud answers for the
   * ones whose bytes it currently holds (`cloudBlobAt`) and `''` for the rest, and only the
   * row knows which is which. Electron answers for all of them, and reads nothing but the id.
   */
  attachmentUrl?(attachment: TaskAttachment): string;
  /**
   * Attach files the user picked IN THIS CLIENT, as `File` objects.
   *
   * The desktop does not implement this, and that is the point. There, a picked file already
   * has a path — `attachment:pick` returns paths, a drop resolves through `pathForFile` — and
   * `attachment:add` takes paths precisely so a 30 MB recording never crosses a structured
   * clone to reach a process that could have read the file itself. A browser has neither the
   * path nor the disk, so its files have to travel as bytes over their own route.
   *
   * Absent, therefore, means "this host does the path flow", which is what
   * `AttachmentStrip` branches on: with no `attachFiles` it behaves exactly as it did before
   * this existed, down to the same two calls in the same order.
   *
   * Resolves to the whole attachment list, like `attachment:add`, so the strip can tell what
   * it just added by id and cite it. Rejects with a sentence to show when nothing landed.
   */
  attachFiles?(taskId: string, files: readonly File[]): Promise<TaskAttachment[]>;
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
