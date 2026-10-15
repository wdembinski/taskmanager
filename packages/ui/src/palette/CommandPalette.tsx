/**
 * CommandPalette — the dialog that drives `paletteModel.ts` (F9.3). Holds no logic of its
 * own: every keystroke and click turns into a `PaletteEvent` the model already knows how to
 * handle, and the component just renders `PaletteState` and wires effects around it.
 *
 * Three moments need an effect rather than a plain handler, because they cross the
 * host/model boundary rather than reacting to a click:
 *  - the host's `open` prop flipping true re-collects commands from `sources` (a source may
 *    depend on state that changed since the palette last opened); flipping false closes it.
 *  - the model's own `open` going false (Escape, or a command finishing) has to tell the host
 *    back, since the host owns `open` as a prop rather than watching the model directly.
 *  - a `select` lands and needs its command actually run, with the result turned back into
 *    `close` or `failed`.
 */
import { useEffect, useId, useReducer, useRef } from 'react';
import {
  Caption1,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  tokens,
} from '@fluentui/react-components';
import { ipcErrorMessage } from '@tm/shared/ipcError';
import {
  collectCommands,
  groupRows,
  initialPaletteState,
  paletteKeyEvent,
  paletteReduce,
  runSelected,
  type PaletteContext,
  type PaletteSource,
} from './paletteModel';

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '480px',
  },
  listbox: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '360px',
    overflowY: 'auto',
  },
  heading: {
    display: 'block',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowActive: { backgroundColor: tokens.colorNeutralBackground1Selected },
  rowTitle: { flexShrink: 0 },
  rowSubtitle: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowHint: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
});

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: readonly PaletteSource[];
  context: PaletteContext;
}

export function CommandPalette({
  open,
  onOpenChange,
  sources,
  context,
}: CommandPaletteProps): React.JSX.Element {
  const styles = useStyles();
  const [state, dispatch] = useReducer(paletteReduce, initialPaletteState);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const optionRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // `sources`/`context` are read fresh at the moment `open` flips true, not tracked for
  // change — re-opening is the only time a source is asked for a new list.
  useEffect(() => {
    if (open) {
      dispatch({ type: 'open', commands: collectCommands(sources, context), ctx: context });
    } else {
      dispatch({ type: 'close' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const wasOpen = useRef(state.open);
  useEffect(() => {
    if (wasOpen.current && !state.open) onOpenChange(false);
    wasOpen.current = state.open;
  }, [state.open, onOpenChange]);

  useEffect(() => {
    if (state.selected === null) return;
    const run = runSelected(state);
    if (!run) return;
    Promise.resolve()
      .then(run)
      .then(
        () => dispatch({ type: 'close' }),
        (err: unknown) => dispatch({ type: 'failed', message: ipcErrorMessage(err) }),
      );
    // Only a selection landing should fire a run — `state.secondary` changes alongside it,
    // not independently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selected]);

  useEffect(() => {
    optionRefs.current[state.activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [state.activeIndex]);

  const groups = groupRows(state.rows);

  return (
    <Dialog
      open={state.open}
      onOpenChange={(_e, data) => !data.open && dispatch({ type: 'close' })}
    >
      <DialogSurface>
        <DialogBody>
          <DialogContent className={styles.content}>
            <Input
              autoFocus
              value={state.query}
              role="combobox"
              aria-expanded={state.rows.length > 0}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                state.activeIndex >= 0 ? optionId(state.activeIndex) : undefined
              }
              placeholder="Type a command…"
              onChange={(_e, data) => dispatch({ type: 'query', query: data.value })}
              onKeyDown={(e) => {
                const event = paletteKeyEvent(e);
                if (event) {
                  e.preventDefault();
                  dispatch(event);
                }
              }}
            />
            {state.error && (
              <MessageBar intent="error">
                <MessageBarBody>{state.error}</MessageBarBody>
              </MessageBar>
            )}
            <div id={listboxId} role="listbox" className={styles.listbox}>
              {groups.length === 0 && (
                <Caption1 className={styles.empty}>No matching commands</Caption1>
              )}
              {groups.map((group) => (
                <div
                  key={group.group}
                  role="group"
                  aria-labelledby={`${baseId}-heading-${group.group}`}
                >
                  <Caption1 id={`${baseId}-heading-${group.group}`} className={styles.heading}>
                    {group.label}
                  </Caption1>
                  {group.items.map((item) => {
                    const active = item.index === state.activeIndex;
                    return (
                      <div
                        key={item.command.id}
                        ref={(node) => {
                          optionRefs.current[item.index] = node;
                        }}
                        id={optionId(item.index)}
                        role="option"
                        aria-selected={active}
                        className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          dispatch({ type: 'select', index: item.index });
                        }}
                      >
                        <Caption1 className={styles.rowTitle}>{item.command.title}</Caption1>
                        {item.command.subtitle && (
                          <Caption1 className={styles.rowSubtitle}>
                            {item.command.subtitle}
                          </Caption1>
                        )}
                        {active && item.command.secondary && (
                          <Caption1 className={styles.rowHint}>
                            {item.command.secondary.title}
                          </Caption1>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
