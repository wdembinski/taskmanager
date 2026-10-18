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
 *
 * Since the v10 mockup (TM-458), every row renders an icon (the command's own, or a per-group
 * default from `GROUP_ICON`), an optional `prefix` (a tracker key, in monospace, ahead of the
 * title) and a right-aligned shortcut hint; the header grows an "on {subjectLabel}" chip when
 * `context.subjectLabel` is set; and the footer spells out the four keys the palette answers
 * to. `AppShell`'s own content-only scrim (not this component) dims the rest of the window
 * while the dialog is open — see `AppShell.tsx`'s `dimmed` prop.
 */
import { useEffect, useId, useReducer, useRef } from 'react';
import {
  Body1,
  Caption1,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowRightRegular,
  FlashRegular,
  FolderRegular,
  SearchRegular,
  TicketDiagonalRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { ipcErrorMessage } from '@tm/shared/ipcError';
import {
  collectCommands,
  groupRows,
  initialPaletteState,
  paletteKeyEvent,
  paletteReduce,
  runSelected,
  type PaletteContext,
  type PaletteGroup,
  type PaletteSource,
} from './paletteModel';
import { shortcutLabel } from './shortcutLabel';

/** A command's per-group fallback icon, used when it carries none of its own — see the
 *  module's own header. */
const GROUP_ICON: Record<PaletteGroup, FluentIcon> = {
  actions: FlashRegular,
  cards: TicketDiagonalRegular,
  navigate: ArrowRightRegular,
  projects: FolderRegular,
};

/** The footer's own key-glyph → action-word pairs, in the order the mockup lists them. */
const FOOTER_HINTS: readonly [string, string][] = [
  ['↑↓', 'move'],
  ['↵', 'run'],
  ['⇥', 'refine'],
  ['esc', 'close'],
];

const ROW_ICON_SIZE = 16;
const ROW_GAP = tokens.spacingHorizontalS;

const useStyles = makeStyles({
  surface: {
    width: '640px',
    maxWidth: 'calc(100vw - 48px)',
    padding: 0,
    borderRadius: tokens.borderRadiusXLarge,
    marginTop: '120px',
    alignSelf: 'flex-start',
  },
  backdrop: {
    backgroundColor: 'transparent',
  },
  body: {
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  content: {
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: ROW_GAP,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  searchIcon: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: '20px',
  },
  input: {
    flex: 1,
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: tokens.fontSizeBase400,
    '::after': { display: 'none' },
  },
  chip: {
    flexShrink: 0,
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
  },
  listbox: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '340px',
    overflowY: 'auto',
    padding: tokens.spacingHorizontalS,
  },
  heading: {
    display: 'block',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    paddingLeft: `calc(${tokens.spacingHorizontalS} + ${ROW_ICON_SIZE}px + ${ROW_GAP})`,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: ROW_GAP,
    minHeight: '34px',
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusLarge,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowActive: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  rowIcon: {
    flexShrink: 0,
    fontSize: `${ROW_ICON_SIZE}px`,
    color: tokens.colorNeutralForeground2,
  },
  rowIconActive: {
    color: tokens.colorBrandForeground1,
  },
  rowPrefix: {
    flexShrink: 0,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground4,
  },
  rowTitle: {
    flexShrink: 0,
  },
  rowTitleActive: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground2,
  },
  rowSubtitle: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowHint: {
    marginLeft: 'auto',
    flexShrink: 0,
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground4,
  },
  empty: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  footerText: {
    display: 'flex',
    gap: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground4,
  },
  footerKey: {
    fontWeight: tokens.fontWeightSemibold,
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
      <DialogSurface className={styles.surface} backdrop={{ className: styles.backdrop }}>
        <DialogBody className={styles.body}>
          <DialogContent className={styles.content}>
            <div className={styles.header}>
              <SearchRegular className={styles.searchIcon} />
              <Input
                autoFocus
                appearance="underline"
                className={styles.input}
                value={state.query}
                role="combobox"
                aria-expanded={state.rows.length > 0}
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={
                  state.activeIndex >= 0 ? optionId(state.activeIndex) : undefined
                }
                placeholder="Type a command or search…"
                onChange={(_e, data) => dispatch({ type: 'query', query: data.value })}
                onKeyDown={(e) => {
                  const event = paletteKeyEvent(e);
                  if (event) {
                    e.preventDefault();
                    dispatch(event);
                  }
                }}
              />
              {state.ctx.subjectLabel && (
                <Caption1 className={styles.chip}>on {state.ctx.subjectLabel}</Caption1>
              )}
            </div>
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
                    const Icon = item.command.icon ?? GROUP_ICON[item.command.group];
                    const shortcutHint = item.command.shortcut
                      ? shortcutLabel(item.command.shortcut, window)
                      : null;
                    const secondaryHint =
                      active && item.command.secondary
                        ? `${shortcutLabel('mod+enter', window)} ${item.command.secondary.title}`
                        : null;
                    return (
                      <div
                        key={item.command.id}
                        ref={(node) => {
                          optionRefs.current[item.index] = node;
                        }}
                        id={optionId(item.index)}
                        role="option"
                        aria-selected={active}
                        className={active ? mergeClasses(styles.row, styles.rowActive) : styles.row}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          dispatch({ type: 'select', index: item.index });
                        }}
                      >
                        <Icon
                          className={
                            active
                              ? mergeClasses(styles.rowIcon, styles.rowIconActive)
                              : styles.rowIcon
                          }
                        />
                        {item.command.prefix && (
                          <span className={styles.rowPrefix}>{item.command.prefix}</span>
                        )}
                        <Body1
                          className={
                            active
                              ? mergeClasses(styles.rowTitle, styles.rowTitleActive)
                              : styles.rowTitle
                          }
                        >
                          {item.command.title}
                        </Body1>
                        {item.command.subtitle && (
                          <Caption1 className={styles.rowSubtitle}>
                            {item.command.subtitle}
                          </Caption1>
                        )}
                        {(shortcutHint || secondaryHint) && (
                          <span className={styles.rowHint}>
                            {shortcutHint && <Caption1>{shortcutHint}</Caption1>}
                            {secondaryHint && <Caption1>{secondaryHint}</Caption1>}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className={styles.footer}>
              <Caption1 className={styles.footerText}>
                {FOOTER_HINTS.map(([key, word]) => (
                  <span key={key}>
                    <span className={styles.footerKey}>{key}</span> {word}
                  </span>
                ))}
              </Caption1>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
