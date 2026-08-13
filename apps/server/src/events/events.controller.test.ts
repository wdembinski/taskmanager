import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { EventBatchRequest, EventEnvelope } from '@tm/protocol/wire';
import { EVENT_STREAM_FRAMES } from '@tm/protocol/wire';
import { EventBus } from './eventBus';
import {
  eventBatchBytes,
  EventsController,
  MAX_EVENT_BATCH_BYTES,
  parseLastEventId,
} from './events.controller';

function envelope(seq: number, channel = 'session:event'): EventEnvelope {
  return { channel, payload: { line: `line ${seq}` }, at: seq, seq };
}

function batch(events: EventEnvelope[], gap?: number): EventBatchRequest {
  const body: EventBatchRequest = { clientId: 'client-1', events };
  if (gap !== undefined) body.gap = gap;
  return body;
}

describe('eventBatchBytes', () => {
  it('trusts Content-Length — the number the sender actually halves against', () => {
    expect(eventBatchBytes({ events: [] }, '4096')).toBe(4096);
  });

  it('falls back to the body for a request that declared no length', () => {
    expect(eventBatchBytes({ a: 'bcd' }, undefined)).toBe(JSON.stringify({ a: 'bcd' }).length);
    expect(eventBatchBytes({ a: 'bcd' }, 'not-a-number')).toBeGreaterThan(0);
  });
});

describe('parseLastEventId', () => {
  it('prefers the header, then the query', () => {
    expect(parseLastEventId('7', '9')).toBe(7);
    expect(parseLastEventId(undefined, '9')).toBe(9);
    expect(parseLastEventId('', '9')).toBe(9);
  });

  it('is null for anything that is not a position', () => {
    expect(parseLastEventId(undefined, undefined)).toBeNull();
    expect(parseLastEventId('nonsense')).toBeNull();
    expect(parseLastEventId('-1')).toBeNull();
    expect(parseLastEventId('1.5')).toBeNull();
  });
});

describe('EventsController', () => {
  let bus: EventBus;
  let controller: EventsController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    bus = new EventBus();
    controller = new EventsController(bus);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('POST /v1/events', () => {
    it('hands the batch to whoever is watching and reports the audience', () => {
      const subscription = bus.subscribe('account-a', null);

      const response = controller.ingest('account-a', batch([envelope(1)]), '100');

      expect(response).toEqual({ listeners: 1 });
      expect(subscription.drain().events.map((e) => e.envelope.seq)).toEqual([1]);
    });

    it("passes on the sender's own admitted gap", () => {
      const subscription = bus.subscribe('account-a', null);

      controller.ingest('account-a', batch([envelope(1)], 3), '100');

      expect(subscription.drain().gap).toEqual({ reason: 'sender', count: 3 });
    });

    it('reports nobody watching rather than failing when no browser is open', () => {
      expect(controller.ingest('account-a', batch([envelope(1)]), '100')).toEqual({
        listeners: 0,
      });
    });

    it('refuses a batch over the cap, so the sender halves and tries again', () => {
      expect(() =>
        controller.ingest('account-a', batch([envelope(1)]), String(MAX_EVENT_BATCH_BYTES + 1)),
      ).toThrow(PayloadTooLargeException);
    });

    it('refuses one over the cap even with no Content-Length to go on', () => {
      const huge = batch([
        { ...envelope(1), payload: { blob: 'x'.repeat(MAX_EVENT_BATCH_BYTES) } },
      ]);

      expect(() => controller.ingest('account-a', huge, undefined)).toThrow(
        PayloadTooLargeException,
      );
    });

    it('takes a body with no events at all — a Client may be asking only for the count', () => {
      expect(controller.ingest('account-a', { clientId: 'c' } as EventBatchRequest, '20')).toEqual({
        listeners: 0,
      });
    });
  });

  describe('GET /v1/events', () => {
    /** The two express objects the route touches, and nothing else. */
    function fakeExchange() {
      const chunks: string[] = [];
      let ended = false;
      let onClose: (() => void) | null = null;
      const response = {
        writeHead: () => undefined,
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
        once: () => undefined,
        end: () => {
          ended = true;
        },
      } as unknown as Response;
      const request = {
        on: (event: string, listener: () => void) => {
          if (event === 'close') onClose = listener;
        },
      } as unknown as Request;
      return { request, response, chunks, hangUp: () => onClose?.(), isEnded: () => ended };
    }

    it('opens a stream that resumes from the header and starts with a hello', () => {
      bus.publish('account-a', [envelope(1), envelope(2)]);
      const exchange = fakeExchange();

      controller.stream('account-a', exchange.request, exchange.response, '1', undefined);

      expect(exchange.chunks[1]).toContain(`event: ${EVENT_STREAM_FRAMES.hello}`);
      expect(exchange.chunks[1]).toContain('"resumed":true');
      expect(exchange.chunks[2]).toContain(`event: ${EVENT_STREAM_FRAMES.event}`);
      expect(bus.listeners('account-a')).toBe(1);
    });

    it('resumes from the query string too, for a reader that cannot set a header', () => {
      bus.publish('account-a', [envelope(1)]);
      const exchange = fakeExchange();

      controller.stream('account-a', exchange.request, exchange.response, undefined, '1');

      expect(exchange.chunks[1]).toContain('"resumed":true');
    });

    it('releases the subscription when the browser goes away', () => {
      const exchange = fakeExchange();
      controller.stream('account-a', exchange.request, exchange.response, undefined, undefined);

      exchange.hangUp();

      vi.advanceTimersByTime(60_000);
      expect(bus.listeners('account-a')).toBe(0);
    });
  });
});
