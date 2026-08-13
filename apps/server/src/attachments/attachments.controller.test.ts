import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { CLOUD_BLOB_MAX_BYTES } from '@tm/shared/attachments';
import { MEDIA_TOKEN_QUERY } from '@tm/protocol/wire';
import { AttachmentsController } from './attachments.controller';
import type { AttachmentsService } from './attachments.service';
import { MediaTokenGuard } from './mediaToken.guard';
import { MediaTokenRegistry } from './mediaTokens';

/** An express `Request` as far as the raw-body reader is concerned. */
class FakeRequest extends EventEmitter {
  destroy(): this {
    return this;
  }
  /** Hands the whole body over on the next tick, so the route is already awaiting it. */
  send(body: Buffer): void {
    setImmediate(() => {
      this.emit('data', body);
      this.emit('end');
    });
  }
}

/** The bits of an express `Response` the two byte-serving routes touch. */
class FakeResponse {
  headers: Record<string, string> = {};
  body: Buffer | null = null;
  set(headers: Record<string, string>): this {
    Object.assign(this.headers, headers);
    return this;
  }
  end(body: Buffer): this {
    this.body = body;
    return this;
  }
}

function controllerWith(service: Partial<AttachmentsService>): {
  controller: AttachmentsController;
  tokens: MediaTokenRegistry;
} {
  const tokens = new MediaTokenRegistry();
  return {
    controller: new AttachmentsController(service as AttachmentsService, tokens),
    tokens,
  };
}

function request(fake: FakeRequest): Request {
  return fake as unknown as Request;
}

function response(fake: FakeResponse): Response {
  return fake as unknown as Response;
}

describe('AttachmentsController', () => {
  it('reads a raw body and hands the bytes to the service', async () => {
    const stored: Buffer[] = [];
    const { controller } = controllerWith({
      storeAttachment: async (_account, _id, bytes) => {
        stored.push(bytes);
        return { storedAt: 5, size: bytes.length };
      },
    });

    const req = new FakeRequest();
    const answer = controller.putAttachmentBlob(
      'account-1',
      'attachment-1',
      request(req),
      'shot.png',
      'image/png',
      '3',
    );
    req.send(Buffer.from('abc'));

    expect(await answer).toEqual({ storedAt: 5, size: 3 });
    expect(stored[0]?.toString()).toBe('abc');
  });

  it('refuses a body that declares itself over the cap without reading it', async () => {
    const { controller } = controllerWith({});
    const req = new FakeRequest();
    // Nothing is ever emitted: the rejection happens before a byte moves.
    await expect(
      controller.createUpload(
        'account-1',
        request(req),
        'huge.bin',
        undefined,
        String(CLOUD_BLOB_MAX_BYTES + 1),
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('refuses an empty upload — the shape a swallowed body arrives in', async () => {
    const { controller } = controllerWith({});
    const req = new FakeRequest();
    const answer = controller.createUpload('account-1', request(req), 'empty.png', undefined, '0');
    req.send(Buffer.alloc(0));
    await expect(answer).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops a MIME type that is not shaped like one, and keeps one that is', async () => {
    const seen: (string | null)[] = [];
    const { controller } = controllerWith({
      storeAttachment: async (_account, _id, bytes, meta) => {
        seen.push(meta.mimeType);
        return { storedAt: 1, size: bytes.length };
      },
    });

    for (const type of ['image/png', '<script>', 'image/svg+xml']) {
      const req = new FakeRequest();
      const answer = controller.putAttachmentBlob('a', 'b', request(req), 'f', type, undefined);
      req.send(Buffer.from('x'));
      await answer;
    }
    expect(seen).toEqual(['image/png', null, 'image/svg+xml']);
  });

  it('serves a blob with the headers its type earns', async () => {
    const { controller } = controllerWith({
      readAttachment: async () => ({
        bytes: Buffer.from('png'),
        mimeType: 'image/png',
        fileName: 'shot.png',
      }),
    });
    const res = new FakeResponse();
    await controller.readAttachmentBlob('account-1', 'attachment-1', response(res));

    expect(res.body?.toString()).toBe('png');
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toContain('inline');
  });

  it('is a 404, not a 403, for a blob this account may not read', async () => {
    // The service scopes by account and answers null either way — see its own docstring on
    // why "not yours" and "not here" must be the same answer.
    const { controller } = controllerWith({ readAttachment: async () => null });
    const res = new FakeResponse();
    await expect(
      controller.readAttachmentBlob('account-1', 'someone-elses', response(res)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mints a media token for the authenticated account', () => {
    const { controller, tokens } = controllerWith({});
    const grant = controller.mintMediaToken('account-1');
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(tokens.size()).toBe(1);
  });
});

describe('MediaTokenGuard', () => {
  function context(query: Record<string, unknown>): {
    ctx: ExecutionContext;
    request: { query: Record<string, unknown>; accountId?: string };
  } {
    const request = { query };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  }

  it('lets a minted token through and names the account it speaks for', () => {
    const tokens = new MediaTokenRegistry();
    const guard = new MediaTokenGuard(tokens);
    const { token } = tokens.issue('account-1');

    const { ctx, request } = context({ [MEDIA_TOKEN_QUERY]: token });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(request.accountId).toBe('account-1');
  });

  it('refuses a request with no token at all', () => {
    const guard = new MediaTokenGuard(new MediaTokenRegistry());
    expect(() => guard.canActivate(context({}).ctx)).toThrow(UnauthorizedException);
  });

  it('refuses a made-up token', () => {
    const guard = new MediaTokenGuard(new MediaTokenRegistry());
    expect(() => guard.canActivate(context({ [MEDIA_TOKEN_QUERY]: 'nope' }).ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('never falls back to a bearer — this guard reads the query and nothing else', () => {
    const tokens = new MediaTokenRegistry();
    const guard = new MediaTokenGuard(tokens);
    const { ctx } = context({});
    (ctx.switchToHttp().getRequest() as { headers?: unknown }).headers = {
      authorization: 'Bearer a-perfectly-good-token',
    };
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
