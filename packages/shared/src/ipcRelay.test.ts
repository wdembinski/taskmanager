import { describe, expect, it } from 'vitest';
import {
  hostOnlyMessage,
  hostOnlyReason,
  isRelayable,
  oversizedAnswerMessage,
  parseOversizedAnswer,
  RELAY_POLICY,
  type HostOnlyReason,
} from './ipcRelay';

/**
 * The host-only list, restated here as data rather than derived from the module under test —
 * a test that reads its expectation out of the thing it is testing passes for any list at
 * all. Each entry carries the reason, so a channel silently changing group is caught too.
 */
const HOST_ONLY: ReadonlyArray<readonly [string, HostOnlyReason]> = [
  ['project:pickDirectory', 'native-modal'],
  ['project:pickFile', 'native-modal'],
  ['attachment:pick', 'native-modal'],
  ['jira:pickAttachments', 'native-modal'],
  ['skill:import', 'native-modal'],
  ['skill:export', 'native-modal'],
  ['window:minimize', 'window-os'],
  ['window:toggleMaximize', 'window-os'],
  ['window:close', 'window-os'],
  ['window:isMaximized', 'window-os'],
  ['update:install', 'window-os'],
  ['attachment:open', 'window-os'],
  ['auth:signIn', 'window-os'],
  ['jira:setCredentials', 'credential-write'],
  ['jira:clearCredentials', 'credential-write'],
  ['gitlab:setCredentials', 'credential-write'],
  ['gitlab:clearCredentials', 'credential-write'],
  ['github:setCredentials', 'credential-write'],
  ['github:clearCredentials', 'credential-write'],
  ['linear:setCredentials', 'credential-write'],
  ['linear:clearCredentials', 'credential-write'],
  ['cloud:setCredentials', 'credential-write'],
  ['cloud:clearCredentials', 'credential-write'],
  ['session:start', 'live-session'],
  ['session:stop', 'live-session'],
  ['session:answer', 'live-session'],
  ['attachment:stagePasted', 'host-path'],
];

describe('the host-only channels', () => {
  for (const [channel, reason] of HOST_ONLY) {
    it(`${channel} never leaves the desktop (${reason})`, () => {
      expect(isRelayable(channel)).toBe(false);
      expect(hostOnlyReason(channel)).toBe(reason);
    });
  }

  it('is exactly that list — nothing else is withheld from the web', () => {
    const marked = Object.entries(RELAY_POLICY)
      .filter(([, policy]) => policy === 'host-only')
      .map(([channel]) => channel)
      .sort();
    expect(marked).toEqual(HOST_ONLY.map(([channel]) => channel).sort());
  });

  it('names its reason in the refusal, rather than a generic "not available"', () => {
    expect(hostOnlyMessage('attachment:pick')).toContain('file picker');
    expect(hostOnlyMessage('jira:setCredentials')).toContain('credential store');
    expect(hostOnlyMessage('session:start')).toContain('live Claude process');
    expect(hostOnlyMessage('window:close')).toContain('desktop app itself');
    expect(hostOnlyMessage('attachment:stagePasted')).toContain('own disk');
  });
});

describe('the channels that DO relay', () => {
  /**
   * The card-level counterparts of the host-only process API, plus the reads the shared
   * detail pane makes at mount. If any of these ever slipped into `host-only`, the web
   * board would go back to being a picture of a board.
   */
  const MUST_RELAY = [
    'task:run',
    'task:stopAgent',
    'task:resumeAgent',
    'task:chat',
    'task:replan',
    'attention:answer',
    'task:activity',
    'attachment:list',
    'attachment:add',
    'chain:links',
    'chain:link',
    'scheduler:activeRuns',
    'scheduler:integrating',
    'mr:mergeRequests',
    'project:list',
    'settings:get',
    'settings:save',
    'git:graph',
    'activity:list',
    'activity:overview',
    'usage:daily',
    'issues:list',
    'issues:import',
    'task:diffSummary',
    'task:diffFile',
    'task:diffImage',
    'review:list',
    'review:add',
    'review:update',
    'review:delete',
    'review:send',
  ];

  for (const channel of MUST_RELAY) {
    it(`${channel} relays`, () => {
      expect(isRelayable(channel)).toBe(true);
      expect(hostOnlyReason(channel)).toBeNull();
    });
  }
});

describe('the Linear channels that relay', () => {
  const LINEAR_RELAYABLE = [
    'linear:getConfigStatus',
    'linear:testConnection',
    'linear:teams',
    'linear:states',
    'linear:sync',
    'linear:fetchComments',
    'linear:addComment',
    'linear:markRead',
  ];

  for (const channel of LINEAR_RELAYABLE) {
    it(`${channel} relays`, () => {
      expect(isRelayable(channel)).toBe(true);
      expect(hostOnlyReason(channel)).toBeNull();
    });
  }
});

describe('a name that is not a channel', () => {
  it('is not relayable, and says so rather than naming a reason', () => {
    expect(isRelayable('task:selfDestruct')).toBe(false);
    expect(hostOnlyReason('task:selfDestruct')).toBeNull();
    expect(hostOnlyMessage('task:selfDestruct')).toContain('not a channel');
  });

  it('cannot be smuggled in through a prototype key', () => {
    // `RELAY_POLICY` is an object literal, so `'constructor' in it` is true — a lookup
    // that trusted `in` rather than the VALUE would relay this.
    expect(isRelayable('constructor')).toBe(false);
    expect(isRelayable('toString')).toBe(false);
  });
});

describe('an oversized relayed answer', () => {
  it('round-trips through the message cloudResults.ts builds', () => {
    const bytes = 1_234_567;
    expect(parseOversizedAnswer(oversizedAnswerMessage(bytes))).toBe(bytes);
  });

  it('still matches with a prefix in front of it', () => {
    const message = `task:diffFile failed: ${oversizedAnswerMessage(42)}`;
    expect(parseOversizedAnswer(message)).toBe(42);
  });

  it('is null for any other error', () => {
    expect(parseOversizedAnswer('nope')).toBeNull();
    expect(parseOversizedAnswer('500 bytes written')).toBeNull();
  });
});
