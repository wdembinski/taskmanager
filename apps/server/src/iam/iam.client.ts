/**
 * A small stand-in for `@vipper/iam-connector` (see docs/plan/README.md's "Risks and open
 * assumptions" and the root `.npmrc`): `npm.vipper.network` resolves but 401s without a
 * registry token this repo has no way to obtain, so `pnpm add @vipper/iam-connector` cannot
 * complete here. The connector is itself dependency-free by its own README ("No NestJS, no
 * React, no server dependencies — just native `fetch`"), so this hits the same two documented
 * endpoints directly:
 *
 * - `POST ${apiBase}/authorize` — bearer allow/deny, keyed by `resourceType`/`identifier`/`action`.
 * - `POST ${apiBase}/oauth/introspect` — RFC 7662 introspection.
 *
 * Both calls speak the identical wire contract the real connector would, so nothing downstream
 * of {@link IamAuthGuard} needs to know which of the two is live. Swapping this for
 * `@vipper/iam-connector` later, once the registry token is available, only touches
 * `iam.module.ts`'s provider factory.
 */

export interface IamClientConfig {
  /** The IAM REST API base, e.g. `https://iam.vipper.network/api/v1` (trailing slash optional). */
  apiBase: string;
  /** This resource server's own credentials — RFC 7662 requires the caller to authenticate. */
  clientId: string;
  clientSecret: string;
  /** Optional fetch override, for tests. Defaults to the platform's global `fetch`. */
  fetch?: typeof fetch;
}

export interface AuthorizeInput {
  /** The credential being authorized — presented as the bearer on `/authorize`. */
  token: string;
  resourceType: string;
  identifier: string;
  action: string;
}

export interface AuthorizeResult {
  allowed: boolean;
  scopes: string[];
}

export interface IntrospectionResult {
  active: boolean;
  subject: string | null;
  subjectType: 'user' | 'service' | null;
  scopes: string[];
  audience: string | null;
}

export interface IamClient {
  introspectToken(token: string): Promise<IntrospectionResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
}

export function createIamClient(config: IamClientConfig): IamClient {
  const apiBase = config.apiBase.replace(/\/+$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('iam client: no fetch implementation available; pass `fetch` in the config.');
  }
  // RFC 7662 client authentication — HTTP Basic with this resource server's own registered
  // credentials. (The real connector instead mints a cached client-credentials bearer token via
  // `${apiBase}/oauth/token` for this step, because it also needs that token for
  // `registerPackage`; this fallback has no such second use, so Basic auth keeps it to the two
  // endpoints the task actually needs.)
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  async function introspectToken(token: string): Promise<IntrospectionResult> {
    const res = await doFetch(`${apiBase}/oauth/introspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      throw new Error(`iam client: introspection failed (${res.status} ${await safeText(res)})`);
    }
    const json = (await res.json()) as {
      active: boolean;
      sub?: string;
      scope?: string;
      aud?: string;
      sub_type?: 'user' | 'service';
    };
    return {
      active: json.active,
      subject: json.sub ?? null,
      subjectType: json.sub_type ?? null,
      scopes: json.scope ? json.scope.split(' ').filter(Boolean) : [],
      audience: json.aud ?? null,
    };
  }

  async function authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const res = await doFetch(`${apiBase}/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The credential BEING authorized is presented here — not this resource server's own.
        Authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        resourceType: input.resourceType,
        identifier: input.identifier,
        action: input.action,
      }),
    });
    if (!res.ok) {
      throw new Error(`iam client: authorize failed (${res.status} ${await safeText(res)})`);
    }
    return (await res.json()) as AuthorizeResult;
  }

  return { introspectToken, authorize };
}

/** Read a response body as text without throwing (for error messages). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
