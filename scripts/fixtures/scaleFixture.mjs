/**
 * The 5,000-card board F29.1 measures the UI against (`docs/plan/feature-roadmap/
 * F29-performance-at-scale.md`, Phase 1) — `buildScaleFixture()` returns the same shape
 * `uiShotsFixture.mjs` exports (`BOOT_CHANNELS`, `SETTINGS_OVERRIDES`, `TASKS`, `TASKS_BY_ID`,
 * `PROJECT_ID`), so `ui-shots.mjs --fixture scale` and `perf-board.mjs` boot the real renderer
 * against it through the same `apiStub.mjs`.
 *
 * Sized after the owner's live database (2026-10-29): 1,562 task rows came to 8.6 MB of JSON,
 * ≈5.5 KB a row, because every row carries its plan and ticket text. `cards` counts task
 * ROWS — top-level cards plus their steps (child tasks via `parentTaskId`) — the same rows that
 * measurement counted, and the bulk is spread the same way:
 *
 * - every board column and every `TaskStatus`, plus a few live runs (`running`,
 *   `waiting-input`, `blocked-by-limit`, each over a borrowed `preRunStatus`);
 * - about 30% of top-level cards own 2–6 steps;
 * - about 40% of rows carry an `agentPlan` (3–10 KB of markdown), and most an
 *   `externalDescription` (0.5–4 KB);
 * - a handful of epics and milestones, so each sidebar group holds hundreds of tickets;
 * - one `plan-approval` attention item on `SCALE_APPROVE_TASK_ID`, the card the perf script
 *   approves.
 *
 * Deterministic: every random choice comes from a seeded mulberry32, every timestamp from the
 * fixed `SCALE_EPOCH`, and nothing here reads the clock — the same `seed` and `cards` give
 * byte-identical JSON in any process (`scaleFixture.test.mjs` checks this across two).
 */
import { project, task } from './boardShotsFixture.mjs';
import {
  BOOT_CHANNELS as BASE_CHANNELS,
  SETTINGS_OVERRIDES as BASE_SETTINGS,
} from './uiShotsFixture.mjs';

export const SCALE_PROJECT_ID = 'proj-scale';
/** The top-level card the `plan-approval` item below is parked on — always the first card,
 *  so it exists for any `cards >= 1`. */
export const SCALE_APPROVE_TASK_ID = 'sc-1';
export const SCALE_APPROVE_ITEM_ID = 'att-scale-approve';
/** 2026-10-29 12:00 UTC — the day the live numbers above were taken. */
export const SCALE_EPOCH = Date.UTC(2026, 9, 29, 12, 0, 0);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** mulberry32 — a tiny seeded PRNG; returns floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'archive board branch budget cache card chain column comment commit config cursor ' +
  'dashboard deploy detail diff draft drag epic event export feed filter fixture focus ' +
  'footer frame gate glyph group header history import inbox index issue label lane layout ' +
  'limit link list log merge milestone mirror model module network note outbox overlay ' +
  'palette panel parser patch peek pipeline plan poll preview profile project prompt queue ' +
  'release relay render replay report request review rollout route run schema screen scroll ' +
  'session settings shell sidebar signal snapshot spinner state status step store stream ' +
  'subtask summary sync tab theme ticket timeline token toolbar tracker transport tree ' +
  'update upload usage variant verdict view window worktree add align avoid batch build ' +
  'carry check clear collapse compute copy count decide defer derive draw drop expand ' +
  'fetch fold guard hold keep load measure move open order park pick prove read reconcile ' +
  'refresh resolve restore retry scan seed select settle show skip sort split start stop ' +
  'swap tag trim wait wire write stale empty silent shared local remote native nested ' +
  'pending ready long short every first last whole partial stable'
).split(' ');

const PEOPLE = [
  ['person-ania', 'Ania Kowalska', 'AK', '#0F6CBD'],
  ['person-marek', 'Marek Zieliński', 'MZ', '#C239B3'],
  ['person-ola', 'Ola Wiśniewska', 'OW', '#13A10E'],
  ['person-wiktor', 'Wiktor Nowak', 'WN', '#8763B8'],
  ['person-jan', 'Jan Lis', 'JL', '#CA5010'],
  ['person-ewa', 'Ewa Sowa', 'ES', '#038387'],
].map(([id, name, initials, color]) => ({
  id,
  name,
  email: '',
  initials,
  color,
  isMe: false,
  createdAt: SCALE_EPOCH - 400 * DAY,
}));

