/**
 * Desktop sign-in against vipper.iam: authorization-code + PKCE, same shared dance as the
 * (future) web client — `@shared/iamPkce` — but caught here on a loopback listener instead of
 * a browser redirect, the same `node:http` on `127.0.0.1:0` pattern `permissionBroker.ts`
 * already runs. `shell.openExternal` puts the system browser (not an in-app window) in front
 * of the user, so vipper.iam's login page runs in a real, cookie-bearing browser session
 * rather than an Electron `BrowserWindow` a phishing page could impersonate.
 *
 * Electron-free by design (no `import('electron')`): `shell.openExternal` is injected by the
 * caller (`ipc.ts`), so this file — the actual OAuth state machine — is plain `node:http` and
 * testable with a real loopback server and `fetch`, the same way `permissionBroker.test.ts`
 * tests the broker.
 */
import { createServer, type Server } from 'node:http';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  type IamPkceConfig,
  type TokenResponse,
} from '@shared/iamPkce';

const CALLBACK_PATH = '/callback';
/** Give up waiting for the browser round trip after this long. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export type IamSignInConfig = Omit<IamPkceConfig, 'redirectUri'>;

/**
 * Runs one sign-in attempt end to end: generate PKCE + `state`, start the loopback listener,
 * open the browser at vipper.iam's `/auth`, wait for the redirect, exchange the code, and
 * always tear the listener down again — win or lose, its port is a one-time credential, not a
 * server this process keeps running between sign-ins.
 */
export async function signIn(
  config: IamSignInConfig,
  openExternal: (url: string) => Promise<void>,
): Promise<TokenResponse> {
  const pkce = await createPkcePair();
  const state = createState();
  const listener = await startCallbackListener(state);
  // The redirect can land — and waitForCode can reject — while `openExternal` below is still
  // in flight, before the `await` further down is reached to observe it. Latch a no-op catch
  // now so that window never reads as an unhandled rejection; the real `await` still sees the
  // same success/failure either way.
  listener.waitForCode.catch(() => undefined);

  try {
    const fullConfig: IamPkceConfig = { ...config, redirectUri: listener.redirectUri };
    await openExternal(buildAuthorizeUrl(fullConfig, pkce, state));
    const code = await listener.waitForCode;
    return await exchangeCodeForTokens(fullConfig, code, pkce.verifier);
  } finally {
    listener.close();
  }
}

interface CallbackListener {
  redirectUri: string;
  waitForCode: Promise<string>;
  close(): void;
}

/**
 * The ports this listener may bind, in order, and every one of them has to be registered as a
 * redirect URI on the `taskmanager-desktop` client.
 *
 * It used to bind port 0 — any free port — which is what RFC 8252 §7.3 tells a native app to
 * do, and it tells the authorization server to accept any port on a loopback redirect for
 * exactly that reason. vipper.iam runs node-oidc-provider, which compares `redirect_uri`
 * against the registered list as an EXACT STRING and implements no such loopback rule, so a
 * fresh port every attempt could never match anything anyone had registered:
 *
 *   error: invalid_redirect_uri — redirect_uri did not match any of the client's registered
 *   redirect_uris
 *
 * A fixed port would be one line, but it makes sign-in fail outright whenever something else
 * happens to hold that port. A short list keeps the registration finite (three URIs) while
 * still surviving a collision. Deliberately high and unusual numbers, to make one unlikely.
 *
 * The spec-correct fix is in the authorization server — teach it that a `127.0.0.1` redirect
 * matches regardless of port — and if that ever lands, this can go back to `listen(0)`.
 */
export const LOOPBACK_PORTS = [53682, 53683, 53684] as const;

/**
 * Binds one loopback listener for one sign-in attempt. Fail-safe deny: a request whose `state`
 * doesn't match the one this attempt generated gets a 400 and settles nothing — it does not
 * count as either success or failure, because it isn't this flow's redirect at all (a stale
 * tab, a retried request, or someone probing the port).
 */
async function startCallbackListener(expectedState: string): Promise<CallbackListener> {
  let lastError: unknown = null;
  for (const port of LOOPBACK_PORTS) {
    try {
      return await bindOn(port, expectedState);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not bind a sign-in listener on any of ${LOOPBACK_PORTS.join(', ')} — something else ` +
      `is using them. Close it and try again. (${String(lastError)})`,
  );
}

function bindOn(port: number, expectedState: string): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let settle: ((code: string) => void) | null = null;
    let fail: ((err: Error) => void) | null = null;
    const waitForCode = new Promise<string>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in state mismatch.');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error || !code) {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('Sign-in failed — you can close this tab.');
        fail?.(new Error(error ?? 'vipper.iam redirected with no authorization code.'));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/plain' })
        .end('Signed in — you can close this tab.');
      settle?.(code);
    });

    const timer = setTimeout(() => {
      fail?.(new Error('Sign-in timed out waiting for the browser redirect.'));
    }, SIGN_IN_TIMEOUT_MS);
    // Never keeps the process alive on its own — the listener is torn down in signIn()'s
    // `finally` well before this would fire in the normal case.
    timer.unref();

    server.on('error', (error) => {
      // A busy port lands here (EADDRINUSE); the caller moves on to the next candidate.
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('IAM sign-in listener failed to bind a TCP port'));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        waitForCode: waitForCode.finally(() => clearTimeout(timer)),
        close: () => server.close(),
      });
    });
  });
}
