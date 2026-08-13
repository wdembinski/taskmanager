import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentBlob } from '../entities/attachmentBlob.entity';
import { AttachmentUpload } from '../entities/attachmentUpload.entity';
import { IamModule } from '../iam/iam.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { BLOB_STORE } from './blobStore';
import { MediaTokenGuard } from './mediaToken.guard';
import { MediaTokenRegistry } from './mediaTokens';
import { SqlBlobStore } from './sqlBlobStore';

/**
 * The blob tier. `IamModule` for the bearer guard on four of the six routes (see its own note
 * on why the IAM token is exported alongside the guard class), and `MediaTokenGuard` provided
 * here because it belongs to the one route that uses it and to nothing else.
 *
 * **`BLOB_STORE` is the seam.** Swapping the default SQL tier for Azure Blob storage is this
 * one binding — `useClass: AzureBlobStore` — plus that class and its connection string.
 * Nothing else in the module, the service, the routes or the quota changes, which is the
 * whole reason the port exists rather than the service reaching for a column directly.
 *
 * `MediaTokenRegistry` is a singleton in this module and therefore per-process, like
 * `PresenceRegistry` and the guard's auth caches — one more reason the service runs on a
 * single replica (docs/09-deploying-the-cloud-service.md).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AttachmentBlob, AttachmentUpload]), IamModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    MediaTokenRegistry,
    MediaTokenGuard,
    { provide: BLOB_STORE, useClass: SqlBlobStore },
  ],
})
export class AttachmentsModule {}
