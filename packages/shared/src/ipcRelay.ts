/**
 * Which IPC channels may be RELAYED to a desktop client over the cloud mirror, and which
 * only ever run on the machine showing the window.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * apps/web reaches the engine through the same `IpcApi` the desktop renderer does
 * (`packages/ui/src/transport.tsx`), but a browser tab has no engine behind it: its
 * `invoke` posts an `ipc-invoke` command (`@tm/protocol/wire`) which the desktop client
 * picks up on its next `/v1/sync` and runs against its OWN handler. That works for almost
 * every channel — and is actively wrong for a handful, listed below with the reason each
 * is there.
 *
 * The record is **exhaustive over `keyof IpcApi`**, and that is the entire point. Adding a
 * channel to `IpcApi` fails `pnpm typecheck` here until somebody classifies it, which is
 * the review gate that a hand-maintained enumeration — a `Set` of strings, say — would
 * silently never give: a new channel would just default to relayable, and the first person
 * to find out would be whoever's file dialog opened on a machine they were not sitting at.
 *
 * Its two consumers are deliberately on opposite sides of the wire, and both read THIS
 * file rather than each keeping a list:
 *  - apps/web (`httpTransport.ts`) refuses a host-only channel locally, naming the reason
 *    from {@link hostOnlyMessage} instead of a sentence written twice; and
 *  - apps/client (`ipcRegistry.ts`) refuses one that arrives over the wire anyway, because
 *    the browser's refusal is a courtesy and the engine's is the guarantee.
 */
import type { IpcApi } from './ipc';

/** Whether a channel may run on behalf of a remote (browser) caller. */
export type RelayPolicy = 'relay' | 'host-only';

/**
 * Why a channel is host-only. Four groups, not one flag, because the refusal a human reads
 * should say what is actually in the way — "sign in from the desktop app" and "this opens a
 * file picker over there" are different problems with different fixes.
 */
export type HostOnlyReason =
  /** `await`s a native `dialog.showOpenDialog`. */
  | 'native-modal'
  /** Drives the desktop window, or the OS around it. */
  | 'window-os'
  /** Writes a secret into the desktop machine's secure store. */
  | 'credential-write'
  /** Owns a live Claude process' lifetime or its open stdin. */
  | 'live-session';

/**
 * Every host-only channel and the reason it is one.
 *
 * **Native modals.** Each of these `await`s `dialog.showOpenDialog` on the desktop machine.
 * Relayed, one of them wedges cloud sync — the relay drains serially — until somebody who
 * did not ask for it dismisses a dialog that appeared on their screen. Worse, the paths it
 * returns are paths on THAT machine, which is exactly the thing a browser cannot use.
 *
 * **Window / OS.** `window:*` moves a window nobody is looking at; `update:install` quits
 * the app out from under its user; `attachment:open` pops a file open on someone else's
 * screen via `shell.openPath`. `auth:signIn` opens an interactive terminal there, and
 * `iam:signIn` is a loopback PKCE flow the browser runs for itself (`apps/web/src/auth`) —
 * relaying it would sign the DESKTOP in when a browser tab asked to sign itself in.
 *
 * **Credential writes.** A secret typed into a browser would cross the mirror as plaintext
 * inside a command payload and land in the server's `commands` table, which is an audit
 * trail. The Settings fork (`apps/web/src/settings/`) says "set this from the desktop app"
 * for exactly these.
 *
 * **Live sessions.** `session:start`/`stop`/`answer` are the raw process API underneath the
 * card-level channels; a run id is a handle into the desktop's `SessionManager` and means
 * nothing in a browser, which has no way to have obtained a valid one. The card-level
 * equivalents (`task:run`, `task:stopAgent`, `task:chat`, `attention:answer`) DO relay —
 * they take a task id, which is mirrored, and are what the web UI actually presses.
 */
