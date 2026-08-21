/**
 * The ticket every `<img src>` in this tab carries — `?mt=`, minted by
 * `POST /v1/media-tokens` and good for one account's attachment bytes for ten minutes.
 *
 * WHY A HOLDER AND NOT AN `await`
 * -------------------------------
 * `Transport.attachmentUrl` is synchronous, because its caller is JSX: the shared
 * `AttachmentStrip` writes `<img src={…}>` while rendering, and there is no point in a render
 * pass at which a promise could be waited for. So the token cannot be fetched when it is
 * needed — it has to be there already, which is what this is: a cached string, refreshed
 * ahead of its own expiry, that `attachmentUrl` reads with no round trip.
 *
 * Until the first mint lands there is no token, and the honest answer is `''` — which the
 * strip reads as "no preview here" and renders the chip alone. That is a real state and not a
 * loading spinner's worth of one: it lasts one request. {@link MediaTokenHolder.onChange} is
 * how the tab stops sitting in it — `useCloudBoard` re-renders when a token arrives, so the
 * thumbnails appear rather than waiting for whatever else would next have re-rendered them.
 *
 * WHAT IT IS WORTH, AND WHY THAT MATTERS HERE
 * -------------------------------------------
 * A media token authorises `GET /v1/attachments/:id` for one account and nothing else, for
 * ten minutes (`apps/server/src/attachments/mediaTokens.ts`). It is in a URL because an
 * `<img>` sets no headers — and a URL is exactly the place a secret leaks from: a referrer, a
 * copied link, a screenshot of a devtools network tab. Which is the whole argument for it
 * being narrow and short-lived rather than the bearer token, and the reason this file mints a
 * fresh one instead of caching one anywhere it would outlive the tab.
 */
import type { MediaTokenGrant } from '@tm/protocol/wire';

/**
 * How long before expiry a token is treated as spent.
 *
 * A minute, against a ten-minute life: long enough that an image request cannot lose a race
 * with its own token, short enough that this is not effectively re-minting every time.
 */
const REFRESH_MARGIN_MS = 60_000;

/** How long to wait before trying again after a failed mint, so a dead network is not hammered. */
const RETRY_AFTER_MS = 30_000;

export interface MediaTokenHolderDeps {
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  /** Called once each time a token arrives — `useCloudBoard` turns it into a re-render. */
  onChange?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class MediaTokenHolder {
  private grant: MediaTokenGrant | null = null;
  private minting: Promise<void> | null = null;
  private retryAfter = 0;
  private disposed = false;

  constructor(private readonly deps: MediaTokenHolderDeps) {}

  /**
   * The token to put in a URL right now, or null when there is not one yet.
   *
   * Reading it is what keeps it fresh: a call with nothing cached (or with something about to
   * expire) starts a mint and returns what it has, which is the only shape a synchronous
   * accessor can have. Nothing is minted for a tab that never renders a thumbnail.
   */
  current(): string | null {
    const now = this.clock();
    if (!this.grant || this.grant.expiresAt - REFRESH_MARGIN_MS <= now) {
      void this.mint();
    }
    if (!this.grant || this.grant.expiresAt <= now) return null;
    return this.grant.token;
  }

  dispose(): void {
    this.disposed = true;
    this.grant = null;
  }

  /** One mint at a time — a board full of thumbnails asks on the same render. */
  private mint(): Promise<void> {
    if (this.disposed || this.minting) return this.minting ?? Promise.resolve();
    if (this.clock() < this.retryAfter) return Promise.resolve();

    this.minting = this.request()
      .then((grant) => {
        if (this.disposed) return;
        this.grant = grant;
        this.retryAfter = 0;
        this.deps.onChange?.();
      })
      .catch((e: unknown) => {
        // Not thrown onward: the caller is a render, and every consequence of failing is
        // already visible as a missing thumbnail. The next read tries again after the pause.
        this.retryAfter = this.clock() + RETRY_AFTER_MS;
        console.warn('media token mint failed', e);
      })
      .finally(() => {
        this.minting = null;
      });
    return this.minting;
  }

  private async request(): Promise<MediaTokenGrant> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.apiBase}/v1/media-tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`media token failed (${res.status} ${res.statusText})`);
    const grant = (await res.json()) as MediaTokenGrant;
    if (!grant?.token) throw new Error('the server answered without a token');
    return grant;
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
