import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { MirrorController } from '../mirror/mirror.controller';
import { PresenceController } from '../presence/presence.controller';

describe('HealthController', () => {
  it('answers without touching anything', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok' });
  });

  it('carries no guard, so a probe is not answered with 401', () => {
    // This is the whole reason the controller exists separately. Both other controllers
    // are guarded — asserted here too, so this test fails if someone "tidies up" by
    // applying the guard globally and silently breaks every liveness probe.
    expect(Reflect.getMetadata(GUARDS_METADATA, HealthController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, MirrorController)).toBeDefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, PresenceController)).toBeDefined();
  });

  it('sits outside /v1, which is the versioned wire contract', () => {
    // The probe URL is baked into infrastructure (a Container Apps liveness probe), so it
    // must not move when the API version does.
    expect(Reflect.getMetadata('path', HealthController)).toBe('health');
  });
});