const HOST_ONLY_REASONS = {
  'project:pickDirectory': 'native-modal',
  'project:pickFile': 'native-modal',
  'attachment:pick': 'native-modal',
  'jira:pickAttachments': 'native-modal',

  'window:minimize': 'window-os',
  'window:toggleMaximize': 'window-os',
  'window:close': 'window-os',
  'window:isMaximized': 'window-os',
  'update:install': 'window-os',
  'attachment:open': 'window-os',
  'auth:signIn': 'window-os',
  'iam:signIn': 'window-os',

  'jira:setCredentials': 'credential-write',
  'jira:clearCredentials': 'credential-write',
  'gitlab:setCredentials': 'credential-write',
  'gitlab:clearCredentials': 'credential-write',
  'github:setCredentials': 'credential-write',
  'github:clearCredentials': 'credential-write',
  'iam:signOut': 'credential-write',

  'session:start': 'live-session',
  'session:stop': 'live-session',
  'session:answer': 'live-session',
} as const satisfies Partial<Record<keyof IpcApi, HostOnlyReason>>;

/** The channels {@link HOST_ONLY_REASONS} names — a union of literals, not `string`. */
export type HostOnlyChannel = keyof typeof HOST_ONLY_REASONS;

/**
 * Every channel's policy, exhaustive over `IpcApi`.
 *
 * The value type is computed from {@link HOST_ONLY_REASONS} rather than being a flat
 * `RelayPolicy`, so the two lists cannot disagree: marking a channel `'relay'` here while
 * giving it a reason above is a type error, and so is the reverse. The list still has to be
 * written out in full — that is the gate.
 */
export const RELAY_POLICY: {
  [K in keyof IpcApi]: K extends HostOnlyChannel ? 'host-only' : 'relay';
} = {
  'app:getInfo': 'relay',
  'claude:getStatus': 'relay',
  'claude:listSessions': 'relay',

  'exec:listDistros': 'relay',
  'exec:readiness': 'relay',
  'exec:targetsInUse': 'relay',

  'session:start': 'host-only',
  'session:stop': 'host-only',
  'session:answer': 'host-only',

  'project:pickDirectory': 'host-only',
  'project:pickFile': 'host-only',
  'project:add': 'relay',
  'project:list': 'relay',
  'project:remove': 'relay',
  'project:syncPlan': 'relay',
  'project:setWriteBack': 'relay',
  'project:setAligned': 'relay',
  'project:update': 'relay',
  'project:validatePlan': 'relay',
  'project:gitPreflight': 'relay',
  'project:alignPlan': 'relay',
  'project:hasReleaseDoc': 'relay',

  'git:graph': 'relay',

  'agentProject:list': 'relay',
  'agentProject:add': 'relay',
  'agentProject:update': 'relay',
  'agentProject:remove': 'relay',

  'scheduler:start': 'relay',
  'scheduler:pause': 'relay',
  'scheduler:stop': 'relay',
  'scheduler:activeRuns': 'relay',
  'scheduler:states': 'relay',
  'scheduler:integrating': 'relay',

  'task:run': 'relay',
  'task:integrate': 'relay',
  'task:create': 'relay',
  'task:delete': 'relay',
  'task:subtasks': 'relay',
  'task:addSubtask': 'relay',
  'task:updateSubtask': 'relay',
  'task:setStatus': 'relay',
  'task:setDescription': 'relay',
  'task:setPriority': 'relay',
  'task:setStatusNote': 'relay',
  'task:setProject': 'relay',
  'task:setAgentOptions': 'relay',
  'task:activity': 'relay',
  'task:addComment': 'relay',
  'task:deleteComment': 'relay',
  'task:attachSession': 'relay',
  'task:history': 'relay',
  'task:cleanupWorktree': 'relay',
  'task:assignAgent': 'relay',
  'task:stopAgent': 'relay',
  'task:resumeAgent': 'relay',
  'task:chat': 'relay',
  'task:replan': 'relay',
  'task:dismissAttention': 'relay',
  'task:restore': 'relay',
  'task:move': 'relay',

  'attention:list': 'relay',
  'attention:answer': 'relay',

  'limit:current': 'relay',
  'limit:resumeNow': 'relay',

  'auth:current': 'relay',
  'auth:signIn': 'host-only',
  'auth:signedIn': 'relay',

  'usage:summary': 'relay',
  'usage:series': 'relay',
  'usage:quotas': 'relay',

  'settings:get': 'relay',
  'settings:save': 'relay',

  'jira:getConfigStatus': 'relay',
  'jira:setCredentials': 'host-only',
  'jira:clearCredentials': 'host-only',
  'jira:testConnection': 'relay',
  'jira:priorities': 'relay',
  'jira:statuses': 'relay',
  'jira:sync': 'relay',
  'jira:fetchComments': 'relay',
  'jira:addComment': 'relay',
  'jira:searchUsers': 'relay',
  'jira:pickAttachments': 'host-only',
  'jira:projects': 'relay',
  'jira:issueTypes': 'relay',
  'jira:createTask': 'relay',
  'jira:markRead': 'relay',

  'gitlab:getConfigStatus': 'relay',
  'gitlab:setCredentials': 'host-only',
  'gitlab:clearCredentials': 'host-only',
  'gitlab:testConnection': 'relay',
  'gitlab:sync': 'relay',

  'github:getConfigStatus': 'relay',
  'github:setCredentials': 'host-only',
  'github:clearCredentials': 'host-only',
  'github:testConnection': 'relay',
  'github:sync': 'relay',
  // The same four as JIRA's, and relayed for the same reason: they are the shared pane's own
  // calls, picked by the card's tracker rather than by which app is asking.
  'github:fetchComments': 'relay',
  'github:addComment': 'relay',
  'github:searchUsers': 'relay',
  'github:markRead': 'relay',

  // Merge requests are provider-neutral, so these four are `mr:` rather than one set per
  // forge — the reason `mergeRequest.ts` gives. They relay for the same reason the syncs do.
  'mr:mergeRequests': 'relay',
  'mr:setMergeRequestName': 'relay',
  'mr:markRead': 'relay',
  'mr:markEventsSeen': 'relay',

  'cloud:testConnection': 'relay',

  'iam:getConfigStatus': 'relay',
  'iam:signIn': 'host-only',
  'iam:signOut': 'host-only',

  'sync:state': 'relay',

  'board:tasks': 'relay',
  'board:archived': 'relay',

  'chain:links': 'relay',
  'chain:link': 'relay',
  'chain:unlink': 'relay',
  'chain:setGate': 'relay',
  'chain:releaseNow': 'relay',

  'attachment:list': 'relay',
  'attachment:pick': 'host-only',
  'attachment:add': 'relay',
  'attachment:remove': 'relay',
  'attachment:open': 'host-only',

  'window:minimize': 'host-only',
  'window:toggleMaximize': 'host-only',
  'window:close': 'host-only',
  'window:isMaximized': 'host-only',

  'update:get': 'relay',
  'update:check': 'relay',
  'update:install': 'host-only',
};

