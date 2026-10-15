/**
 * VariantCompare — the compare view (F10.5) for a ×N leader's task detail pane.
 *
 * Reads `variants:summary` the same way `ReviewPane` reads a diff summary: on mount/id
 * change, reloaded on `task:changed` for the leader or one of its rows, stale responses
 * dropped by a `seq` ref. `compareColumns` (the pure model, same ticket) turns the rows
 * into one grid column per variant; a fold per column lazily mounts that variant's own
 * `ReviewPane` only once opened, so comparing three variants never fetches three diffs
 * nobody asked to see.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { VariantSummaryRow } from '@tm/shared/variants';
import { FoldToggle } from './FoldToggle';
import { ReviewPane } from './review/ReviewPane';
import { STATUS_COLOR } from './taskStatus';
import { useTransport } from './transport';
import { compareColumns } from './compareColumns';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  muted: { color: tokens.colorNeutralForeground3 },
  grid: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '1fr',
    gridTemplateRows: 'repeat(6, auto)',
    gap: '8px',
    alignItems: 'start',
  },
  changes: { display: 'flex', flexDirection: 'column', gap: '8px' },
});

export interface VariantCompareProps {
  leaderId: string;
  onPick?: (variantId: string) => void;
}

export function VariantCompare({ leaderId, onPick }: VariantCompareProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const [rows, setRows] = useState<VariantSummaryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const result = await transport.invoke('variants:summary', leaderId);
      if (mySeq !== seq.current) return;
      setError(null);
      setRows(result);
    } catch (e: unknown) {
      if (mySeq !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [transport, leaderId]);

  useEffect(() => {
    setRows([]);
    setError(null);
    setOpenIds(new Set());
    void load();
  }, [load]);

  useEffect(
    () =>
      transport.on('task:changed', (change) => {
        if (change.task.id === leaderId || change.task.variantOf === leaderId) void load();
      }),
    [transport, leaderId, load],
  );

  const columns = compareColumns(rows);
  if (columns.length === 0 && !error) return null;

  const toggle = (id: string): void =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {columns.length > 0 && (
        <>
          <div className={styles.head}>
            <Body1>Variants</Body1>
            <Caption1 className={styles.muted}>({columns.length})</Caption1>
          </div>
          <div className={styles.grid}>
            {columns.flatMap((col) => [
              <Text key={`${col.id}-heading`} weight="semibold">
                {col.heading}
              </Text>,
              <Badge key={`${col.id}-status`} appearance="tint" color={STATUS_COLOR[col.status]}>
                {col.statusLabel}
              </Badge>,
              <Caption1 key={`${col.id}-cost`}>{col.costText}</Caption1>,
              <Caption1 key={`${col.id}-diff`}>{col.diffText}</Caption1>,
              <Caption1 key={`${col.id}-summary`}>{col.summary}</Caption1>,
              <Button
                key={`${col.id}-pick`}
                size="small"
                disabled={!col.pickable || !onPick}
                title={col.pickHint ?? undefined}
                onClick={() => onPick?.(col.id)}
              >
                Pick
              </Button>,
            ])}
          </div>
          <div className={styles.changes}>
            {columns.map((col) => {
              const open = openIds.has(col.id);
              return (
                <div key={col.id}>
                  <FoldToggle open={open} onToggle={() => toggle(col.id)}>
                    <Text weight="semibold">{col.heading} changes</Text>
                  </FoldToggle>
                  {open && <ReviewPane taskId={col.id} />}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
