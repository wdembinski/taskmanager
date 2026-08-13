import { EventEmitter } from 'node:events';
import { PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { declaredTooLarge, readRawBody, type RawBodyStream } from './rawBody';

/** An express `Request`'s two relevant halves: it emits, and it can be destroyed. */
class FakeStream extends EventEmitter implements RawBodyStream {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

describe('readRawBody', () => {
  it('collects the whole body', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 100);
    stream.emit('data', Buffer.from('abc'));
    stream.emit('data', Buffer.from('def'));
    stream.emit('end');
    expect((await body).toString()).toBe('abcdef');
  });

  it('is an empty buffer for an empty body, not a failure', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 100);
    stream.emit('end');
    expect(await body).toEqual(Buffer.alloc(0));
  });

  it('destroys the socket the moment the count passes the limit', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 4);
    stream.emit('data', Buffer.from('abc'));
    stream.emit('data', Buffer.from('de'));

    await expect(body).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(stream.destroyed).toBe(true);
  });

  it('refuses a body that lies about its length — the counter, not the header', async () => {
    // Content-Length said 2; the sender streams far more. Nothing above ever reads the
    // header, which is exactly why this is caught at all.
    expect(declaredTooLarge('2', 4)).toBe(false);
    const stream = new FakeStream();
    const body = readRawBody(stream, 4);
    stream.emit('data', Buffer.alloc(4096));
    await expect(body).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('ignores anything that arrives after it has given up', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 2);
    stream.emit('data', Buffer.from('abcd'));
    await expect(body).rejects.toBeInstanceOf(PayloadTooLargeException);
    // A settled promise must not be resolved by a late `end` — this would throw
    // "resolve after reject" nowhere, it would simply be a silently wrong body.
    expect(() => stream.emit('end')).not.toThrow();
  });

  it('rejects when the connection dies mid-upload rather than hanging forever', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 100);
    stream.emit('data', Buffer.from('ab'));
    stream.emit('aborted');
    await expect(body).rejects.toThrow(/aborted/);
  });

  it('propagates a stream error', async () => {
    const stream = new FakeStream();
    const body = readRawBody(stream, 100);
    stream.emit('error', new Error('ECONNRESET'));
    await expect(body).rejects.toThrow('ECONNRESET');
  });
});

describe('declaredTooLarge', () => {
  it('rejects a length already over the limit', () => {
    expect(declaredTooLarge('101', 100)).toBe(true);
  });

  it('lets everything else through to the counter', () => {
    expect(declaredTooLarge('100', 100)).toBe(false);
    expect(declaredTooLarge(undefined, 100)).toBe(false);
    expect(declaredTooLarge('chunked', 100)).toBe(false);
  });
});
