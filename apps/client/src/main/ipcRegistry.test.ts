import { describe, expect, it, vi } from 'vitest';
import { RelayRegistry } from './ipcRegistry';

describe('RelayRegistry', () => {
  it('runs a registered, relayable channel and returns its value', async () => {
    const registry = new RelayRegistry();
    registry.register('board:tasks', async () => [{ id: 't1' }]);

    expect(await registry.invoke('board:tasks', [])).toEqual({ ok: true, value: [{ id: 't1' }] });
  });

  it('passes the arguments through in order', async () => {
    const registry = new RelayRegistry();
    const handler = vi.fn(async () => undefined);
    registry.register('task:setStatus', handler as never);

    await registry.invoke('task:setStatus', ['t1', 'done']);
    expect(handler).toHaveBeenCalledWith('t1', 'done');
  });

  it('refuses a host-only channel by name, with the reason', async () => {
    const registry = new RelayRegistry();
    // Registered, and still refused — the classification decides, not the wiring.
    registry.register('attachment:pick', async () => ['C:/secrets.txt']);

    const result = await registry.invoke('attachment:pick', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('attachment:pick');
    expect(result.error).toContain('file picker');
    expect(result.value).toBeUndefined();
  });

  it('refuses a channel no handler was registered for, and says the build is old', async () => {
    const registry = new RelayRegistry();
    const result = await registry.invoke('board:tasks', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('older than the browser tab');
  });

  it('refuses a name that is not a channel at all', async () => {
    const registry = new RelayRegistry();
    const result = await registry.invoke('task:selfDestruct', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a channel');
  });

  it('never throws — a rejecting handler comes back as a result', async () => {
    const registry = new RelayRegistry();
    registry.register('task:move', async () => {
      throw new Error('Card is locked by a running session.');
    });

    // No `.rejects` here on purpose: this promise must settle, because a serial drain is
    // awaiting it and a browser is holding a promise behind it.
    const result = await registry.invoke('task:move', ['t1', 'done']);
    expect(result).toEqual({ ok: false, error: 'Card is locked by a running session.' });
  });

  it('carries the handler’s message verbatim, not String(err)', async () => {
    const registry = new RelayRegistry();
    registry.register('task:run', async () => {
      throw new Error('This card is already running.');
    });

    const result = await registry.invoke('task:run', ['t1']);
    // `String(new Error('x'))` is "Error: x"; a bare `String(err)` on a message-less Error is
    // the word "Error", which is what a browser would have been shown.
    expect(result.error).toBe('This card is already running.');
    expect(result.error).not.toContain('Error:');
  });

  it('describes something thrown that is not an Error', async () => {
    const registry = new RelayRegistry();
    registry.register('task:run', async () => {
      throw { code: 'ENOENT' };
    });
    const result = await registry.invoke('task:run', ['t1']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('The desktop app failed without saying why.');
  });

  it('describes an Error thrown with no message', async () => {
    const registry = new RelayRegistry();
    registry.register('task:run', async () => {
      throw new Error('');
    });
    const result = await registry.invoke('task:run', ['t1']);
    expect(result.error).toBe('The desktop app failed without saying why.');
  });

  it('keeps a void channel’s undefined as undefined', async () => {
    const registry = new RelayRegistry();
    registry.register('task:delete', async () => undefined);
    const result = await registry.invoke('task:delete', ['t1']);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('fails one command rather than the whole tick when a value cannot be sent', async () => {
    const registry = new RelayRegistry();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    registry.register('board:tasks', async () => circular);

    const result = await registry.invoke('board:tasks', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot be sent to a browser');
  });

  it('relays attention:dismiss and carries a refusal through as an error, not a throw', async () => {
    const registry = new RelayRegistry();
    registry.register('attention:dismiss', async (itemId: string) => {
      if (itemId === 'gone') {
        throw new Error(
          'Could not dismiss that item — it may already be gone, or it needs to be resolved instead.',
        );
      }
    });

    const ok = await registry.invoke('attention:dismiss', ['item-1']);
    expect(ok).toEqual({ ok: true, value: undefined });

    const refused = await registry.invoke('attention:dismiss', ['gone']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('already be gone');
  });

  it('reports what it can invoke', () => {
    const registry = new RelayRegistry();
    expect(registry.canInvoke('board:tasks')).toBe(false);
    registry.register('board:tasks', async () => []);
    expect(registry.canInvoke('board:tasks')).toBe(true);

    registry.register('window:close', async () => undefined);
    expect(registry.canInvoke('window:close')).toBe(false);
  });
});
