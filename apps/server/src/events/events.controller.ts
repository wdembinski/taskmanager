import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { EventBatchRequest, EventBatchResponse } from '@tm/protocol/wire';
import { EVENT_STREAM_LAST_ID_QUERY } from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { EventBus } from './eventBus';
import { openEventStream } from './sseStream';

/**
 * How large a `POST /v1/events` body this route accepts, independent of
 * `config/bodyLimit.ts`'s 8 MB backstop for `/v1/sync`.
 *
 * Small on purpose: a sync batch is rows a human's work produced, while an event batch is a
 * few seconds of an agent talking, and the forwarder already caps each payload at
 * `MAX_EVENT_BYTES` (32 KB). 256 KB is several full-size events, so a batch that reaches it is
 * one that should have been split — and the 413 says so in the one way the sender can act on:
 * `CloudPoller` halves its batch limit on a 413 and resets it on the next success, so this
 * route gets exactly the same self-correcting behaviour as `/v1/sync` for free.
 */
export const MAX_EVENT_BATCH_BYTES = 256 * 1024;

/**
 * What the sender actually put on the wire.
 *
 * `Content-Length` first, because that is precisely the number the sender controls and halves
 * against. Re-serializing is the fallback for a chunked request (no length header), and it is
 * only an approximation — the parsed body has lost whitespace and key order.
 */
export function eventBatchBytes(body: unknown, contentLength: string | undefined): number {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > 0) return declared;
  try {
    return Buffer.byteLength(JSON.stringify(body ?? null) ?? 'null', 'utf8');
  } catch {
    // A body JSON refuses to serialize came off a JSON parser, so this is unreachable —
    // but "unmeasurable" must not read as "zero bytes".
    return MAX_EVENT_BATCH_BYTES + 1;
  }
}

/** `Last-Event-ID` / `?lastEventId=` as a number, or `null` for anything that isn't one. */
export function parseLastEventId(...candidates: (string | undefined)[]): number | null {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim().length === 0) continue;
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * The push channel's two routes.
 *
 * `POST /v1/events` — a desktop Client handing over what its engine just emitted. **It never
 * writes to the database**: an event is a moment, not state, and the state behind it is
 * already mirrored by `/v1/sync` on its own schedule (see `eventBus.ts` for the full
 * argument). The response carries the listener count, so a Client learns its audience left
 * without waiting for the next sync.
 *
 * `GET /v1/events` — the stream itself, on a raw `@Res()` rather than Nest's `@Sse()`; see
 * `sseStream.ts` for the four things `@Sse()` cannot express.
 *
 * {@link IamAuthGuard} needs no change for either: it classifies by method, so the stream is a
 * `read` and the ingest a `write`, which is exactly right.
 */
@Controller('v1/events')
@UseGuards(IamAuthGuard)
export class EventsController {
  constructor(private readonly bus: EventBus) {}

  /**
   * 200, not the 201 Nest gives a POST by default and not the 202 `/v1/commands` uses: nothing
   * was created (this route stores nothing at all) and nothing was queued for later — the
   * events have already been handed to every listener by the time this returns.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  ingest(
    @AccountId() accountId: string,
    @Body() body: EventBatchRequest,
    @Headers('content-length') contentLength: string | undefined,
  ): EventBatchResponse {
    if (eventBatchBytes(body, contentLength) > MAX_EVENT_BATCH_BYTES) {
      throw new PayloadTooLargeException(
        `An event batch may be at most ${MAX_EVENT_BATCH_BYTES} bytes.`,
      );
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    this.bus.publish(accountId, events, body?.gap ?? 0);
    return { listeners: this.bus.listeners(accountId) };
  }

  /**
   * Returns nothing: the response is written frame by frame for as long as the connection
   * lives, and Nest must not try to send one of its own on top.
   *
   * `close` on the REQUEST is what says the browser went away — it fires for a navigation, a
   * closed tab and a dropped connection alike, and without it the heartbeat interval would
   * keep a dead stream's timers (and its subscription, and its queue) alive.
   */
  @Get()
  stream(
    @AccountId() accountId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Headers('last-event-id') headerId: string | undefined,
    @Query(EVENT_STREAM_LAST_ID_QUERY) queryId: string | undefined,
  ): void {
    const stream = openEventStream({
      // An express `Response` satisfies `SseSocket` structurally — no cast, and nothing in
      // there can reach for the rest of the response API behind Nest's back.
      socket: response,
      bus: this.bus,
      accountId,
      lastEventId: parseLastEventId(headerId, queryId),
    });
    request.on('close', () => stream.dispose());
  }
}
