import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Deliberately imports nothing — see {@link HealthController} on why the probe is
 *  unguarded and touches no database. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
