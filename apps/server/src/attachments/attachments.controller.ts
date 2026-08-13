import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOUD_BLOB_MAX_BYTES } from '@tm/shared/attachments';
import {
  BLOB_NAME_HEADER,
  BLOB_NAME_QUERY,
  BLOB_TYPE_QUERY,
  type BlobStored,
  type MediaTokenGrant,
  type UploadTicket,
} from '@tm/protocol/wire';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { AttachmentsService } from './attachments.service';
import { FALLBACK_MIME_TYPE, mediaHeaders } from './attachmentHeaders';
import { MediaTokenGuard } from './mediaToken.guard';
import { MediaTokenRegistry } from './mediaTokens';
import { declaredTooLarge, readRawBody } from './rawBody';

/**
 * The blob routes — see `@tm/protocol/wire`'s own block on what each one is for.
 *
 * TWO THINGS HERE ARE NOT LIKE THE REST OF THE API
 * ------------------------------------------------
 * **The bodies are raw.** No `@Body()`, no DTO, no multer: `main.ts` registers only a JSON
 * body parser, so an `application/octet-stream` request arrives with its body unread and
 * `readRawBody` consumes it under a byte counter. That is a property of the current wiring
 * and `rawBody.ts` says at length what would break it — a global body parser added later
 * would eat the stream and store an empty file, silently. **Do not add one.**
 *
 * **One route is guarded differently.** `GET /v1/attachments/:id` takes a media token in the
 * query rather than a bearer in a header, because its reader is an `<img>` tag, which sets no
 * headers. Guards are therefore declared per method rather than on the controller: a
 * controller-level `@UseGuards(IamAuthGuard)` would look like it covered everything while
 * that one route quietly needed the other guard, which is exactly the sort of thing nobody
 * notices in a diff.
 */
@Controller('v1')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly mediaTokens: MediaTokenRegistry,
  ) {}

  /**
   * Mint a `media:read` ticket for this account — what a browser calls once and then puts in
   * every `<img src>` until it expires.
   *
   * A POST because it creates something, and guarded by the ordinary bearer guard: the whole
   * chain is "prove who you are with a header on a request JavaScript makes, then use the
   * result on requests it cannot put headers on".
   */
  @Post('media-tokens')
  @HttpCode(HttpStatus.OK)
  @UseGuards(IamAuthGuard)
  mintMediaToken(@AccountId() accountId: string): MediaTokenGrant {
    return this.mediaTokens.issue(accountId);
  }

  /** A browser parking a picked file until the desktop can collect it. */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(IamAuthGuard)
  async createUpload(
    @AccountId() accountId: string,
    @Req() request: Request,
    @Query(BLOB_NAME_QUERY) fileName: string | undefined,
    @Query(BLOB_TYPE_QUERY) mimeType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<UploadTicket> {
    const bytes = await this.readBody(request, contentLength);
    // An empty body is a bug at the other end (or a body somebody else's middleware ate —
    // see `rawBody.ts`), never a file worth parking.
    if (bytes.length === 0) throw new BadRequestException('An upload cannot be empty.');
    return this.attachments.createUpload(accountId, bytes, {
      fileName: cleanFileName(fileName) ?? 'file',
      mimeType: cleanMimeType(mimeType),
    });
  }

  /**
   * The desktop collecting those bytes. Answers the file itself, with its name in a header —
   * a raw body has nowhere else to carry one.
   *
   * `Content-Disposition: attachment` and `nosniff` here too, even though the reader is
   * Node's `fetch` and not a browser: the URL is guessable-ish and guarded, but a route that
   * hands back arbitrary bytes should never be one navigation away from being rendered.
   */
  @Get('uploads/:id')
  @UseGuards(IamAuthGuard)
  async readUpload(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const upload = await this.attachments.readUpload(accountId, id);
    if (!upload) throw new NotFoundException('No such upload.');

    response.set({
      'Content-Type': upload.mimeType ?? FALLBACK_MIME_TYPE,
      'Content-Length': String(upload.bytes.length),
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
      // Never cached: a ticket is claimed once and reclaimed shortly after.
      'Cache-Control': 'no-store',
      // Percent-encoded, because a header is latin-1 and a file name is whatever the human
      // called it. The desktop decodes it — see `BLOB_NAME_HEADER` on the wire.
      [BLOB_NAME_HEADER]: encodeURIComponent(upload.fileName),
    });
    response.end(upload.bytes);
  }

  /** The desktop pushing an attachment's bytes up, so a browser can look at them. */
  @Put('attachments/:id/blob')
  @UseGuards(IamAuthGuard)
  async putAttachmentBlob(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Req() request: Request,
    @Query(BLOB_NAME_QUERY) fileName: string | undefined,
    @Query(BLOB_TYPE_QUERY) mimeType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<BlobStored> {
    const bytes = await this.readBody(request, contentLength);
    return this.attachments.storeAttachment(accountId, id, bytes, {
      fileName: cleanFileName(fileName),
      mimeType: cleanMimeType(mimeType),
    });
  }

  /**
   * The picture itself. The one route a media token authorises.
   *
   * A raw `@Res()` because the response is bytes with hand-picked headers, not a value for
   * Nest to serialize — and every one of those headers is a decision, made and tested in
   * `attachmentHeaders.ts`.
   */
  @Get('attachments/:id')
  @UseGuards(MediaTokenGuard)
  async readAttachmentBlob(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const blob = await this.attachments.readAttachment(accountId, id);
    // Not "forbidden": an id this account may not read and an id nobody has are the same
    // answer, and distinguishing them would confirm the id exists.
    if (!blob) throw new NotFoundException('No such attachment.');

    response.set({
      ...mediaHeaders(blob.mimeType, blob.fileName),
      'Content-Length': String(blob.bytes.length),
    });
    response.end(blob.bytes);
  }

  /** The bytes are gone locally (or should be up here) — drop the cloud copy. */
  @Delete('attachments/:id/blob')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(IamAuthGuard)
  async deleteAttachmentBlob(
    @AccountId() accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.attachments.removeAttachment(accountId, id);
  }

  /**
   * Read an upload's body under the cap.
   *
   * The declared length is checked first purely to save the transfer; the counter inside
   * `readRawBody` is what actually enforces the limit, because a header is what the sender
   * SAYS and the counter is what it does.
   */
  private readBody(request: Request, contentLength: string | undefined): Promise<Buffer> {
    if (declaredTooLarge(contentLength, CLOUD_BLOB_MAX_BYTES)) {
      throw new PayloadTooLargeException(
        `An attachment may be at most ${CLOUD_BLOB_MAX_BYTES} bytes in the cloud.`,
      );
    }
    return readRawBody(request, CLOUD_BLOB_MAX_BYTES);
  }
}

/** A caller-supplied name, trimmed to what a column and a header can hold. Null for nothing. */
function cleanFileName(value: string | undefined): string | null {
  // Control characters are stripped rather than escaped: this value ends up in a
  // `Content-Disposition`, and `attachmentHeaders.ts` quotes it, but the row should not be
  // carrying a newline in the first place.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go.
  const cleaned = (value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : null;
}

/** A caller-supplied MIME type, or null for anything that is not shaped like one. */
function cleanMimeType(value: string | undefined): string | null {
  const cleaned = (value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(cleaned)
    ? cleaned.slice(0, 128)
    : null;
}
