/**
 * Which models the installed CLI actually recognizes right now — not what
 * `MODEL_CATALOG` (`@shared/model`) *lists*, but what `claude` itself will say back
 * when asked to run on each one. The catalog is aspirational (it is edited by hand as
 * new models ship); this module is the CLI's own answer, and the two can disagree in
 * both directions — a brand-new id the catalog doesn't know about yet, or a retired
 * one the CLI has quietly remapped to whatever replaced it.
 *
 * Modelled directly on `claudeUsage.ts`: `/model` is a **local** meta-command exactly
 * like `/usage` — answered by the CLI itself, zero tokens, zero turns, no network round
 * trip to the model — so probing every catalog entry costs nothing but wall-clock time.
 * `claude --model <id> -p "/model" --output-format json` replies with text like:
 *
 *   Current model: `Opus 5`
 *   Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m],
 *   opus[1m], fable[1m], opusplan, default, or a full model ID.
 *
 * The CLI echoes an id it does not recognize back verbatim as the "current model"
 * (so asking about `totally-bogus` reports `Current model: \`totally-bogus\``), and
 * echoes a friendly display name for one it does — including a RETIRED id it has
 * remapped to a live model (`claude-opus-4-1` reports `Current model: \`Opus 5\``, not
 * an error). That is the entire signal this module reads: `label !== id` is "the CLI
 * knows this one."
 */
import {
  familyOfAlias,
  MODEL_CATALOG,
  type DiscoveredModel,
  type ModelFamily,
  type ModelResolution,
} from '@shared/model';
import type { ClaudeModel } from '@shared/session';
import { localHost, type ExecHost } from './exec';

const MODEL_LABEL_LINE = /Current model:\s*`([^`]+)`/i;
const AVAILABLE_LINE = /Available:\s*(.+)$/im;

/** Pure text parse of the `` Current model: `X` `` line — the CLI's own display name. */
export function parseModelLabel(text: string): string | null {
  const match = text.match(MODEL_LABEL_LINE);
  return match ? match[1] : null;
}

/**
 * Pure text parse of the `Usage: /model <name>. Available: …` line into the bare list
 * of aliases it names (`sonnet`, `opus[1m]`, `default`, …) — dropping the trailing
 * "or a full model ID" clause, which is prose about the fallback rather than a name.
 * Split out so it is unit-testable without spawning anything, same as
 * `parseClaudeUsageText`.
 */
export function parseAvailableAliases(text: string): string[] {
  const match = text.match(AVAILABLE_LINE);
  if (!match) return [];
  return match[1]
    .replace(/\.\s*$/, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !/\s/.test(entry));
}

/**
 * Run the `/model` probe for one id and hand back its raw reply text, or `null` for
 * every way that can fail to mean anything (non-zero exit, unparseable JSON, a shape
 * that isn't `{ result: string }`) — the one spawn `resolveModel` and
 * `discoverModelCatalog` both build on, since the latter needs the `Available:` line
 * the former throws away after reading `Current model:`.
 */
async function readModelProbe(
  host: ExecHost,
  id: ClaudeModel,
  timeoutMs: number,
): Promise<string | null> {
  const { code, stdout } = await host.exec(
    process.cwd(),
    'claude',
    ['--model', id, '-p', '/model', '--output-format', 'json'],
    { resolveViaShell: true, timeoutMs },
  );
  if (code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = (parsed as { result?: unknown } | null)?.result;
  return typeof result === 'string' ? result : null;
}

/**
 * Ask the CLI what it makes of one model id. Never throws — a CLI that is missing,
 * logged out, offline, or mid-upgrade just means "no reading yet", the same shape
 * `readClaudeUsage` uses for the same reasons, and folds into the same neutral answer
 * as an id the CLI plainly does not recognize: `{ id, label: id, known: false }`. A
 * caller cannot tell "the probe failed" from "the CLI said no" apart, which is fine —
 * neither is grounds for offering the model in a picker.
 */
export async function resolveModel(
  host: ExecHost = localHost(),
  id: ClaudeModel,
  timeoutMs = 10_000,
): Promise<ModelResolution> {
  const unresolved: ModelResolution = { id, label: id, known: false };
  const text = await readModelProbe(host, id, timeoutMs);
  if (text === null) return unresolved;
  const label = parseModelLabel(text);
  if (label === null) return unresolved;
  return { id, label, known: label !== id };
}

/** How many `resolveModel` calls run at once — each is its own `claude` process, and
 *  the catalog is small enough that this stays well under any OS process ceiling. */
const CATALOG_CONCURRENCY = 4;

/**
 * Resolve every `MODEL_CATALOG` entry against the installed CLI, in parallel with a
 * bounded concurrency, and return one row per entry in catalog order. Zero tokens; a
 * few seconds wall-clock for the whole sweep rather than one process at a time.
 */
export async function probeModelCatalog(host: ExecHost = localHost()): Promise<ModelResolution[]> {
  const entries = MODEL_CATALOG;
  const rows = new Array<ModelResolution>(entries.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < entries.length) {
      const i = next++;
      rows[i] = await resolveModel(host, entries[i].id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, entries.length) }, worker));
  return rows;
}

/** The id the one extra `/model` probe in {@link discoverModelCatalog} runs on, purely
 *  to read its `Available:` line — any catalog alias would do. */
const ALIAS_DISCOVERY_PROBE_ID: ClaudeModel = 'sonnet';

/**
 * Resolve `MODEL_CATALOG` against the installed CLI (same sweep as `probeModelCatalog`)
 * and merge in whatever **live** aliases the CLI's `Available:` line names that the
 * static catalog doesn't already carry — so a new family the CLI ships shows up before
 * anyone edits `MODEL_CATALOG` by hand, without losing a retired id the `Available:`
 * line has already dropped (it still comes through via the static sweep, labelled by
 * whatever the CLI has remapped it to).
 *
 * One extra `/model` probe supplies the whole alias list: its `Available:` line is
 * always the same regardless of which id was probed, so a single call
 * (`ALIAS_DISCOVERY_PROBE_ID`) is enough. Non-model tokens on that line (`default`,
 * `best`, `opusplan`, the `[1m]` context variants) are dropped by {@link familyOfAlias}
 * — they stay reachable through "Custom…" rather than a family-grouped row.
 */
export async function discoverModelCatalog(
  host: ExecHost = localHost(),
): Promise<DiscoveredModel[]> {
  const [staticRows, probeText] = await Promise.all([
    probeModelCatalog(host),
    readModelProbe(host, ALIAS_DISCOVERY_PROBE_ID, 10_000),
  ]);

  const merged = new Map<string, DiscoveredModel>();
  staticRows.forEach((row, i) => {
    const entry = MODEL_CATALOG[i];
    merged.set(row.id, { ...row, family: entry.family, kind: entry.kind });
  });

  const aliasTokens = probeText === null ? [] : parseAvailableAliases(probeText);
  const newAliases = aliasTokens
    .map((id) => ({ id: id as ClaudeModel, family: familyOfAlias(id) }))
    .filter(
      (alias): alias is { id: ClaudeModel; family: ModelFamily } =>
        alias.family !== null && !merged.has(alias.id),
    );
  const aliasRows = await Promise.all(
    newAliases.map(async ({ id, family }): Promise<DiscoveredModel> => ({
      ...(await resolveModel(host, id)),
      family,
      kind: 'alias',
    })),
  );
  for (const row of aliasRows) merged.set(row.id, row);

  return Array.from(merged.values());
}
