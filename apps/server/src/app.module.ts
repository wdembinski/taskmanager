import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildMssqlConnectionOptions } from './database/typeormOptions';
import { Account } from './entities/account.entity';
import { Client } from './entities/client.entity';
import { Command } from './entities/command.entity';
import { ProjectMirror } from './entities/projectMirror.entity';
import { TaskMirror } from './entities/taskMirror.entity';
import { HealthModule } from './health/health.module';
import { MirrorModule } from './mirror/mirror.module';
import { PresenceModule } from './presence/presence.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...buildMssqlConnectionOptions(),
      entities: [Account, Client, Command, ProjectMirror, TaskMirror],
      // Migrations, not synchronize — see database/dataSource.ts.
      synchronize: false,
      logging: process.env.NODE_ENV === 'development',
    }),
    HealthModule,
    PresenceModule,
    MirrorModule,
  ],
})
export class AppModule {}
