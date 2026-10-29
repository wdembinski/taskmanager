/**
 * The four `aiReview:*` IPC handler bodies F16.11 adds, kept out of `ipc.ts` the way
 * `reviewHandlers.ts` keeps the `review:*` ones out — so they can be driven through a real
 * `RelayRegistry` in a test without standing up Electron. No import here reaches `electron`;
 * `ipc.ts` does the `ipcMain.handle` / `relayRegistry.register` wiring via its `handle()`.
 *
 * Every argument is validated before it reaches the runner: a relayed call arrives over the
 * untyped web wire, where nothing but this function stands between a malformed command and a
 * confusing crash inside the runner — or a paid review started on a subject nobody named. A
 * bad argument throws a readable `Error`, which `RelayRegistry.invoke` turns into
 * `{ ok: false, error }` for a browser and `ipcMain.handle` into a rejected promise.
 *
 * `aiReview:start` always asks as `'human'`: automation calls the runner directly, never over
 * IPC. `aiReview:get` answers `null`, not `undefined`, for an unknown id — `undefined` does not
 * survive the JSON relay wire.
 */
import type { IpcApi } from '@shared/ipc';
import type { AiReviewRunner } from './aiReviewRunner';

export interface AiReviewHandlersDeps {
  runner: Pick<AiReviewRunner, 'start' | 'cancel' | 'list' | 'get'>;
}

/** The subset of `IpcApi` these four channels implement — same contract, no Electron import. */
export type AiReviewHandlers = Pick<
  IpcApi,
  'aiReview:start' | 'aiReview:cancel' | 'aiReview:list' | 'aiReview:get'
>;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export function createAiReviewHandlers(deps: AiReviewHandlersDeps): AiReviewHandlers {
  return {
    'aiReview:start': async (subjectId) =>
      deps.runner.start(requireString(subjectId, 'subjectId'), 'human'),
    'aiReview:cancel': async (id) => deps.runner.cancel(requireString(id, 'id')),
    'aiReview:list': async (subjectId) => deps.runner.list(requireString(subjectId, 'subjectId')),
    'aiReview:get': async (id) => deps.runner.get(requireString(id, 'id')) ?? null,
  };
}
