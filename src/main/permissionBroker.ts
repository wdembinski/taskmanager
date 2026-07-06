/**
 * Permission broker (Phase 4 hardening) — the in-app side of the pre-execution
 * veto.
 *
 * The CLI-spawned MCP relay (`permissionServerSource.ts`) POSTs every tool use it
 * is asked to approve to this broker; the broker answers `allow`/`deny`. Because
 * the relay BLOCKS on that HTTP call, and the CLI blocks on the relay, returning
 * a decision here is exactly what lets a task run — or holds it for a human.
 *
 * The broker itself is pure plumbing: it authenticates the request and hands the
 * `{ runId, toolName, input }` to an injected `decide` callback (wired to the
 * scheduler, which applies the risk policy and, when needed, parks the task until
 * a human answers). Keeping the decision out of here makes both sides testable —
 * this file against a stub decider, the scheduler against fake requests.
 *
 * It listens only on 127.0.0.1 and requires a per-run bearer token (handed to the
 * relay via env), so no other local process can drive approvals.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/** What the relay sends us for each tool use awaiting a decision. */
export interface PermissionRequest {
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The MCP permission-result shape the CLI expects back (via the relay). */
export type PermissionDecisionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** How the broker reaches the decision — injected so it stays logic-free. */
export type Decider = (request: PermissionRequest) => Promise<PermissionDecisionResult>;

/** Connection details the relay needs (passed to it via the MCP config env). */
export interface BrokerAddress {
  url: string;
  token: string;
}

export class PermissionBroker {
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString('hex');

  constructor(private readonly decide: Decider) {}

  /** Start listening on a random localhost port; resolves with url + token. */
  start(): Promise<BrokerAddress> {
    const server = createServer((req, res) => void this.onRequest(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      // Port 0 = let the OS pick a free port; bind to loopback only.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('permission broker failed to bind a TCP port'));
          return;
        }
        resolve({ url: `http://127.0.0.1:${address.port}`, token: this.token });
      });
    });
  }

  /** Stop accepting connections (called on app quit). */
  close(): void {
    this.server?.close();
    this.server = null;
  }

  private async onRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/decide') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['authorization'] !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;

    let decision: PermissionDecisionResult;
    try {
      const parsed = JSON.parse(body) as { toolName?: unknown; input?: unknown };
      const request: PermissionRequest = {
        runId: String(req.headers['x-run-id'] ?? ''),
        toolName: typeof parsed.toolName === 'string' ? parsed.toolName : '',
        input:
          parsed.input && typeof parsed.input === 'object'
            ? (parsed.input as Record<string, unknown>)
            : {},
      };
      decision = await this.decide(request);
    } catch (err) {
      // On any internal error, fail SAFE (deny) rather than let a tool through.
      decision = { behavior: 'deny', message: `broker error: ${(err as Error).message}` };
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(decision));
  }
}
