import { Module } from '@nestjs/common';
import { IamModule } from '../iam/iam.module';
import { PresenceController } from './presence.controller';
import { PresenceRegistry } from './presence.registry';
import { PresenceService } from './presence.service';

@Module({
  imports: [IamModule],
  controllers: [PresenceController],
  providers: [PresenceRegistry, PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
