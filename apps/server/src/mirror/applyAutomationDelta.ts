import { In, type EntityManager } from 'typeorm';
import type { MirrorDelta } from '@tm/protocol/wire';
import { AutomationMirror } from '../entities/automationMirror.entity';
import { AutomationRunMirror } from '../entities/automationRunMirror.entity';

/** No run older than this survives a sweep, regardless of how few an automation has. */
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The newest runs an automation keeps, even if every one of them is within retention. */
const RUNS_KEPT_PER_AUTOMATION = 100;

/**
 * Applies one Client's automation fields off a {@link MirrorDelta} — upsert-and-delete, in
 * the transaction `MirrorService.sync()` already opened right after `applyMirrorDelta`, so
 * an automation's own edits and a Client's task/project push either both land or neither does.
 *
 * All three fields are optional on the wire (see `MirrorDelta`'s own docstring), and a
 * desktop build that predates them sends none — every array below defaults to empty, which
 * makes the whole function a no-op for that Client, not an error.
 *
 * `clientId` is the syncing Client's own id, threaded through to resolve
 * `Automation.ownerClientId`'s `null` ("this one," from that desktop's own perspective) into
 * an id that still means something once the row is sitting in `automation_mirrors` — see
 * that entity's docstring.
 */
export async function applyAutomationDelta(
  manager: EntityManager,
  accountId: string,
  clientId: string,
  delta: MirrorDelta,
): Promise<void> {
  const automations = delta.automations ?? [];
  const runs = delta.automationRuns ?? [];
  const deletedAutomationIds = delta.deletedAutomationIds ?? [];

  if (automations.length > 0) {
    await manager.upsert(
      AutomationMirror,
      automations.map((automation) => ({
        id: automation.id,
        accountId,
        clientId: automation.ownerClientId ?? clientId,
        data: automation,
        updatedAt: String(automation.updatedAt),
      })),
      ['id'],
    );
  }

  if (runs.length > 0) {
    await manager.upsert(
      AutomationRunMirror,
      runs.map((run) => ({
        id: run.id,
        accountId,
        automationId: run.automationId,
        data: run,
        at: String(run.at),
      })),
      ['id'],
    );
  }

  if (deletedAutomationIds.length > 0) {
    await manager.delete(AutomationMirror, { id: In(deletedAutomationIds), accountId });
    await manager.delete(AutomationRunMirror, {
      automationId: In(deletedAutomationIds),
      accountId,
    });
  }

  // Retention only ever has to look at automations this delta actually touched — an
  // automation nothing said anything about this tick cannot have grown a new run since the
  // last sweep touched it.
  const touchedAutomationIds = new Set(
    [...automations.map((a) => a.id), ...runs.map((r) => r.automationId)].filter(
      (id) => !deletedAutomationIds.includes(id),
    ),
  );

  for (const automationId of touchedAutomationIds) {
    const existing: AutomationRunMirror[] = await manager.find(AutomationRunMirror, {
      where: { accountId, automationId },
      select: { id: true, data: true },
    });
    const prune = runsToPrune(
      existing.map((row) => ({ id: row.id, at: row.data.at })),
      Date.now(),
    );
    if (prune.length > 0) {
      await manager.delete(AutomationRunMirror, { id: In(prune.map((row) => row.id)) });
    }
  }
}

/**
 * Which of one automation's runs a retention sweep drops: anything older than 30 days, and
 * anything past the newest 100 regardless of age. Pure and exported so the two rules — and
 * the "both apply, whichever catches a row first" interaction between them — can be proven
 * without a database.
 */
export function runsToPrune<T extends { id: string; at: number }>(
  runs: readonly T[],
  now: number,
): T[] {
  const cutoff = now - RUN_RETENTION_MS;
  return [...runs]
    .sort((a, b) => b.at - a.at)
    .filter((run, index) => index >= RUNS_KEPT_PER_AUTOMATION || run.at < cutoff);
}
