import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildMssqlConnectionOptions } from './database/typeormOptions';
import { Account } from './entities/account.entity';
import { AgentProfile } from './entities/agentProfile.entity';
import { Assignment } from './entities/assignment.entity';
import { AttachmentBlob } from './entities/attachmentBlob.entity';
import { AttachmentUpload } from './entities/attachmentUpload.entity';
import { Client } from './entities/client.entity';
import { Command } from './entities/command.entity';
import { CommandResultRow } from './entities/commandResult.entity';
import { Tombstone } from './entities/tombstone.entity';
import { ProjectMirror } from './entities/projectMirror.entity';
import { TaskMirror } from './entities/taskMirror.entity';
import { AgentsModule } from './agents/agents.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { MirrorModule } from './mirror/mirror.module';
import { PresenceModule } from './presence/presence.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [
    // `forRootAsync` + `useFactory`, NOT `forRoot`, and the difference is not stylistic.
    //
    // A `forRoot({...})` argument is part of the `@Module` decorator's object literal, which
    // JavaScript evaluates when this file is IMPORTED — at the top of `main.ts`, before
    // `bootstrap()` has run and therefore before `loadSecretsFromKeyVault()` has put
    // `DB_PASSWORD` into `process.env`. The pool was built with the local-dev fallback
    // password, Azure SQL refused the login, and the container crash-looped on every probe
    // with `connection refused`. Nothing catches it locally, where the real value is already
    // in the environment before import — it needs a deployment that fetches a secret at
    // startup, which is exactly the case no test covers.
    //
    // A factory runs during module initialisation, i.e. inside `NestFactory.create`, which
    // is after `bootstrap()` has awaited its secrets. Anything reading `process.env` for
    // configuration belongs in here, not in the literal.
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildMssqlConnectionOptions(),
        entities: [
          Account,
          AgentProfile,
          Assignment,
          AttachmentBlob,
          AttachmentUpload,
          Client,
          Command,
          CommandResultRow,
          ProjectMirror,
          TaskMirror,
          Tombstone,
        ],
        // Migrations, not synchronize — see database/dataSource.ts.
        synchronize: false,
        logging: process.env.NODE_ENV === 'development',
      }),
    }),
    HealthModule,
    PresenceModule,
    EventsModule,
    MirrorModule,
    AttachmentsModule,
    TicketsModule,
    AgentsModule,
  ],
})
export class AppModule {}
