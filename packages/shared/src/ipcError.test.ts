import { describe, expect, it } from 'vitest';
import { ipcErrorMessage } from './ipcError';

describe('ipcErrorMessage', () => {
  /**
   * The reported string, verbatim. What the human needs is the last clause; what they were
   * shown started with the channel name.
   */
  it('unwraps what Electron wrapped', () => {
    const err = new Error(
      "Error invoking remote method 'task:run': Error: Claude is signed out, so nothing can run.",
    );
    expect(ipcErrorMessage(err)).toBe('Claude is signed out, so nothing can run.');
  });

  it('strips whichever error class was re-thrown', () => {
    const err = new Error("Error invoking remote method 'jira:test': TypeError: fetch failed");
    expect(ipcErrorMessage(err)).toBe('fetch failed');
  });

  /** A channel with no message behind it: the wrapper is all there is, so keep it. */
  it('keeps the wrapper when unwrapping would leave nothing', () => {
    const err = new Error("Error invoking remote method 'task:run': Error: ");
    expect(ipcErrorMessage(err)).toBe("Error invoking remote method 'task:run': Error: ");
  });

  it('leaves an ordinary error alone', () => {
    expect(ipcErrorMessage(new Error('Task not found.'))).toBe('Task not found.');
  });

  /**
   * The class-name strip must not reach outside the wrapper: a handler quoting an error
   * class in its own sentence keeps every word of it.
   */
  it('does not strip a class name from an unwrapped message', () => {
    expect(ipcErrorMessage(new Error('TypeError: the plan file is not text'))).toBe(
      'TypeError: the plan file is not text',
    );
  });

  it('survives a rejection that is not an Error', () => {
    expect(ipcErrorMessage('nope')).toBe('nope');
    expect(ipcErrorMessage(undefined)).toBe('undefined');
  });
});