const MILESTONE_NAMES = [
  'Foundations',
  'Reach the mobile build',
  'Cloud mirror',
  'Review workspace',
  'Performance at scale',
  'Early access',
  'Platform hardening',
  'Nordic rollout',
];
const EPIC_COUNT = 14;

/** Top-level status mix, as cumulative weights. Live run states are placed by hand below. */
const STATUS_WEIGHTS = [
  ['pending', 0.34],
  ['in-progress', 0.14],
  ['in-review', 0.1],
  ['blocked', 0.05],
  ['done', 0.28],
  ['failed', 0.03],
  ['stopped', 0.03],
  ['cancelled', 0.03],
];

/** Every `n`th top-level card (by position, after the approval card) is put in a live run
 *  state instead — a few of each, whatever `cards` is. */
const RUN_STATES = [
  { every: 401, status: 'running', preRunStatus: 'in-progress' },
  { every: 733, status: 'waiting-input', preRunStatus: 'in-progress' },
  { every: 977, status: 'blocked-by-limit', preRunStatus: 'pending' },
];

export function buildScaleFixture({ cards = 5000, seed = 29 } = {}) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const chance = (p) => rand() < p;
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const sentence = () => {
    const s = words(between(8, 18));
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  };
  const title = () => {
    const s = words(between(4, 9));
    return `${s[0].toUpperCase()}${s.slice(1)}`;
  };
  const paragraph = () => Array.from({ length: between(3, 6) }, sentence).join(' ');
  /** Prose of at least `bytes` characters (all ASCII, so characters are bytes). */
  const prose = (bytes) => {
    const parts = [];
    let len = 0;
    while (len < bytes) {
      const p = paragraph();
      parts.push(p);
      len += p.length + 2;
    }
    return parts.join('\n\n');
  };
  /** A plan the way an agent writes one: headings, numbered steps with bullets, prose. */
  const planMarkdown = (bytes) => {
    const parts = [`## Context\n\n${paragraph()}`];
    let len = parts[0].length;
    let step = 1;
    while (len < bytes) {
      const block =
        `### Step ${step++}: ${title()}\n\n${paragraph()}\n\n` +
        Array.from({ length: between(2, 5) }, () => `- \`${pick(WORDS)}.ts\` — ${sentence()}`).join(
          '\n',
        );
      parts.push(block);
      len += block.length + 2;
    }
    return parts.join('\n\n');
  };
  const weighted = () => {
    let r = rand();
    for (const [status, w] of STATUS_WEIGHTS) {
      if ((r -= w) < 0) return status;
    }
    return STATUS_WEIGHTS[0][0];
  };

  /** The bulk every row may carry, in the proportions the module doc names. */
  const bulk = () => ({
    description: prose(between(80, 400)),
    externalDescription: chance(0.85) ? prose(between(500, 4000)) : null,
    agentPlan: chance(0.4) ? planMarkdown(between(3000, 10000)) : null,
  });

  const milestones = MILESTONE_NAMES.map((name, i) => ({
    id: `ms-scale-${i + 1}`,
    projectId: SCALE_PROJECT_ID,
    name,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: SCALE_EPOCH - (200 - i * 10) * DAY,
  }));

  const tasks = [];
  const activeRuns = [];
  const links = [];
  const epicIds = [];
  const orderByColumn = {};
  let n = 0;

  const row = (over) =>
    task({
      projectId: SCALE_PROJECT_ID,
      ticketKey: over.parentTaskId ? undefined : `SC-${over.id.slice(3)}`,
      ...over,
    });

  while (tasks.length < cards) {
    n += 1;
    const id = `sc-${n}`;
    const isApprove = id === SCALE_APPROVE_TASK_ID;
    const isEpic = !isApprove && epicIds.length < EPIC_COUNT && n % 7 === 2;
    let status = weighted();
    let preRunStatus = null;
    const runState = RUN_STATES.find((r) => n > 1 && n % r.every === 0);
    if (runState) {
      status = runState.status;
      preRunStatus = runState.preRunStatus;
    }
    if (isApprove) {
      status = 'waiting-input';
      preRunStatus = 'in-progress';
    }
    const column = preRunStatus ?? status;
    orderByColumn[column] = (orderByColumn[column] ?? 0) + 1;
    const worked = status !== 'pending' || chance(0.1);
    const card = row({
      id,
      title: isEpic ? `Epic · ${title()}` : title(),
      status,
      preRunStatus,
      order: orderByColumn[column],
      issueType: isEpic ? 'epic' : pick(['story', 'task', 'task', 'bug']),
      assigneeId: chance(0.75) ? pick(PEOPLE).id : null,
      milestoneId: chance(0.85) ? pick(milestones).id : null,
      epicTaskId: !isEpic && epicIds.length > 0 && chance(0.6) ? pick(epicIds) : null,
      sessionId: worked ? `session-${id}` : null,
      workedAt: worked ? SCALE_EPOCH - between(1, 90 * 24 * 60) * MINUTE : undefined,
      agentProjectId: worked ? SCALE_PROJECT_ID : undefined,
      agentBranch: worked ? `sc-${n}-${pick(WORDS)}-${pick(WORDS)}` : undefined,
      statusNote: status === 'blocked' || status === 'failed' ? sentence() : undefined,
      ...bulk(),
    });
    if (isApprove) card.agentPlan = planMarkdown(6000);
    if (isEpic) epicIds.push(id);
    tasks.push(card);
    if (status === 'running' || status === 'waiting-input' || status === 'blocked-by-limit') {
      activeRuns.push({
        taskId: id,
        runId: `run-${id}`,
        startedAt: SCALE_EPOCH - between(1, 30) * MINUTE,
      });
    }

    // A chain arrow from an earlier card now and then — always lower id → higher, so no cycle.
    if (n > 20 && chance(0.04)) {
      links.push({
        id: `link-${links.length + 1}`,
        fromTaskId: `sc-${n - between(1, 20)}`,
        toTaskId: id,
        gate: 'after-merge',
        createdAt: SCALE_EPOCH - 30 * DAY,
      });
    }

    if (!isEpic && !isApprove && chance(0.3)) {
      const stepCount = between(2, 6);
      for (let s = 1; s <= stepCount && tasks.length < cards; s++) {
        const stepStatus =
          column === 'done' ? 'done' : column === 'pending' ? 'pending' : pick(['done', 'pending']);
        tasks.push(
          row({
            id: `${id}-s${s}`,
            parentTaskId: id,
            order: s - 1,
            title: title(),
            status: stepStatus,
            milestoneId: null,
            ...bulk(),
          }),
        );
      }
    }
  }

  const tasksById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const approveCard = tasksById[SCALE_APPROVE_TASK_ID];
  const approveSteps = approveCard
    ? Array.from({ length: 4 }, (_, i) => `Step ${i + 1}: ${title()}`)
    : [];
  const attention = approveCard
    ? [
        {
          id: SCALE_APPROVE_ITEM_ID,
          runId: `run-${SCALE_APPROVE_TASK_ID}`,
          taskId: SCALE_APPROVE_TASK_ID,
          projectId: SCALE_PROJECT_ID,
          taskTitle: approveCard.title,
          kind: 'plan-approval',
          prompt:
            `The agent finished planning and proposes ${approveSteps.length} step(s). ` +
            "Approving runs them one at a time, each in its own session, on this card's branch.",
          options: [],
          toolName: null,
          reason: null,
          plan: approveCard.agentPlan,
          steps: approveSteps,
          createdAt: SCALE_EPOCH - 90_000,
        },
      ]
    : [];

  const scaleProject = project({
    id: SCALE_PROJECT_ID,
    name: 'Scale',
    path: 'C:/repos/scale',
    ticketPrefix: 'SC',
    createdAt: SCALE_EPOCH - 400 * DAY,
  });

  return {
    BOOT_CHANNELS: {
      ...BASE_CHANNELS,
      'board:tasks': tasks,
      'project:list': [{ project: scaleProject, tasks: [] }],
      'person:list': PEOPLE,
      'chain:links': links,
      'attention:list': attention,
      // Not named by the ticket, but the base fixture's answers name the small board's cards
      // and milestones (and carry `Date.now()` stamps) — left in, they would reach a board that
      // has none of those cards and break the byte-identical guarantee.
      'milestone:list': milestones,
      'mr:mergeRequests': [],
      'scheduler:activeRuns': activeRuns,
      // Keyed on the small board's tasks too. No scale card has an unread comment, so nothing
      // marks one read — and a `TASKS_BY_ID` table here would put the whole board into the
      // init script twice more.
      'jira:markRead': 'null',
      'github:markRead': 'null',
    },
    SETTINGS_OVERRIDES: { ...BASE_SETTINGS, shelvedCardIds: [] },
    TASKS: tasks,
    TASKS_BY_ID: tasksById,
    PROJECT_ID: SCALE_PROJECT_ID,
  };
}
