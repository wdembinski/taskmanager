import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { allowPermission, registerMediaPermissionGuard } from './mediaPermission';

describe('allowPermission', () => {
  it('denies media, which covers both audio and video requests', () => {
    expect(allowPermission('media')).toBe(false);
  });

  it('grants permissions other than media', () => {
    expect(allowPermission('notifications')).toBe(true);
    expect(allowPermission('clipboard-sanitized-write')).toBe(true);
    expect(allowPermission('fullscreen')).toBe(true);
  });
});

describe('registerMediaPermissionGuard', () => {
  function fakeSession() {
    let requestHandler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void = () => {};
    let checkHandler: (webContents: unknown, permission: string, origin: string) => boolean = () =>
      false;

    const ses = {
      setPermissionRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        checkHandler = handler;
      }),
    } as unknown as Session;

    return {
      ses,
      requestHandler: (...args: Parameters<typeof requestHandler>) => requestHandler(...args),
      checkHandler: (...args: Parameters<typeof checkHandler>) => checkHandler(...args),
    };
  }

  it('denies a media request for audio from the packaged file:// origin', () => {
    const { ses, requestHandler } = fakeSession();
    registerMediaPermissionGuard(ses);

    const callback = vi.fn();
    requestHandler({}, 'media', callback, {
      mediaTypes: ['audio'],
      requestingUrl: 'file:///C:/app/index.html',
    });

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('denies a media request from a foreign origin too', () => {
    const { ses, requestHandler } = fakeSession();
    registerMediaPermissionGuard(ses);

    const callback = vi.fn();
    requestHandler({}, 'media', callback, {
      mediaTypes: ['audio', 'video'],
      requestingUrl: 'https://example.com',
    });

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('check handler returns false for media', () => {
    const { ses, checkHandler } = fakeSession();
    registerMediaPermissionGuard(ses);

    expect(checkHandler({}, 'media', 'file:///')).toBe(false);
  });
});
