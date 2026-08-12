/**
 * The files a task carries — the one strip, wherever a brief is written.
 *
 * A card's description and a step's brief are the same kind of thing (prose an agent will
 * be handed) hung off two rows of the same table, so they get one control rather than two
 * that drift. Everything it needs it takes as props: the task's id and its slice of the
 * board's attachment list, which the board owns because a JIRA sync rewrites whole `Task`
 * literals on every poll and anything hung off one would be clobbered.
 *
 * Four things here are deliberate and easy to get wrong:
 *
 * - **A file may be shown here without belonging here.** A step's strip lists its own
 *   files *and* its card's, so a brief can cite the mockup attached once above it
 *   (`attachmentsInScope`). Those inherited chips cite and open like any other, and are the
 *   one thing this strip will not remove — `taskId` is what tells them apart, and the `×`
 *   belongs on the pane the file was attached from.
 * - **The renderer never holds a path.** Adding sends paths main just handed it (the
 *   picker's, or `pathForFile` on a dropped `File`) straight back to main; opening and
 *   previewing go by `id`. `attachmentUrl(id)` is how a locked-down window is allowed to
 *   see a local file at all — see `src/main/attachments.ts`.
 * - **The drop zone is gated on `Files`.** The board already drags cards (`text/plain`)
 *   and chain links (`CHAIN_LINK_MIME`) with the same native mechanism; reading the
 *   TYPE is what keeps three gestures that share a `dragover` from answering each other's
 *   drops. `types` rather than `getData`, because a `dragover` handler is not allowed to
 *   read the payload — only the type list.
 * - **Monochrome.** These are static facts about a card, and the board's colour budget
 *   spends colour on things that move. `color="informative"` is Fluent's grey badge; the
 *   only colour here is on a file that is gone, which is not a fact but a thing to fix.
 */
import { useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AttachRegular } from '@fluentui/react-icons';
import { attachmentUrl, type TaskAttachment } from '@tm/shared/attachments';
import { useTransport } from './transport';

/**
 * Whether the drag in the air is FILES from outside the window, rather than one of the
 * board's own gestures.
 *
 * `'Files'` is the type Chromium puts on a drag that comes from the OS, and it is the only
 * thing this strip ever accepts — so a card being dragged across the detail pane, or an
 * arrow being drawn over it, passes straight through and lands where it was aimed. The
 * mirror of `isChainLinkDrag`, and pure for the same reason: it is the one rule here worth
 * pinning without a browser.
 */
export function isFileDrag(types: readonly string[] | DOMStringList | undefined): boolean {
  // A real array in Chromium, a `DOMStringList` in the DOM spec; `Array.from` covers both.
  return types ? Array.from(types).includes('Files') : false;
}

/** Powers of 1024, since that is what a file manager shows beside the same file. */
const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * A size a human reads at a glance: `812 B`, `12.3 KB`, `1.4 MB`.
 *
 * One decimal above kilobytes and none below it — `1.4 MB` is the useful precision, and
 * `812.0 B` is noise. Anything past gigabytes is clamped rather than growing a unit,
 * because nothing that large is getting attached to a card.
 */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