/** Whether this channel may be run on a desktop client on a browser's behalf. */
export function isRelayable(channel: string): channel is keyof IpcApi {
  return (RELAY_POLICY as Record<string, RelayPolicy | undefined>)[channel] === 'relay';
}

/** The reason a channel is host-only, or `null` when it relays (or is not a channel at all). */
export function hostOnlyReason(channel: string): HostOnlyReason | null {
  return (HOST_ONLY_REASONS as Record<string, HostOnlyReason | undefined>)[channel] ?? null;
}

/** What each reason means, in a sentence a human reads rather than a tag. */
const REASON_TEXT: Record<HostOnlyReason, string> = {
  'native-modal': 'it opens a file picker on the machine the desktop app is running on',
  'window-os': 'it controls the desktop app itself, or the machine it is running on',
  'credential-write': "it stores a secret in that machine's own credential store",
  'live-session': 'it drives a live Claude process, which only the desktop app holds',
};

/**
 * The one sentence a refused channel answers with, wherever the refusal happens.
 *
 * Written once and read from both sides on purpose: the browser refuses locally so the
 * click fails immediately, and the engine refuses again if a command reaches it anyway. Two
 * hand-written messages for one rule is how a channel ends up refused for a reason the
 * other side no longer believes.
 */
export function hostOnlyMessage(channel: string): string {
  const reason = hostOnlyReason(channel);
  if (!reason) return `"${channel}" is not a channel this app knows.`;
  return `"${channel}" only works in the desktop app — ${REASON_TEXT[reason]}. Do this from there.`;
}
