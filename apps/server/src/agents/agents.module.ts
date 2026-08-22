import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentProfile } from '../entities/agentProfile.entity';
import { Assignment } from '../entities/assignment.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { IamModule } from '../iam/iam.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [TypeOrmModule.forFeature([AgentProfile, Assignment, TaskMirror]), IamModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
