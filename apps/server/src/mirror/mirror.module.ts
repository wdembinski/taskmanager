import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { SettingsMirror } from '../entities/settingsMirror.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { EventsModule } from '../events/events.module';
import { IamModule } from '../iam/iam.module';
import { PresenceModule } from '../presence/presence.module';
import { MirrorController } from './mirror.controller';
import { MirrorService } from './mirror.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Client,
      Command,
      CommandResultRow,
      ProjectMirror,
      SettingsMirror,
      TaskMirror,
      Tombstone,
    ]),
    PresenceModule,
    IamModule,
    // For `EventBus` alone — `SyncResponse.eventListeners` is how a desktop learns whether
    // forwarding its engine's events to the cloud is worth the bytes.
    EventsModule,
  ],
  controllers: [MirrorController],
  providers: [MirrorService],
})
export class MirrorModule {}
