import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SkillMirror } from '../entities/skillMirror.entity';
import { IamModule } from '../iam/iam.module';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

@Module({
  imports: [TypeOrmModule.forFeature([SkillMirror]), IamModule],
  controllers: [SkillsController],
  providers: [SkillsService],
})
export class SkillsModule {}
