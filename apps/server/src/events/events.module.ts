import { Module } from '@nestjs/common';
import { IamModule } from '../iam/iam.module';
import { EventsController } from './events.controller';
import { EventBus } from './eventBus';

/**
 * The push channel. `IamModule` for the guard on both routes (see its own note on why the
 * token is exported alongside the guard class), and no `TypeOrmModule.forFeature` at all —
 * this module owns no entity and writes no row, which is the property `eventBus.ts` argues for
 * and the reason `app.module.test.ts`'s entity count does not move.
 *
 * {@link EventBus} is exported because `MirrorService` reads its listener count to fill
 * `SyncResponse.eventListeners`.
 */
@Module({
  imports: [IamModule],
  controllers: [EventsController],
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
