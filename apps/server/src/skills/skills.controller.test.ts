import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import type { Skill } from '@tm/shared/skills';
import { SKILL_BODY_MAX } from '@tm/shared/skills';
import { SkillMirror } from '../entities/skillMirror.entity';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/** The same hand-rolled `DataSource`/`Repository` stand-in `agents.controller.test.ts` uses. */
class FakeMirrorDb {
  skills = new Map<string, SkillMirror>();

  private key(row: { accountId: string; id: string }): string {
    return `${row.accountId}:${row.id}`;
  }

  private matches(where: Record<string, unknown>) {
    return (row: unknown): boolean =>
      Object.entries(where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      );
  }

  manager = {
    upsert: async (
      _entity: unknown,
      rows: Record<string, unknown> | Record<string, unknown>[],
      _conflict: string[],
    ) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        this.skills.set(this.key(row as { accountId: string; id: string }), row as never);
      }
    },
  };

  dataSource = { manager: this.manager } as unknown as DataSource;

  repo(): Repository<SkillMirror> {
    return {
      find: async (opts: { where: Record<string, unknown> }) =>
        [...this.skills.values()].filter(this.matches(opts.where)),
      findOne: async (opts: { where: Record<string, unknown> }) =>
        [...this.skills.values()].find(this.matches(opts.where)) ?? null,
    } as unknown as Repository<SkillMirror>;
  }
}

function buildController(): { controller: SkillsController; db: FakeMirrorDb } {
  const db = new FakeMirrorDb();
  const service = new SkillsService(db.dataSource, db.repo());
  return { controller: new SkillsController(service), db };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: 'tdd',
    description: 'Write the test first',
    body: 'Body text.',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('SkillsController', () => {
  let controller: SkillsController;
  let db: FakeMirrorDb;

  beforeEach(() => {
    ({ controller, db } = buildController());
  });

  it('is guarded like every other /v1/* route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SkillsController)).toBeDefined();
  });

  it('round trips a skill through PUT then GET', async () => {
    const skill = makeSkill();
    const put = await controller.put('acct-1', skill.id, skill);
    expect(put).toEqual(skill);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ skills: [skill], deletedSkillIds: [] });
  });

  it('accepts a body of exactly SKILL_BODY_MAX bytes', async () => {
    const skill = makeSkill({ body: 'a'.repeat(SKILL_BODY_MAX) });
    await expect(controller.put('acct-1', skill.id, skill)).resolves.toEqual(skill);
  });

  it('refuses a body one byte over SKILL_BODY_MAX with the shared sentence', async () => {
    const skill = makeSkill({ body: 'a'.repeat(SKILL_BODY_MAX + 1) });
    await expect(controller.put('acct-1', skill.id, skill)).rejects.toThrow(
      PayloadTooLargeException,
    );
    await expect(controller.put('acct-1', skill.id, skill)).rejects.toThrow(
      'too large to sync (65 KiB > 64 KiB)',
    );
  });

  it('counts a multibyte body in bytes, not characters', async () => {
    // 22000 copies of a 3-byte character is 66000 bytes but only 22000 UTF-16 code units —
    // under budget by `.length`, over it by the bytes `skillBodyBytes` actually counts.
    const body = '中'.repeat(22000);
    expect(body.length).toBeLessThan(SKILL_BODY_MAX);
    const skill = makeSkill({ body });
    await expect(controller.put('acct-1', skill.id, skill)).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('refuses a body whose id does not match the path', async () => {
    const skill = makeSkill({ id: 'skill-1' });
    await expect(controller.put('acct-1', 'skill-2', skill)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an invalid skill name', async () => {
    const skill = makeSkill({ name: 'Not Valid' });
    await expect(controller.put('acct-1', skill.id, skill)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a malformed body', async () => {
    await expect(controller.put('acct-1', 'skill-1', { id: 'skill-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a skill: it drops out of skills and lists in deletedSkillIds', async () => {
    const skill = makeSkill();
    await controller.put('acct-1', skill.id, skill);

    await controller.remove('acct-1', skill.id);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ skills: [], deletedSkillIds: [skill.id] });
  });

  it('records a tombstone for an id it never saw a PUT for', async () => {
    await controller.remove('acct-1', 'never-seen');

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ skills: [], deletedSkillIds: ['never-seen'] });
  });

  it('is idempotent to delete twice', async () => {
    const skill = makeSkill();
    await controller.put('acct-1', skill.id, skill);
    await controller.remove('acct-1', skill.id);
    await expect(controller.remove('acct-1', skill.id)).resolves.toBeUndefined();

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ skills: [], deletedSkillIds: [skill.id] });
  });

  it('revives a deleted skill on PUT', async () => {
    const skill = makeSkill();
    await controller.put('acct-1', skill.id, skill);
    await controller.remove('acct-1', skill.id);

    const revived = { ...skill, body: 'New body.', updatedAt: 2000 };
    await controller.put('acct-1', skill.id, revived);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ skills: [revived], deletedSkillIds: [] });
  });

  it('keeps accounts isolated: account B cannot see or overwrite account A’s skill', async () => {
    const skill = makeSkill();
    await controller.put('acct-1', skill.id, skill);

    const listedByB = await controller.list('acct-2');
    expect(listedByB).toEqual({ skills: [], deletedSkillIds: [] });

    const hijack = { ...skill, body: 'Hijacked.' };
    await controller.put('acct-2', skill.id, hijack);

    const listedByA = await controller.list('acct-1');
    expect(listedByA.skills).toEqual([skill]);
    const listedByBAfter = await controller.list('acct-2');
    expect(listedByBAfter.skills).toEqual([hijack]);
  });
});