const useStyles = makeStyles({
  /**
   * The whole strip is the drop target, not a separate dashed box: a zone that only exists
   * while you are dragging is a zone you cannot find, and one that is always drawn is a
   * box around a list of three files. The border is transparent until a file is over it,
   * so nothing moves when it appears.
   */
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '6px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorTransparentStroke}`,
  },
  over: {
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' },
  /** The name inside a chip: a real button, so it is reachable from the keyboard. */
  chipName: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'inherit',
    font: 'inherit',
    padding: 0,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipX: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'inherit',
    padding: '0 0 0 4px',
    fontSize: tokens.fontSizeBase300,
    lineHeight: 1,
  },
  /** A file whose bytes are gone — struck through, so the chip reads as a stub. */
  gone: { textDecoration: 'line-through' },
  previews: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  /**
   * A thumbnail, not the picture: the pane is 40% of the window and a screenshot at its
   * own size would push the conversation off the screen. Clicking opens the real thing in
   * whatever the OS uses for it.
   */
  thumb: {
    maxWidth: '120px',
    maxHeight: '90px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    display: 'block',
    objectFit: 'cover',
  },
  thumbButton: { border: 'none', background: 'none', padding: 0, cursor: 'pointer' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface AttachmentStripProps {
  /**
   * The card or step a NEW file is attached to — a step is a task row, so this is the only
   * key. Also what tells an inherited chip from an own one: see `attachments`.
   */
  taskId: string;
  /**
   * The files in scope here, sliced out of the board's list by whoever owns it. For a card
   * that is its own; for a step it is `attachmentsInScope(own, parent)`, so the mockup
   * attached once to the card can be cited by every step of its plan.
   */
  attachments: readonly TaskAttachment[];
  /**
   * Cite what was just attached, at the caret of the text being edited.
   *
   * Absent when there is nothing to cite INTO — the description is folded shut, or being
   * read rather than edited — and attaching still works then, it just writes no `@name`.
   * Given as a list, not one name at a time: a single pick can bring five files, and five
   * separate calls would each insert into the same stale draft.
   */
  onInsertRefs?: (names: readonly string[]) => void;
  /** True while the section around it is mid-save, so the two cannot race. */
  disabled?: boolean;
  /**
   * Why attaching is off — for a `disabled` that is a standing refusal rather than a
   * moment's busy-ness. Shown on the Attach button, so a control that cannot be pressed
   * says why: a step whose session has started is the case, since its prompt is built.
   */
  disabledHint?: string;
}

export function AttachmentStrip({
  taskId,
  attachments,
  onInsertRefs,
  disabled = false,
  disabledHint,
}: AttachmentStripProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /**
   * Ids whose preview came back empty. The ONLY definitive answer the renderer can get
   * about a file that is gone: it holds no path, so it cannot ask — but the protocol
   * serves a 404 for a row whose bytes are missing, and the `<img>` reports that.
   */
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());

  const locked = disabled || busy;

  /**
   * Copy files in and cite whatever landed.
   *
   * The new ones are the ids the list did not have a moment ago — main answers with the
   * WHOLE board's list, so this is also what filters it back down to this task. On a
   * partial failure main pushes what landed and then throws (so the chips appear either
   * way); nothing is cited in that case, because the answer that names the survivors is
   * the one that did not come back.
   */
  async function add(paths: string[]): Promise<void> {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    const before = new Set(attachments.map((a) => a.id));
    try {
      const all = await transport.invoke('attachment:add', taskId, paths);
      const added = all.filter((a) => a.taskId === taskId && !before.has(a.id));
      if (added.length) onInsertRefs?.(added.map((a) => a.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** The OS picker, then the copy. Main owns both — the renderer only relays the paths. */
  async function pick(): Promise<void> {
    setError(null);
    try {
      await add(await transport.invoke('attachment:pick'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('attachment:remove', id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand the file to the OS. Resolves to the OS's own complaint rather than rejecting, so
   * "no program opens .heic" arrives as a sentence instead of as a dead click.
   */
  async function open(id: string): Promise<void> {
    setError(null);
    try {
      const failure = await transport.invoke('attachment:open', id);
      if (failure) setError(failure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * A chip's name does the thing the moment asks for: while a brief is being edited it
   * writes `@name` into it, and while it is being read it opens the file. One control,
   * because those are never both what you want — and the title says which it is.
   */
  function activate(attachment: TaskAttachment): void {
    if (onInsertRefs) onInsertRefs([attachment.name]);
    else void open(attachment.id);
  }

  /**
   * The host's URL for an attachment, falling back to Electron's custom scheme for a host
   * that does not answer at all. `''` is a deliberate answer meaning "I cannot serve these
   * bytes" — see `Transport.attachmentUrl` — and the previews below are dropped for it,
   * rather than pointed at something that will 404.
   */
  const imageSrc = (id: string): string => transport.attachmentUrl?.(id) ?? attachmentUrl(id);
  const images = attachments.filter(
    (a) => a.mimeType?.startsWith('image/') && !gone.has(a.id) && imageSrc(a.id) !== '',
  );

  return (
    <div
      className={mergeClasses(styles.root, over && styles.over)}
      onDragOver={(e) => {
        // Not ours: a card being dragged across the pane, or an arrow being drawn over it.
        // Returning without `preventDefault` is what lets it land where it was aimed.
        if (!isFileDrag(e.dataTransfer.types) || locked) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer really leaves the strip — not on every child it enters.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e.dataTransfer.types) || locked) return;
        e.preventDefault();
        setOver(false);
        // `File.path` was removed in Electron 32, so the path comes from the preload
        // bridge — the one thing it knows about this feature. Something with no path on
        // disk (a dragged selection, a virtual file) answers '' and is dropped here.
        const paths = Array.from(e.dataTransfer.files)
          .map((file) => transport.pathForFile(file))
          .filter((path) => path !== '');
        if (paths.length) void add(paths);
        else setError('That has no file on disk to attach.');
      }}
    >
      {attachments.length > 0 && (
        <div className={styles.chips}>
          {attachments.map((a) => {
            const missing = gone.has(a.id);
            // Hung off the PARENT card, not off this task — a step is shown its card's
            // files so a brief can cite the mockup that was attached once, above it. It
            // may be cited from here and opened from here, but not REMOVED from here: a
            // × on this row would take the file off the card and every other step of the
            // plan with it, from a pane that mentions neither. It comes off where it went
            // on. A card's own strip never sees this — every file there is its own.
            const inherited = a.taskId !== taskId;
            return (
              <Badge
                key={a.id}
                appearance="tint"
                // The one place colour is spent: a chip pointing at nothing is not a fact
                // about the card, it is a thing to fix.
                color={missing ? 'danger' : 'informative'}
                icon={<AttachRegular />}
                title={
                  missing
                    ? `${a.fileName} — the file is missing; remove the chip or attach it again`
                    : `${a.fileName} · ${formatSize(a.size)} · cite it as @${a.name}${
                        inherited ? ' · attached to the card' : ''
                      }`
                }
              >
                <button
                  type="button"
                  className={mergeClasses(styles.chipName, missing && styles.gone)}
                  title={onInsertRefs ? `Write @${a.name} into the text` : 'Open this file'}
                  onClick={() => activate(a)}
                >
                  {a.name}
                </button>
                {!inherited && (
                  <button
                    type="button"
                    className={styles.chipX}
                    aria-label={`Remove ${a.fileName}`}
                    title="Remove this attachment"
                    disabled={locked}
                    onClick={() => void remove(a.id)}
                  >
                    ×
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      )}

      {/* The picture itself, for the kind of attachment that is only useful as one. WHERE
          from is the host's answer, not this component's: Electron serves
          `vipper-attachment://`, a scheme only it registers, and a browser serves an HTTP
          download. Hardcoding the first is what left every one of these broken on the web. */}
      {images.length > 0 && (
        <div className={styles.previews}>
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.thumbButton}
              title={`Open ${a.fileName}`}
              onClick={() => void open(a.id)}
            >
              <img
                className={styles.thumb}
                src={imageSrc(a.id)}
                alt={a.fileName}
                onError={() => setGone((prev) => new Set(prev).add(a.id))}
              />
            </button>
          ))}
        </div>
      )}

      <div className={styles.row}>
        <Button
          size="small"
          appearance="subtle"
          icon={<AttachRegular />}
          disabled={locked}
          title={disabledHint}
          onClick={() => void pick()}
        >
          Attach
        </Button>
        <Caption1 className={styles.hint}>
          {attachments.length === 0
            ? 'Drop files here — the agent gets the real file, not a description of it.'
            : onInsertRefs
              ? 'Click a file to write its @name where the caret is.'
              : 'Name one as @file in the text and the agent running this gets it.'}
        </Caption1>
      </div>

      {error && <Caption1 className={styles.error}>{error}</Caption1>}
    </div>
  );
}
