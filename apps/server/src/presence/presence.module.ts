import { Module } from '@nestjs/common';
import { DevNoAuthGuard } from '../mirror/devNoAuth.guard';
import { PresenceController } from './presence.controller';
import { PresenceRegistry } from './presence.registry';
import { PresenceService } from './presence.service';

@Module({
  controllers: [PresenceController],
  providers: [PresenceRegistry, PresenceService, DevNoAuthGuard],
  exports: [PresenceService],
})
export class PresenceModule {}
