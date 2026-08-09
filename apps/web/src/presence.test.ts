import { describe, expect, it, vi } from 'vitest';
import {
  createPresenceFocusSignal,
  PresenceHeartbeat,
  type PresenceHeartbeatDeps,
} from './presence';

/** A minimal `Document`/`Window` pair a test can flip by hand — this repo runs vitest with no
 *  jsdom (see `board/clientId.test.ts`'s own fake-`Storage` pattern), so `document`/`window`
 *  aren't real globals here. */
function fakeDocWin(initial: { visible: boolean; hasFocus: boolean }): {
  doc: Document;
  win: Window;
  setVisible(next: boolean): void;
  setFocus(next: boolean): void;
} {
  let visible = initial.visible;
  let hasFocus = initial.hasFocus;
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();

  const doc = {
    get visibilityState() {
      return visible ? 'visible' : 'hidden';
    },
    hasFocus: () => hasFocus,
    addEventListener: (type: string, cb: () => void) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      docListeners.get(type)?.delete(cb);
    },
  } as unknown as Document;

  const win = {
    addEventListener: (type: string, cb: () => void) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      winListeners.get(type)?.delete(cb);
    },
  } as unknown as Window;

  const fire = (listeners: Map<string, Set<() => void>>, type: string): void => {
    for (const cb of listeners.get(type) ?? []) cb();
  };

  return {
    doc,
    win,
    setVisible(next) {
      visible = next;
      fire(docListeners, 'visibilitychange');
    },
    setFocus(next) {
      hasFocus = next;
      fire(winListeners, next ? 'focus' : 'blur');
    },
  };
}

describe('createPresenceFocusSignal', () => {
  it('is focused only when visible AND the window has focus', () => {
    const { doc, win } = fakeDocWin({ visible: true, hasFocus: true });
    expect(createPresenceFocusSignal(doc, win).isFocused()).toBe(true);
  });

  it('is not focused when visible but the window is blurred', () => {
    const { doc, win } = fakeDocWin({ visible: true, hasFocus: false });
    expect(createPresenceFocusSignal(doc, win).isFocused()).toBe(false);
  });

  it('is not focused when focused but hidden', () => {
    const { doc, win } = fakeDocWin({ visible: false, hasFocus: true });
    expect(createPresenceFocusSignal(doc, win).isFocused()).toBe(false);
  });

  it('notifies on blur', () => {
    const { doc, win, setFocus } = fakeDocWin({ visible: true, hasFocus: true });
    const signal = createPresenceFocusSignal(doc, win);
    const cb = vi.fn();
    signal.onChange(cb);
    setFocus(false);
    expect(cb).toHaveBeenCalledWith(false);
    expect(signal.isFocused()).toBe(false);
  });

  it('notifies on visibilitychange to hidden', () => {
    const { doc, win, setVisible } = fakeDocWin({ visible: true, hasFocus: true });
    const signal = createPresenceFocusSignal(doc, win);
    const cb = vi.fn();
    signal.onChange(cb);
    setVisible(false);
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('notifies on regaining focus', () => {
    const { doc, win, setFocus } = fakeDocWin({ visible: true, hasFocus: false });
    const signal = createPresenceFocusSignal(doc, win);
    const cb = vi.fn();
    signal.onChange(cb);
    setFocus(true);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('does not notify when a flip does not change the effective state', () => {
    const { doc, win, setVisible } = fakeDocWin({ visible: true, hasFocus: false });
    const signal = createPresenceFocusSignal(doc, win);
    const cb = vi.fn();
    signal.onChange(cb);
    setVisible(false); // was already unfocused (effectively not-focused); stays not-focused
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further notifications', () => {
    const { doc, win, setFocus } = fakeDocWin({ visible: true, hasFocus: true });
    const signal = createPresenceFocusSignal(doc, win);
    const cb = vi.fn();
    const unsubscribe = signal.onChange(cb);
    unsubscribe();
    setFocus(false);
    expect(cb).not.toHaveBeenCalled();
  });
});

/** A `FocusSignal` a test can flip by hand — same shape as `BoardPoller.test.ts`'s own fake. */
function fakeFocus(initial: boolean): {
  isFocused(): boolean;
  onChange(cb: (focused: boolean) => void): () => void;
  set(next: boolean): void;
} {
  let focused = initial;
  const listeners = new Set<(focused: boolean) => void>();
  return {
    isFocused: () => focused,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      if (next === focused) return;
      focused = next;
      for (const cb of listeners) cb(next);
    },
  };
}

function fakeWin(): { win: Window; firePageHide(): void } {
  const listeners = new Map<string, Set<() => void>>();
  const win = {
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.get(type)?.delete(cb);
    },
  } as unknown as Window;

  return {
    win,
    firePageHide() {
      for (const cb of listeners.get('pagehide') ?? []) cb();
    },
  };
}

function makeHeartbeat(
  overrides: Partial<PresenceHeartbeatDeps> & { focus?: ReturnType<typeof fakeFocus> } = {},
): {
  heartbeat: PresenceHeartbeat;
  fetchImpl: ReturnType<typeof vi.fn>;
  sendBeacon: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof fakeFocus>;
  firePageHide(): void;
} {
  const focus = overrides.focus ?? fakeFocus(false);
  const fetchImpl =
    (overrides.fetchImpl as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue({ ok: true });
  const sendBeacon =
    (overrides.sendBeacon as ReturnType<typeof vi.fn>) ?? vi.fn().mockReturnValue(true);
  const { win, firePageHide } = fakeWin();

  const deps: PresenceHeartbeatDeps = {
    apiBase: 'https://api.example.com',
    clientId: 'web-1',
    focus,
    getAccessToken: async () => 'token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sendBeacon: sendBeacon as unknown as PresenceHeartbeatDeps['sendBeacon'],
    win,
    ...overrides,
  };
  return { heartbeat: new PresenceHeartbeat(deps), fetchImpl, sendBeacon, focus, firePageHide };
}

describe('PresenceHeartbeat', () => {
  it('beats immediately when constructed already focused', async () => {
    const { fetchImpl } = makeHeartbeat({ focus: fakeFocus(true) });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/presence');
    expect(init.headers.authorization).toBe('Bearer token');
    expect(JSON.parse(init.body)).toEqual({ clientId: 'web-1', focused: true });
  });

  it('does not beat on construction when not yet focused', () => {
    const { fetchImpl } = makeHeartbeat({ focus: fakeFocus(false) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('beats on becoming focused', async () => {
    const { fetchImpl, focus } = makeHeartbeat({ focus: fakeFocus(false) });
    focus.set(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips the beat when signed out, without calling fetch', async () => {
    const { fetchImpl } = makeHeartbeat({
      focus: fakeFocus(true),
      getAccessToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('releases via sendBeacon on losing focus', () => {
    const { sendBeacon, focus } = makeHeartbeat({ focus: fakeFocus(true) });
    focus.set(false);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/presence');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
  });

  it('releases via sendBeacon on pagehide', () => {
    const { sendBeacon, firePageHide } = makeHeartbeat({ focus: fakeFocus(false) });
    firePageHide();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('stops beating and releasing once disposed', async () => {
    const { heartbeat, fetchImpl, sendBeacon, focus } = makeHeartbeat({ focus: fakeFocus(false) });
    heartbeat.dispose();
    focus.set(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    focus.set(false);
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
