import { Module } from '@nestjs/common';
import { IamModule } from '../iam/iam.module';
import { TokensController } from './tokens.controller';

/**
 * The web app's Personal access tokens page. `IamModule` for `IamAuthGuard`,
 * `InteractiveAuthGuard` and `PatService` — all three are exported from there (see its own
 * note on why exporting only the guard class is not enough), so nothing is provided here.
 */
@Module({
  imports: [IamModule],
  controllers: [TokensController],
})
export class TokensModule {}
