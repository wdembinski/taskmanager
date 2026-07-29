/**
 * StatusMapViewer — "here is where every one of your statuses actually lands".
 *
 * The editor above it says what you asked for. This says what the engine will DO, which
 * is not the same thing until every status is mapped — and it is the gap between the two
 * that made the IN REVIEW bug invisible for a week. So the load-bearing column is not
 * "Resolves to" but **Why**: mapped by you, learned from a move, guessed from the name,
 * or JIRA's own category.
 *
 * Pin promotes a row into the explicit editor, which is the whole workflow: see a status
 * resolving somewhere you don't like, pin it, change the column.
 */
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PinRegular } from '@fluentui/react-icons';
import type { BoardColumn } from '@shared/model';
import type { JiraStatusOption } from '@shared/ipc';
import type { StatusReason } from '@shared/statusResolve';
import { buildStatusMapRows, reasonLabel } from './statusMapView';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  // The table can outgrow the pane on an instance with a big workflow; scroll it in
  // place rather than letting it stretch the Settings column.
  scroll: { maxHeight: '340px', overflowY: 'auto' },
  name: { fontWeight: tokens.fontWeightSemibold },
  /**
   * The "Why" cell. Fluent's Badge is a fixed-height pill built for one short word, so a
   * label like "Learned from a move" wrapped INSIDE it and spilled out of its own
   * background. Keeping the text on one line and letting the cell be as wide as it needs
   * is the fix; the column is the narrowest in the table, so there is room to give.
   */
  whyCell: { whiteSpace: 'nowrap', width: '1%' },
  muted: { color: tokens.colorNeutralForeground3 },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
});

/**
 * A tier's badge colour. Only `heuristic` is tinted as a warning — it is the one row
 * type that is a guess, and the one worth converting into an explicit mapping.
 */
const REASON_APPEARANCE: Record<StatusReason, 'brand' | 'success' | 'warning' | 'subtle'> = {
  explicit: 'brand',
  learned: 'success',
  heuristic: 'warning',
  category: 'subtle',
};

export interface StatusMapViewerProps {
  statuses: readonly JiraStatusOption[];
  /** Why the list is empty, when it is. Null when the fetch simply hasn't run. */
  error?: string | null;
  map?: Record<string, BoardColumn>;
  learned?: Record<string, BoardColumn>;
  columnLabel: Record<BoardColumn, string>;
  /** Promote a status into the explicit map with the column it currently resolves to. */
  onPin: (name: string, column: BoardColumn) => void;
}

export function StatusMapViewer({
  statuses,
  error,
  map,
  learned,
  columnLabel,
  onPin,
}: StatusMapViewerProps): React.JSX.Element {
  const styles = useStyles();
  const rows = buildStatusMapRows(statuses, map, learned);

  if (!rows.length) {
    return (
      <Body1 className={styles.empty}>
        {error
          ? `Your instance's statuses could not be read — ${error}`
          : 'Save a working JIRA connection and this lists every status your instance defines, with the column it resolves to.'}
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <Table size="extra-small" aria-label="How each JIRA status resolves to a board column">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>JIRA category</TableHeaderCell>
              <TableHeaderCell>Resolves to</TableHeaderCell>
              <TableHeaderCell>Why</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.name}>
                <TableCell className={styles.name}>{row.name}</TableCell>
                <TableCell className={styles.muted}>{row.category}</TableCell>
                <TableCell>{columnLabel[row.column]}</TableCell>
                <TableCell className={styles.whyCell}>
                  <Badge appearance="tint" color={REASON_APPEARANCE[row.reason]}>
                    {reasonLabel(row.reason)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {row.reason !== 'explicit' && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<PinRegular />}
                      title="Pin this status to the column it resolves to, as an explicit mapping"
                      aria-label={`Pin ${row.name} to ${columnLabel[row.column]}`}
                      onClick={() => onPin(row.name, row.column)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Caption1 className={styles.muted}>
        Pin a row to turn what the engine worked out into a mapping you own — then it can
        never change under you.
      </Caption1>
    </div>
  );
}
