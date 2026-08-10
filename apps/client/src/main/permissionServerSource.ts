/**
 * The permission MCP server — source + materializer (Phase 4 hardening).
 *
 * WHY THIS EXISTS
 * ---------------
 * To *actually* veto a risky tool before Claude runs it (not just notice it
 * after), we use the CLI's `--permission-prompt-tool`: when Claude wants to use a
 * tool, the CLI calls an MCP tool we provide and BLOCKS until it answers
 * allow/deny. The CLI spawns MCP servers itself (from `--mcp-config`), so this
 * has to be a real, standalone process — it cannot be a function in our main
 * process.
 *
 * This module keeps that server as a small, self-contained CommonJS *string* and
 * writes it to disk on demand (`writePermissionServer`). Keeping it as a string
 * (rather than a separate bundler entry) means it materializes identically in dev
 * and in a packaged app, always as plain `.cjs`, and the exact bytes we ship are
 * the exact bytes our tests spawn — one source of truth.
 *
 * The script is deliberately DUMB: it speaks the MCP stdio handshake and relays
 * every tool call to our in-app broker over localhost HTTP, returning whatever
 * the broker decides. All real logic (the risk policy, routing to a human) lives
 * in TypeScript in the main process (`permissionBroker.ts` + `scheduler.ts`),
 * where it is unit-tested.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The MCP tool name the CLI must call, as `mcp__<serverKey>__<toolName>`. */
export const PERMISSION_MCP_SERVER_KEY = 'orchestrator-permissions';
export const PERMISSION_MCP_TOOL_NAME = 'approve';
export const PERMISSION_PROMPT_TOOL = `mcp__${PERMISSION_MCP_SERVER_KEY}__${PERMISSION_MCP_TOOL_NAME}`;

/**
 * The relay server, as CommonJS source. Uses only Node core (`http`) so it runs
 * under `ELECTRON_RUN_AS_NODE=1 electron script.cjs` with no dependencies. Reads
 * newline-delimited JSON-RPC on stdin, writes it on stdout; anything diagnostic
 * goes to stderr so it never corrupts the protocol stream.
 */
export const PERMISSION_SERVER_SOURCE = String.raw`'use strict';
// Minimal MCP stdio server exposing one tool: ${PERMISSION_MCP_TOOL_NAME}. Every
// call is relayed to the orchestrator broker; its decision is returned verbatim.
const http = require('http');

const BROKER_URL = process.env.ORCH_BROKER_URL || '';
const TOKEN = process.env.ORCH_TOKEN || '';
const RUN_ID = process.env.ORCH_RUN_ID || '';

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Ask the broker to decide one tool use. Resolves to the MCP permission result
// object ({behavior:'allow',updatedInput} | {behavior:'deny',message}).
function askBroker(toolName, input) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(BROKER_URL);
    } catch (e) {
      reject(e);
      return;
    }
    const body = JSON.stringify({ toolName: toolName, input: input || {} });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/decide',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer ' + TOKEN,
          'x-run-id': RUN_ID,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function handle(msg) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};

  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '${PERMISSION_MCP_SERVER_KEY}', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id: id,
      result: {
        tools: [
          {
            name: '${PERMISSION_MCP_TOOL_NAME}',
            description: 'Decide whether a requested tool use may proceed.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const args = params.arguments || {};
    askBroker(args.tool_name, args.input)
      .then((decision) => {
        writeMessage({
          jsonrpc: '2.0',
          id: id,
          result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
        });
      })
      .catch((err) => {
        // If the broker is unreachable, fail SAFE: deny rather than allow.
        writeMessage({
          jsonrpc: '2.0',
          id: id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  behavior: 'deny',
                  message: 'orchestrator broker unavailable: ' + (err && err.message),
                }),
              },
            ],
          },
        });
      });
    return;
  }

  // Notifications (no id) need no reply; unknown requests get a JSON-RPC error.
  if (id !== undefined && id !== null) {
    writeMessage({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'method not found' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      // Ignore malformed lines rather than crash the permission channel.
    }
  }
});
`;

/**
 * Write the relay server to `dir` (created if needed) and return its path.
 * Called once at engine startup; the path is handed to each gated session.
 */
export function writePermissionServer(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'permission-server.cjs');
  writeFileSync(path, PERMISSION_SERVER_SOURCE, 'utf8');
  return path;
}
