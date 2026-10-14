/**
 * The unified diff: every changed file, stacked in the order the summary listed them, each
 * either collapsed to its own header row or showing the patch `ReviewPane` lazily fetched
 * for it. One component rather than "one file at a time" on screen, because {@link
 * FileTree}'s "selecting a file scrolls to it" only makes sense if every expanded file is
 * already on the page to scroll to.
 *
 * Word-level highlights are computed per HUNK, never across the whole file: `pairWordDiffs`
 * pairs a del run with the add run immediately after it, and two hunks are themselves
 * separated by lines neither hunk carries, so pairing across that gap would highlight two
 * lines that were never adjacent in the real file.
 *
 * Colour budget (memory *board-colour-budget*, and F6's own design doc): the ONLY colour
 * here is added/removed content — a line's own tint at its subtlest step, and the inner
 * word highlight one step stronger so it reads against that tint. Everything else
 * (gutters, headers, notices) stays on neutral tokens.
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { isCollapsedByDefault } from '@tm/shared/review';
import type {
  DiffFileEntry,
  DiffHunk,
  DiffImage,
  DiffImageSide,
  DiffLine,
  DiffSummary,
  WordSegment,
} from '@tm/shared/review';
import { MONO, fontPx } from '../theme';
import { useTransport } from '../transport';
import type { FileLoad } from './reviewState';
import { pairWordDiffs, statusLetter } from './reviewView';

const useStyles = makeStyles({
  root: {
    flex: '2 1 480px',
    minWidth: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  file: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  fileHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  letter: {
    fontFamily: MONO,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  path: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: fontPx(12),
  },
  added: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  deleted: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  notice: { padding: '10px', color: tokens.colorNeutralForeground3 },
  hunkHeader: {
    padding: '4px 8px',
    color: tokens.colorNeutralForeground3,
    fontFamily: MONO,
    fontSize: fontPx(11),
    backgroundColor: tokens.colorNeutralBackground4,
  },
  line: {
    display: 'flex',
    fontFamily: MONO,
    fontSize: fontPx(12),
    whiteSpace: 'pre-wrap',
  },
  lineAdd: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  lineDel: { backgroundColor: tokens.colorPaletteRedBackground1 },
  gutter: {
    flexShrink: 0,
    width: '44px',
    textAlign: 'right',
    paddingRight: '8px',
    color: tokens.colorNeutralForeground4,
    userSelect: 'none',
  },
  text: { flex: 1, minWidth: 0, paddingRight: '8px' },
  wordAdd: { backgroundColor: tokens.colorPaletteGreenBackground2 },
  wordDel: { backgroundColor: tokens.colorPaletteRedBackground2 },
  images: { display: 'flex', gap: '12px', padding: '10px', flexWrap: 'wrap' },
  imageFigure: { margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
  imagePreview: { maxWidth: '320px', maxHeight: '320px', borderRadius: tokens.borderRadiusSmall },
});

export interface DiffViewProps {
  taskId: string;
  diffId: string;
  summary: DiffSummary;
  files: Readonly<Record<string, FileLoad>>;
  expanded: readonly string[];
  selectedPath: string | null;
  onToggleExpanded: (path: string) => void;
}

export function DiffView({
  taskId,
  diffId,
  summary,
  files,
  expanded,
  selectedPath,
  onToggleExpanded,
}: DiffViewProps): JSX.Element {
  const styles = useStyles();
  const rows = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!selectedPath) return;
    rows.current[selectedPath]?.scrollIntoView({ block: 'nearest' });
  }, [selectedPath]);

  return (
    <div className={styles.root}>
      {summary.files.map((entry) => (
        <div
          key={entry.path}
          ref={(el) => {
            rows.current[entry.path] = el;
          }}
        >
          <FileSection
            taskId={taskId}
            diffId={diffId}
            entry={entry}
            expanded={expanded.includes(entry.path)}
            load={files[entry.path]}
            onToggleExpanded={onToggleExpanded}
          />
        </div>
      ))}
    </div>
  );
}

function FileSection({
  taskId,
  diffId,
  entry,
  expanded,
  load,
  onToggleExpanded,
}: {
  taskId: string;
  diffId: string;
  entry: DiffFileEntry;
  expanded: boolean;
  load: FileLoad | undefined;
  onToggleExpanded: (path: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const renamed = entry.oldPath !== undefined && entry.oldPath !== entry.path;
  const collapsedByDefault = isCollapsedByDefault(entry);

  return (
    <div className={styles.file}>
      <div className={styles.fileHeader}>
        <Caption1 className={styles.letter}>{statusLetter(entry.status)}</Caption1>
        <Caption1 className={styles.path} title={entry.path}>
          {renamed ? `${entry.oldPath} → ${entry.path}` : entry.path}
        </Caption1>
        {entry.additions > 0 && <Caption1 className={styles.added}>+{entry.additions}</Caption1>}
        {entry.deletions > 0 && <Caption1 className={styles.deleted}>-{entry.deletions}</Caption1>}
        <Button size="small" appearance="subtle" onClick={() => onToggleExpanded(entry.path)}>
          {expanded ? 'Collapse' : collapsedByDefault ? 'Load anyway' : 'Expand'}
        </Button>
      </div>
      {expanded && <FileBody taskId={taskId} diffId={diffId} entry={entry} load={load} />}
    </div>
  );
}

function FileBody({
  taskId,
  diffId,
  entry,
  load,
}: {
  taskId: string;
  diffId: string;
  entry: DiffFileEntry;
  load: FileLoad | undefined;
}): JSX.Element {
  const styles = useStyles();

  if (entry.image) {
    return <ImageDiffBody taskId={taskId} diffId={diffId} path={entry.path} />;
  }
  if (entry.binary) {
    return (
      <Caption1 className={styles.notice}>
        Binary file · {entry.bytes.toLocaleString()} bytes
      </Caption1>
    );
  }
  if (load === undefined || load.status === 'idle') {
    return load?.error !== undefined ? (
      <Caption1 className={styles.notice}>Couldn&apos;t load this file: {load.error}</Caption1>
    ) : (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      </div>
    );
  }
  if (load.status === 'loading') {
    return (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      </div>
    );
  }
  if (load.status === 'tooLarge') {
    return (
      <Caption1 className={styles.notice}>
        This file is too large to show here ({load.bytes.toLocaleString()} bytes) — open it in your
        editor.
      </Caption1>
    );
  }
  if (load.status === 'stale') {
    return (
      <Caption1 className={styles.notice}>
        The files changed since this was loaded — reload to see the latest.
      </Caption1>
    );
  }

  return (
    <div>
      {load.file.hunks.map((hunk, i) => (
        <Hunk key={i} hunk={hunk} />
      ))}
    </div>
  );
}

function Hunk({ hunk }: { hunk: DiffHunk }): JSX.Element {
  const styles = useStyles();
  const words = pairWordDiffs(hunk.lines);
  return (
    <div>
      <Caption1 className={styles.hunkHeader}>{hunk.header}</Caption1>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} words={words[i]} />
      ))}
    </div>
  );
}

function DiffLineRow({
  line,
  words,
}: {
  line: DiffLine;
  words: readonly WordSegment[] | null;
}): JSX.Element {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(
        styles.line,
        line.kind === 'add' && styles.lineAdd,
        line.kind === 'del' && styles.lineDel,
      )}
    >
      <span className={styles.gutter}>{line.oldLine ?? ''}</span>
      <span className={styles.gutter}>{line.newLine ?? ''}</span>
      <span className={styles.text}>
        {words
          ? words.map((segment, i) => (
              <span
                key={i}
                data-word={segment.kind}
                className={mergeClasses(
                  segment.kind === 'add' && styles.wordAdd,
                  segment.kind === 'del' && styles.wordDel,
                )}
              >
                {segment.text}
              </span>
            ))
          : line.text || ' '}
      </span>
    </div>
  );
}

type ImageLoad =
  | { status: 'loading' }
  | { status: 'loaded'; image: DiffImage }
  | { status: 'stale' }
  | { status: 'error'; message: string };

function ImageDiffBody({
  taskId,
  diffId,
  path,
}: {
  taskId: string;
  diffId: string;
  path: string;
}): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [state, setState] = useState<ImageLoad>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void transport.invoke('task:diffImage', taskId, diffId, path).then(
      (result) => {
        if (!live) return;
        setState(
          result.status === 'ok' ? { status: 'loaded', image: result.image } : { status: 'stale' },
        );
      },
      (e: unknown) => {
        if (!live) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [transport, taskId, diffId, path]);

  if (state.status === 'loading') {
    return (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading image…" labelPosition="after" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <Caption1 className={styles.notice}>Couldn&apos;t load this image: {state.message}</Caption1>
    );
  }
  if (state.status === 'stale') {
    return (
      <Caption1 className={styles.notice}>
        The files changed since this was loaded — reload to see the latest.
      </Caption1>
    );
  }

  return (
    <div className={styles.images}>
      <ImageSide label="Before" side={state.image.old} />
      <ImageSide label="After" side={state.image.new} />
    </div>
  );
}

function ImageSide({ label, side }: { label: string; side: DiffImageSide | null }): JSX.Element {
  const styles = useStyles();
  if (side === null) {
    return <Body1 className={styles.notice}>{label}: none</Body1>;
  }
  if ('tooLarge' in side) {
    return (
      <Body1 className={styles.notice}>
        {label}: too large to preview ({side.bytes.toLocaleString()} bytes)
      </Body1>
    );
  }
  return (
    <figure className={styles.imageFigure}>
      <figcaption>
        <Caption1>{label}</Caption1>
      </figcaption>
      <img
        className={styles.imagePreview}
        src={`data:${side.mime};base64,${side.base64}`}
        alt={`${label} version`}
      />
    </figure>
  );
}
