import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '@shared/model';
import { LOCAL_TARGET, type ExecHost, type ExecResult } from './exec';
import {
  parseAvailableAliases,
  parseModelLabel,
  probeModelCatalog,
  resolveModel,
} from './claudeModels';

/** The full reply text `claude --model <id> -p "/model" --output-format json` prints,
 *  as captured from a real 2.1.258 CLI — one line naming the current model, one line
 *  of usage help. */
const reply = (label: string) =>
  `Current model: \`${label}\`\n` +
  'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], ' +
  'opus[1m], fable[1m], opusplan, default, or a full model ID.';

describe('parseModelLabel', () => {
  it('reads the display name out of a real /model reply', () => {
    expect(parseModelLabel(reply('Opus 5'))).toBe('Opus 5');
  });

  it('reads a decimal display name (Fable 5.1)', () => {
    expect(parseModelLabel(reply('Fable 5.1'))).toBe('Fable 5.1');
  });

  it('echoes an unrecognized id back verbatim as its own "label"', () => {
    expect(parseModelLabel(reply('totally-bogus-model-xyz'))).toBe('totally-bogus-model-xyz');
  });

  it('is null for text that is not a /model reply at all', () => {
    expect(parseModelLabel('It looks like you typed `/model`...')).toBeNull();
  });
});

describe('parseAvailableAliases', () => {
  it('lists every alias out of a real /model reply, dropping the "or a full model ID" clause', () => {
    expect(parseAvailableAliases(reply('Sonnet 5'))).toEqual([
      'sonnet',
      'opus',
      'haiku',
      'fable',
      'best',
      'sonnet[1m]',
      'opus[1m]',
      'fable[1m]',
      'opusplan',
      'default',
    ]);
  });

  it('is empty for text with no Available: line', () => {
    expect(parseAvailableAliases('Current model: `Sonnet 5`')).toEqual([]);
  });
});

/** A stub host whose `exec` answers with a fixed `/model` reply (or fails), so
 *  `resolveModel`/`probeModelCatalog` can be exercised without a real CLI. Only `exec`
 *  is ever called by this module — the rest of `ExecHost` is unused here. */
function stubHost(reply: (id: string) => ExecResult | null): ExecHost {
  return {
    target: LOCAL_TARGET,
    exec: async (_cwd, _file, args) => {
      const id = args[args.indexOf('--model') + 1];
      const result = reply(id);
      if (!result) throw new Error('stubHost: exec should not be called for this id');
      return result;
    },
    spawn: () => {
      throw new Error('not used');
    },
    toNative: (p) => p,
    toApp: (p) => p,
    relaySpec: () => {
      throw new Error('not used');
    },
    homeDir: async () => '',
  };
}

const okResult = (label: string): ExecResult => ({
  code: 0,
  stdout: JSON.stringify({ result: reply(label) }),
  stderr: '',
});

describe('resolveModel', () => {
  it("marks a recognized id known, carrying the CLI's friendly label", async () => {
    const host = stubHost(() => okResult('Opus 5'));
    expect(await resolveModel(host, 'opus')).toEqual({ id: 'opus', label: 'Opus 5', known: true });
  });

  it('marks a retired id known when the CLI has remapped it to a live model', async () => {
    // The CLI's own behavior for a decommissioned snapshot id: it does not error, it
    // answers with whatever replaced it — "known but not identity".
    const host = stubHost(() => okResult('Opus 5'));
    expect(await resolveModel(host, 'claude-opus-4-1')).toEqual({
      id: 'claude-opus-4-1',
      label: 'Opus 5',
      known: true,
    });
  });

  it('marks an unrecognized id unknown — the CLI echoed it back verbatim', async () => {
    const host = stubHost((id) => okResult(id));
    expect(await resolveModel(host, 'totally-bogus-model-xyz')).toEqual({
      id: 'totally-bogus-model-xyz',
      label: 'totally-bogus-model-xyz',
      known: false,
    });
  });

  it('folds a failed probe into the same shape as an unrecognized id', async () => {
    const host = stubHost(() => ({ code: 1, stdout: '', stderr: 'not found' }));
    expect(await resolveModel(host, 'sonnet')).toEqual({
      id: 'sonnet',
      label: 'sonnet',
      known: false,
    });
  });

  it('never throws on malformed JSON from the CLI', async () => {
    const host = stubHost(() => ({ code: 0, stdout: 'not json', stderr: '' }));
    expect(await resolveModel(host, 'sonnet')).toEqual({
      id: 'sonnet',
      label: 'sonnet',
      known: false,
    });
  });
});

describe('probeModelCatalog', () => {
  it('resolves every catalog entry, in catalog order', async () => {
    const host = stubHost((id) => okResult(`label-for-${id}`));
    const rows = await probeModelCatalog(host);
    expect(rows.map((r) => r.id)).toEqual(MODEL_CATALOG.map((e) => e.id));
    expect(rows.every((r) => r.known)).toBe(true);
  });
});
