import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { IamModule } from '../iam/iam.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectMirror, TaskMirror]), IamModule],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
