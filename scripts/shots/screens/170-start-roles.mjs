/**
 * The Start dialog's roles table and estimate line (F28.1) — see `ui-shots.mjs`'s header doc
 * for the row shape. Opens FX-212 (`97-start-roles.mjs`) and its "Reassign…" button, which is
 * the Start dialog (`AssignAgentDialog`). The clip is the roles section plus the footer; the
 * mode and lead rows above it and Limits / "Ask me when" below it are F28.4/F28.5 features
 * that do not exist yet.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';
import {
  START_CARD,
  START_MODEL_CATALOG,
  START_ROLES_PROJECTS,
  START_RUN_STATS,
  START_STEPS,
} from '../../fixtures/shots/97-start-roles.mjs';

const channelOverrides = {
  'board:tasks': [...BOOT_CHANNELS['board:tasks'], START_CARD, ...START_STEPS],
  'project:list': START_ROLES_PROJECTS,
  'project:runStats': START_RUN_STATS,
  'model:catalog': START_MODEL_CATALOG,
};

const row = (scheme) => ({
  name: `start-roles-${scheme}`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  setup: [{ click: `board-card:${START_CARD.id}` }, { click: 'Reassign' }],
  expect: '[role="dialog"] [data-roles-table]',
  mockup: `v11-4-start-roles-effort-${scheme}.svg`,
  clip: { x: 330, y: 252, width: 780, height: 498 },
  channelOverrides,
});

export default [row('light'), row('dark')];
