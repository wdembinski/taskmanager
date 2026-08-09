import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { DevNoAuthGuard } from './devNoAuth.guard';
import { MirrorController } from './mirror.controller';
import { MirrorService } from './mirror.service';

@Module({
  imports: [TypeOrmModule.forFeature([Client, Command, ProjectMirror, TaskMirror])],
  controllers: [MirrorController],
  providers: [MirrorService, DevNoAuthGuard],
})
export class MirrorModule {}
