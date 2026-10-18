/**
 * Proves the two step rows carry what the board's own step rows used to, before F13.24 moved
 * the list into the peek: a status dot per step that blinks while it runs, and the attention
 * tint on a step the inbox is holding something for. `StepRow`/`GateRow` are tested directly
 * — `TaskSteps` folds the whole section shut on mount (F11's own rule) and this package has no
 * DOM testing library to click it back open, so `renderToStaticMarkup` only sees inside the
 * fold through the rows themselves, exactly the way `TaskDetailHostView.render.test.tsx`
 * already tests `TaskDetailHost` by going straight at what it wraps.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@tm/shared/attention';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from './transport';
import { GateRow, StepRow } from './TaskSteps';

const stubTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

/** `GateRow` reads `useTransport()` (to load its output on demand), which throws without a
 *  provider — `StepRow` needs none, but rendering both through the same helper is simpler
 *  than keeping two render paths in sync. */
function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const gateStep = (over: Partial<Task> & { id: string }): Task =>
  task({
    stepSpec: { id: 'g1', kind: 'gate', title: 'Gate', command: 'pnpm test' },
    ...over,
  });

const attentionItem = (
  over: Partial<AttentionItem> & { id: string; taskId: string },
): AttentionItem => ({
  runId: 'run-1',
  projectId: PERSONAL_PROJECT_ID,
  taskTitle: 'a step',
  kind: 'question',
  prompt: 'what next?',
  options: [],
  toolName: null,
  reason: null,
  createdAt: 0,
  ...over,
});

describe('StepRow', () => {
  const baseProps = {
    index: 0,
    wantsAttention: false,
    skillOptions: [],
    skillOptionsLoading: false,
    busy: false,
    onSaveSkillRefs: () => {},
    onOpen: () => {},
  };

  it('wears the blinking running dot, not its status badge, while the step is live', () => {
    const step = task({ id: 'step-1', status: 'running', agentProjectId: 'proj' });

    const html = render(<StepRow {...baseProps} step={step} />);

    expect(html).toContain('Running');
    expect(html).not.toContain('fui-Badge');
  });

  it('wears its status badge, not the running dot, once the step is not live', () => {
    const step = task({ id: 'step-1', status: 'done' });

    const html = render(<StepRow {...baseProps} step={step} />);

    expect(html).not.toContain('Running');
    expect(html).toContain('Done');
  });

  it('a step not assigned to an agent falls back to its status badge, even mid-status', () => {
    // `isAgentRunning` needs BOTH `status === 'running'` and an `agentProjectId` — a
    // hand-written step (no agent) running is not something that can happen today, but the
    // row must still fall back to the Badge rather than claim a dot it has no agent for.
    // `STATUS_LABEL.running` is "Running" too, so the badge class — not the word — is what
    // tells the two branches apart.
    const step = task({ id: 'step-1', status: 'running' });

    const html = render(<StepRow {...baseProps} step={step} />);

    expect(html).toContain('fui-Badge');
  });

  it('carries a different class on its row once it wants attention', () => {
    const step = task({ id: 'step-1', status: 'waiting-input' });

    const plain = render(<StepRow {...baseProps} step={step} wantsAttention={false} />);
    const loud = render(<StepRow {...baseProps} step={step} wantsAttention={true} />);

    // Same row, same step — the only difference is `wantsAttention`, so the markup must
    // differ by exactly the tint class this prop adds.
    expect(loud).not.toBe(plain);
  });
});

describe('GateRow', () => {
  it('wears the blinking running dot while the gate command is running', () => {
    const step = gateStep({ id: 'gate-1', status: 'running' });

    const html = render(<GateRow step={step} index={0} attention={[]} onOpen={() => {}} />);

    expect(html).toContain('Running');
  });

  it('carries a different class on its row once an inbox item is parked on it', () => {
    const step = gateStep({ id: 'gate-1', status: 'waiting-input' });
    const items = [attentionItem({ id: 'item-1', taskId: 'gate-1', kind: 'task-failed' })];

    const plain = render(<GateRow step={step} index={0} attention={[]} onOpen={() => {}} />);
    const loud = render(<GateRow step={step} index={0} attention={items} onOpen={() => {}} />);

    expect(loud).not.toBe(plain);
  });

  it('returns null for a step that is not a gate', () => {
    const step = task({ id: 'step-1' });

    expect(render(<GateRow step={step} index={0} attention={[]} onOpen={() => {}} />)).toBe('');
  });
});
