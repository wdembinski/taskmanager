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
import { MODEL_CATALOG, type ModelResolution } from '@shared/model';
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
  const { code, stdout } = await host.exec(
    process.cwd(),
    'claude',
    ['--model', id, '-p', '/model', '--output-format', 'json'],
    { resolveViaShell: true, timeoutMs },
  );
  if (code !== 0) return unresolved;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unresolved;
  }
  const result = (parsed as { result?: unknown } | null)?.result;
  if (typeof result !== 'string') return unresolved;
  const label = parseModelLabel(result);
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
