import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Skill } from '@tm/shared/skills';
import {
  isValidSkillName,
  SKILL_BODY_MAX,
  skillBodyBytes,
  skillTooLargeMessage,
} from '@tm/shared/skills';
import { SkillMirror } from '../entities/skillMirror.entity';
import type { SkillsResponse } from '@tm/protocol/wire';

/** Whether `value` has every field a {@link Skill} needs, with the right primitive types. */
function isWellFormedSkill(value: unknown): value is Skill {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
}

/**
 * Server-side writes for the library skills mirror (F7.11) — `SkillMirror`'s own docstring
 * has the "why composite key, why the tombstone lives here" story. Every write is a full-row
 * `upsert`, which is what makes `put` clearing a prior `deletedAt` and `remove` recording one
 * both come for free: there is no partial-column update path for either to miss.
 */
@Injectable()
export class SkillsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SkillMirror) private readonly skills: Repository<SkillMirror>,
  ) {}

  async list(accountId: string): Promise<SkillsResponse> {
    const rows = await this.skills.find({ where: { accountId } });
    const skills: Skill[] = [];
    const deletedSkillIds: string[] = [];
    for (const row of rows) {
      if (row.deletedAt !== null || row.data === null) {
        deletedSkillIds.push(row.id);
      } else {
        skills.push(row.data);
      }
    }
    return { skills, deletedSkillIds };
  }

  /**
   * Upserts `body` as skill `id`. 400 unless it is a well-formed {@link Skill} whose own
   * `id` matches the path and whose `name` is a usable slug; 413 when its `body` is over
   * {@link SKILL_BODY_MAX}. The upsert always writes `deletedAt: null`, so a `PUT` of a
   * previously deleted id revives it — same rule `applyMirrorDelta`'s tombstone clear
   * applies for a desktop Client's own mirror.
   */
  async put(accountId: string, id: string, body: unknown): Promise<Skill> {
    if (!isWellFormedSkill(body) || body.id !== id) {
      throw new BadRequestException(`Request body must be a skill whose id is ${id}.`);
    }
    if (!isValidSkillName(body.name)) {
      throw new BadRequestException(`Not a valid skill name: ${body.name}`);
    }

    const bytes = skillBodyBytes(body.body);
    if (bytes > SKILL_BODY_MAX) {
      throw new PayloadTooLargeException(skillTooLargeMessage(bytes));
    }

    const row: SkillMirror = {
      accountId,
      id,
      data: body,
      deletedAt: null,
      updatedAt: String(body.updatedAt),
    };
    await this.dataSource.manager.upsert(SkillMirror, row, ['accountId', 'id']);
    return body;
  }

  /**
   * Tombstones skill `id`: `deletedAt` set, `data` nulled to free the body. Idempotent, and
   * also writes a tombstone for an id this account never mirrored at all — a skill created
   * and deleted on the desktop before it ever pushed a `PUT` still needs a web tab to learn
   * it is gone rather than seeing nothing and assuming "unchanged".
   */
  async remove(accountId: string, id: string): Promise<void> {
    const now = String(Date.now());
    const row: SkillMirror = { accountId, id, data: null, deletedAt: now, updatedAt: now };
    await this.dataSource.manager.upsert(SkillMirror, row, ['accountId', 'id']);
  }
}
