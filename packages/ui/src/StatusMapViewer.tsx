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
import type { BoardColumn } from '@tm/shared/model';
import type { JiraStatusOption } from '@tm/shared/ipc';
import type { StatusReason } from '@tm/shared/statusResolve';
import { buildStatusMapRows, reasonLabel, type StatusMapViewRow } from './statusMapView';

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
  /** JIRA's statuses, resolved here by JIRA's own resolver. Ignored when `rows` is given. */
  statuses?: readonly JiraStatusOption[];
  /**
   * Pre-resolved rows, for a tracker whose resolver is not JIRA's — GitHub's labels come in
   * this way (`buildGitHubLabelRows`).
   *
   * The alternative was a second table component, and it is the worse one: what this file is
   * FOR is the “Why” column — the surface that would have made the IN REVIEW bug obvious —
   * and a second copy of it would be a second place for that idea to decay. What differs
   * between the two trackers is only who resolved the rows, so that is the only thing lifted
   * out.
   */
  rows?: readonly StatusMapViewRow[];
  /** Why the list is empty, when it is. Null when the fetch simply hasn't run. */
  error?: string | null;
  map?: Record<string, BoardColumn>;
  learned?: Record<string, BoardColumn>;
  columnLabel: Record<BoardColumn, string>;
  /** What the first column is called — “Status”, “Label”. */
  nameHeader?: string;
  /**
   * The tracker's own classification column. **Null hides it**, which is what GitHub does:
   * an issue has no category, and a blank column with a JIRA heading over it would be
   * inviting the reader to wonder what should be in it.
   */
  categoryHeader?: string | null;
  /** What to say when there is nothing to show. */
  emptyText?: string;
  /** Promote a name into the explicit map with the column it currently resolves to. */
  onPin: (name: string, column: BoardColumn) => void;
}

export function StatusMapViewer({
  statuses,
  rows: given,
  error,
  map,
  learned,
  columnLabel,
  nameHeader = 'Status',
  categoryHeader = 'JIRA category',
  emptyText = 'Save a working JIRA connection and this lists every status your instance defines, with the column it resolves to.',
  onPin,
}: StatusMapViewerProps): React.JSX.Element {
  const styles = useStyles();
  const rows = given ?? buildStatusMapRows(statuses ?? [], map, learned);

  if (!rows.length) {
    return (
      <Body1 className={styles.empty}>
        {error ? `Your instance's statuses could not be read — ${error}` : emptyText}
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <Table
          size="extra-small"
          aria-label={`How each ${nameHeader.toLowerCase()} resolves to a board column`}
        >
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{nameHeader}</TableHeaderCell>
              {categoryHeader !== null && <TableHeaderCell>{categoryHeader}</TableHeaderCell>}
              <TableHeaderCell>Resolves to</TableHeaderCell>
              <TableHeaderCell>Why</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.name}>
                <TableCell className={styles.name}>{row.name}</TableCell>
                {categoryHeader !== null && (
                  <TableCell className={styles.muted}>{row.category}</TableCell>
                )}
                <TableCell>{columnLabel[row.column]}</TableCell>
                <TableCell className={styles.whyCell}>
                  <Badge appearance="tint" color={REASON_APPEARANCE[row.reason]}>
                    {row.why ?? reasonLabel(row.reason, row.column)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {row.reason !== 'explicit' && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<PinRegular />}
                      title={`Pin this ${nameHeader.toLowerCase()} to the column it resolves to, as an explicit mapping`}
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
        Pin a row to turn what the engine worked out into a mapping you own — then it can never
        change under you.
      </Caption1>
    </div>
  );
}
