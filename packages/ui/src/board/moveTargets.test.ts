import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task } from '@tm/shared/model';
import { columnForTask } from '@tm/shared/board';
import { visibleColumns } from './boardColumns';
import { allowedDropColumns, moveSheetOptions } from './moveTargets';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't',
  projectId: 'p',
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...overrides,
});

/** The card states the matrix below exercises, with the column each one rests in. */
const CARD_STATES: Array<{ name: string; task: Task }> = [
  { name: 'todo', task: task({ status: 'pending' }) },
  { name: 'in-progress with a live run', task: task({ status: 'running' }) },
  {
    name: 'in-progress resting via preRunStatus',
    task: task({ status: 'waiting-input', preRunStatus: 'in-progress' }),
  },
  { name: 'in-review', task: task({ status: 'in-review' }) },
  {
    name: 'blocked with preBlockStatus',
    task: task({ status: 'blocked', preBlockStatus: 'in-progress' }),
  },
  { name: 'done', task: task({ status: 'done' }) },
  {
    name: 'a step card',
    task: task({ id: 'step-1', parentTaskId: 'parent-1', status: 'in-progress' }),
  },
  {
    name: 'a chained card',
    task: task({ id: 'chained-1', status: 'in-review' }),
  },
];

const HIDDEN_CASES: Array<{ name: string; hiddenColumns: BoardColumn[] }> = [
  { name: 'no hidden columns', hiddenColumns: [] },
  { name: 'done hidden', hiddenColumns: ['done'] },
  { name: 'todo and blocked hidden', hiddenColumns: ['todo', 'blocked'] },
];

describe('allowedDropColumns', () => {
  for (const { name, hiddenColumns } of HIDDEN_CASES) {
    it(`equals visibleColumns when not pending (${name})`, () => {
      expect(allowedDropColumns({ hiddenColumns, pending: false })).toEqual(
        visibleColumns(hiddenColumns),
      );
    });

    it(`is empty while pending, whatever is hidden (${name})`, () => {
      expect(allowedDropColumns({ hiddenColumns, pending: true })).toEqual([]);
    });
  }
});

describe('moveSheetOptions', () => {
  for (const { name: stateName, task: t } of CARD_STATES) {
    for (const { name: hiddenName, hiddenColumns } of HIDDEN_CASES) {
      it(`${stateName} / ${hiddenName}: enabled columns match allowedDropColumns`, () => {
        const options = moveSheetOptions(t, { hiddenColumns, pending: false });
        const enabledColumns = options.filter((o) => o.enabled).map((o) => o.column);
        expect(enabledColumns).toEqual(allowedDropColumns({ hiddenColumns, pending: false }));
        expect(enabledColumns).toEqual(visibleColumns(hiddenColumns));
      });

      it(`${stateName} / ${hiddenName}: pending disables every option`, () => {
        const options = moveSheetOptions(t, { hiddenColumns, pending: true });
        expect(options.every((o) => !o.enabled)).toBe(true);
      });

      it(`${stateName} / ${hiddenName}: exactly one option is current, or none when hidden`, () => {
        const options = moveSheetOptions(t, { hiddenColumns, pending: false });
        const current = options.filter((o) => o.current);
        const restingColumn = columnForTask(t);
        if (hiddenColumns.includes(restingColumn)) {
          expect(current).toHaveLength(0);
        } else {
          expect(current).toHaveLength(1);
          expect(current[0]?.column).toBe(restingColumn);
        }
      });

      it(`${stateName} / ${hiddenName}: one option per visible column, in board order`, () => {
        const options = moveSheetOptions(t, { hiddenColumns, pending: false });
        expect(options.map((o) => o.column)).toEqual(visibleColumns(hiddenColumns));
      });
    }
  }
});
