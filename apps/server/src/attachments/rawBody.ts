import { PayloadTooLargeException } from '@nestjs/common';

/**
 * Read an upload's body off the wire, refusing anything over `limit`.
 *
 * WHY THERE IS NO PARSER HERE, AND WHY THAT IS FRAGILE
 * ----------------------------------------------------
 * `main.ts` creates the app with `bodyParser: false` and then registers exactly one parser —
 * `app.useBodyParser('json', …)`, which only touches requests whose `Content-Type` is JSON.
 * An `application/octet-stream` request therefore reaches the controller **unread**, and its
 * body is still sitting in the socket for this function to consume. No multer, no
 * `express.raw()`, no third dependency to hold a file in a temp directory somewhere.
 *
 * That is a property of the current wiring, not a guarantee of the framework. Add a GLOBAL
 * body parser later — `app.use(express.raw())`, `express.text()`, anything with no type
 * filter — and it will consume this stream before the route runs; the request will not fail,
 * it will simply arrive with zero bytes and a stored blob will be empty. There is a matching
 * comment in `main.ts`, because that is where the mistake would be made.
 *
 * WHY A COUNTER AND NOT `Content-Length`
 * --------------------------------------
 * A header is what the sender SAYS. The cap has to be what the sender DOES, so this counts
 * chunks as they arrive and stops the moment the count passes the limit — a client that
 * declares 1 KB and streams a gigabyte gets one chunk past the line, not a gigabyte. The
 * socket is destroyed rather than merely left unread, because a request whose body nobody
 * finishes reading keeps the connection (and its buffers) alive until it times out, and
 * "refuse politely and hold the resource anyway" is not a refusal.
 *
 * A `Content-Length` that is already over the limit is still worth rejecting first (below) —
 * it is free, and it saves transferring a body that was never going to be accepted.
 */

/**
 * The bit of an express `Request` this needs. Structural, so the tests drive it with a plain
 * emitter and no HTTP server — and narrow, so nothing in here can reach for the rest of the
 * request behind the route's back.
 */
export interface RawBodyStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'aborted', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(error?: Error): unknown;
}

export function readRawBody(stream: RawBodyStream, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > limit) {
        // Destroy first, reject second: a client that keeps sending must stop being listened
        // to before anything else happens, whatever the caller does with the exception.
        stream.destroy();
        finish(() =>
          reject(new PayloadTooLargeException(`An upload may be at most ${limit} bytes.`)),
        );
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', () => finish(() => resolve(Buffer.concat(chunks))));

    // Both halves of "it did not finish": an error on the stream, and a connection that
    // simply went away. Without the second, a dropped upload leaves this promise pending
    // forever and the request handler with it.
    stream.on('error', (error: Error) => finish(() => reject(error)));
    stream.on('aborted', () => finish(() => reject(new Error('The upload was aborted.'))));
  });
}

/**
 * Whether a declared `Content-Length` is already over the limit — a free rejection before a
 * single byte moves. Absent, malformed or lying lengths all fall through to the counter
 * above, which is the check that actually enforces the cap.
 */
export function declaredTooLarge(contentLength: string | undefined, limit: number): boolean {
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > limit;
}
