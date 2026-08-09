import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { IamModule } from '../iam/iam.module';
import { PresenceModule } from '../presence/presence.module';
import { MirrorController } from './mirror.controller';
import { MirrorService } from './mirror.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Client, Command, ProjectMirror, TaskMirror]),
    PresenceModule,
    IamModule,
  ],
  controllers: [MirrorController],
  providers: [MirrorService],
})
export class MirrorModule {}
