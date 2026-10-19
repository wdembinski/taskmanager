/**
 * The one fixture `ui-shots.mjs` (step 4 of "screenshot the real UI headlessly") seeds every
 * screen in its `SCREENS` map from — board, issue list, a card's detail, Settings, and the
 * command palette, for both the desktop (`'client'`) and web (`'web'`) targets.
 *
 * `boardShotsFixture.mjs` already built the board's own data (tasks, projects, merge requests,
 * chain links, people, active runs) with fixed timestamps so shots are deterministic; this file
 * re-exports all of it unchanged — `shots-board.mjs` keeps importing that module directly.
 *
 * `BOOT_CHANNELS` is the single map both `scripts/lib/apiStub.mjs` (the desktop's `window.api`)
 * and `scripts/lib/fakeRelay.mjs` (the web build's HTTP relay) read every channel reached on
 * boot of those five screens from — enumerated by grepping `window.api.invoke(`/`transport.invoke(`
 * across `apps/client/src/renderer`, `packages/ui/src` and `apps/web/src` for what `App.tsx`,
 * `MyTasks.tsx`, `Settings.tsx`, `TaskDetail.tsx` and `IssuesScreen.tsx` call while mounting —
 * not literally every one of `@tm/shared/ipc`'s ~180 channels, only the ones a boot actually
 * reaches for. A channel missing from here that a later screen needs is a gap to add a row for,
 * not a reason to invent a generic fallback that could hide it.
 *
 * Built by merging every `CHANNELS` export under `scripts/fixtures/shots/` (one file per
 * feature — `scripts/lib/shotModules.mjs`'s `loadFixtureChannels`), so a new UI card adds a
 * file there instead of editing this one shared map. Per-feature exports (`TASK_ACTIVITY`,
 * `VISUAL_SIGNOFF_ATTACHMENTS`, `MILESTONES`, …) are NOT re-exported here any more — only
 * `ui-shots.mjs` ever imported those, and its own screen files
 * (`scripts/shots/screens/*.mjs`) now import them directly from the fixture file that owns
 * them.
 */
export * from './boardShotsFixture.mjs';
import { loadFixtureChannels } from '../lib/shotModules.mjs';

export const BOOT_CHANNELS = await loadFixtureChannels();
