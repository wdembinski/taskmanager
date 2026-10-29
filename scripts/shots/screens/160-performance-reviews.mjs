/**
 * The Performance tab with AI review spend on it (F16.10) — see `ui-shots.mjs`'s header doc for
 * the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 *
 * No mockup draws the Performance tab (`v10-17-insights-*` is the future Insights screen, not
 * this one), so these rows set no `mockup`: the verdict compares them with the tab's existing
 * layout instead.
 */
import { now } from '../../fixtures/shotsFixtureHelpers.mjs';

const TASK_TOTAL = 3_200_000;
const ORCH_TOTAL = 800_000;
const REVIEW_TOTAL = 1_000_000;
const WINDOW_TOTAL = TASK_TOTAL + ORCH_TOTAL + REVIEW_TOTAL;
const pct = (n) => (n / WINDOW_TOTAL) * 100;

/** One project carrying all three sources, so its drill-down draws tasks, Align and reviews. */
const PROJECT_TOKENS = 4_200_000;
const PROJECT = {
  projectId: 'p1',
  label: 'Task Manager',
  tokens: PROJECT_TOKENS,
  pct: pct(PROJECT_TOKENS),
  taskTokens: 2_600_000,
  orchestratorTokens: 600_000,
  reviewTokens: 1_000_000,
  tasks: [
    { id: 't1', label: 'Bring board cards to the v9-7', tokens: 1_700_000, pct: 40.5 },
    { id: 't2', label: 'Record review spend', tokens: 900_000, pct: 21.4 },
  ],
};

/** The second project has task and Align spend only — no reviews row under it. */
const OTHER = {
  projectId: 'p2',
  label: 'Travelbook',
  tokens: 800_000,
  pct: pct(800_000),
  taskTokens: 600_000,
  orchestratorTokens: 200_000,
  reviewTokens: 0,
  tasks: [{ id: 't3', label: 'Trip import', tokens: 600_000, pct: 75 }],
};

const USAGE_SUMMARY = {
  windowStart: now - 5 * 60 * 60 * 1000,
  windowEnd: now,
  windowReset: now + 2 * 60 * 60 * 1000,
  windowTotal: WINDOW_TOTAL,
  breakdown: { input: 400_000, output: 300_000, cacheCreation: 900_000, cacheRead: 3_400_000 },
  byProject: [
    { id: 'p1', label: 'Task Manager', tokens: PROJECT_TOKENS, pct: pct(PROJECT_TOKENS) },
    { id: 'p2', label: 'Travelbook', tokens: 800_000, pct: pct(800_000) },
  ],
  byTask: [
    { id: 't1', label: 'Bring board cards to the v9-7', tokens: 1_700_000, pct: pct(1_700_000) },
    { id: 't2', label: 'Record review spend', tokens: 900_000, pct: pct(900_000) },
    { id: 't3', label: 'Trip import', tokens: 600_000, pct: pct(600_000) },
  ],
  bySource: [
    { id: 'task', label: 'Tasks', tokens: TASK_TOTAL, pct: pct(TASK_TOTAL) },
    { id: 'review', label: 'Reviews', tokens: REVIEW_TOTAL, pct: pct(REVIEW_TOTAL) },
    { id: 'orchestrator', label: 'Orchestrator', tokens: ORCH_TOTAL, pct: pct(ORCH_TOTAL) },
  ],
  projects: [PROJECT, OTHER],
  taskTotal: TASK_TOTAL,
  orchestratorTotal: ORCH_TOTAL,
  reviewTotal: REVIEW_TOTAL,
  burn: { perMinute: 42_000, perSecond: 700, trend: 'up' },
  limitStatus: 'allowed',
  costUsd: 3.67,
  runningLow: 'ok',
};

/** The live chart's last two minutes at one-second buckets — a gentle wave so it draws. */
const USAGE_SERIES = Array.from({ length: 120 }, (_, i) => ({
  t: now - (120 - i) * 1000,
  tokens: Math.round(600 + 250 * Math.sin(i / 9)),
}));

const OVERRIDES = {
  'usage:summary': USAGE_SUMMARY,
  'usage:series': USAGE_SERIES,
  'usage:sessionStats': [],
};

const row = (scheme) => ({
  name: `performance-reviews-${scheme}`,
  app: 'client',
  // Taller than the usual 900: the project drill-down sits under the chart and the session
  // statistics, and one frame has to show it next to the rail's "By source" and Totals.
  viewport: { width: 1440, height: 1240 },
  scheme,
  clock: now,
  // The shell's nav carries the tab as "Performance" (`shellNav.ts`). Every project in the
  // drill-down starts expanded, so the "AI reviews" child row is on screen without a click.
  setup: [{ click: 'Performance' }],
  // `Performance.tsx`'s root, drawn only once `usage:summary` has answered.
  expect: '[data-performance]',
  channelOverrides: OVERRIDES,
});

export default [row('light'), row('dark')];
