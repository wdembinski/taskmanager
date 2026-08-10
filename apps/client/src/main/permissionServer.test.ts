/**
 * Integration test for the MCP relay script. We can't drive real Claude here, but
 * we CAN prove the piece the CLI talks to works end to end: write the exact relay
 * source we ship to disk, spawn it, speak the MCP stdio handshake to it, and check
 * that a `tools/call` is relayed to our (fake) broker with the right auth + body
 * and that the broker's decision comes back as the tool result.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSION_SERVER_SOURCE } from './permissionServerSource';

let child: ChildProcessWithoutNullStreams | null = null;
let broker: Server | null = null;

afterEach(() => {
  child?.kill();
  child = null;
  broker?.close();
  broker = null;
});

/** Stand up a fake broker that records the request and returns `decision`. */
function startFakeBroker(decision: unknown): Promise<{ url: string; seen: () => Request | null }> {
  let seen: Request | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = {
        auth: req.headers['authorization'],
        runId: req.headers['x-run-id'],
        body: JSON.parse(body || '{}'),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision));
    });
  });
  broker = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, seen: () => seen });
    });
  });
}

interface Request {
  auth: string | undefined;
  runId: string | string[] | undefined;
  body: unknown;
}

/** Collect stdout lines until one parses to a JSON-RPC message with the given id. */
function waitForResponse(proc: ChildProcessWithoutNullStreams, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`no response for id ${id}`)), 8000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) {
          clearTimeout(timer);
          resolve(msg);
        }
      }
    });
  });
}

describe('permission relay (MCP stdio server)', () => {
  it('relays a tools/call to the broker and returns its decision', async () => {
    const decision = { behavior: 'deny', message: 'held for review' };
    const { url, seen } = await startFakeBroker(decision);

    const dir = mkdtempSync(join(tmpdir(), 'orch-relay-'));
    const scriptPath = join(dir, 'permission-server.cjs');
    writeFileSync(scriptPath, PERMISSION_SERVER_SOURCE, 'utf8');

    child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        ORCH_BROKER_URL: url,
        ORCH_TOKEN: 'secret-token',
        ORCH_RUN_ID: 'run-99',
      },
    }) as ChildProcessWithoutNullStreams;

    // MCP handshake, then the actual permission call.
    const initReply = waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    );
    expect((await initReply).result.serverInfo.name).toBe('orchestrator-permissions');

    const callReply = waitForResponse(child, 2);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'approve',
          arguments: { tool_name: 'Bash', input: { command: 'git push' } },
        },
      }) + '\n',
    );

    const reply = await callReply;
    // The tool result carries the broker's decision as JSON text.
    expect(JSON.parse(reply.result.content[0].text)).toEqual(decision);

    // The broker saw the right auth, run id, and forwarded tool + input.
    const req = seen();
    expect(req?.auth).toBe('Bearer secret-token');
    expect(req?.runId).toBe('run-99');
    expect(req?.body).toEqual({ toolName: 'Bash', input: { command: 'git push' } });
  }, 15000);
});
