import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '@tm/protocol/wire';
import { clientInfoColumns, describeClients, toClientInfo } from './clientInfo';

function request(overrides: Partial<SyncRequest> = {}): SyncRequest {
  return {
    clientId: 'desktop-1',
    cursor: null,
    focused: true,
    deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
    ackedCommandIds: [],
    ...overrides,
  };
}

const NAMELESS = {
  name: null,
  platform: null,
  appVersion: null,
  protocolVersion: null,
} as const;

describe('clientInfoColumns', () => {
  it('writes nothing for a request that carried no identity at all', () => {
    expect(clientInfoColumns(request())).toEqual({});
  });

  it('writes every field a Client sent', () => {
    const columns = clientInfoColumns(
      request({
        info: { name: 'WORKSTATION', platform: 'win32', appVersion: '0.84.5', protocolVersion: 2 },
      }),
    );

    expect(columns).toEqual({
      name: 'WORKSTATION',
      platform: 'win32',
      appVersion: '0.84.5',
      protocolVersion: 2,
    });
  });

  it('omits a field the Client left out, rather than nulling what is stored', () => {
    // `upsert` derives its update set from the keys present, so an absent key is the
    // difference between "said nothing" and "erased the name it gave us last tick".
    expect(clientInfoColumns(request({ info: { name: 'WORKSTATION' } }))).toEqual({
      name: 'WORKSTATION',
    });
  });

  it('falls back to the top-level protocol version a build that predates info still sends', () => {
    expect(clientInfoColumns(request({ protocolVersion: 2 }))).toEqual({ protocolVersion: 2 });
  });

  it('prefers the version inside info when a Client sends both', () => {
    expect(
      clientInfoColumns(request({ protocolVersion: 2, info: { protocolVersion: 3 } })),
    ).toEqual({ protocolVersion: 3 });
  });
});

describe('toClientInfo', () => {
  it('is undefined for a row registered before any of this existed', () => {
    expect(toClientInfo(NAMELESS)).toBeUndefined();
  });

  it('drops the nulls rather than reporting them as absent-but-present', () => {
    expect(toClientInfo({ ...NAMELESS, name: 'WORKSTATION' })).toEqual({ name: 'WORKSTATION' });
  });

  it('carries every stored field', () => {
    expect(
      toClientInfo({
        name: 'WORKSTATION',
        platform: 'linux',
        appVersion: '0.84.5',
        protocolVersion: 2,
      }),
    ).toEqual({ name: 'WORKSTATION', platform: 'linux', appVersion: '0.84.5', protocolVersion: 2 });
  });
});

describe('describeClients', () => {
  it('attaches each row to its presence, in presence order', () => {
    const described = describeClients(
      [
        { id: 'desktop-2', lastSeen: 500 },
        { id: 'desktop-1', lastSeen: 100 },
      ],
      [
        { id: 'desktop-1', ...NAMELESS, name: 'OLD-BOX' },
        { id: 'desktop-2', ...NAMELESS, name: 'LAPTOP' },
      ],
    );

    expect(described).toEqual([
      { id: 'desktop-2', lastSeen: 500, info: { name: 'LAPTOP' } },
      { id: 'desktop-1', lastSeen: 100, info: { name: 'OLD-BOX' } },
    ]);
  });

  it('keeps a live Client with no row behind it — it is still a command target', () => {
    expect(describeClients([{ id: 'desktop-1', lastSeen: 100 }], [])).toEqual([
      { id: 'desktop-1', lastSeen: 100 },
    ]);
  });

  it('adds no info key at all for a row that says nothing', () => {
    const [described] = describeClients(
      [{ id: 'desktop-1', lastSeen: 100 }],
      [{ id: 'desktop-1', ...NAMELESS }],
    );

    expect(described).not.toHaveProperty('info');
  });
});
