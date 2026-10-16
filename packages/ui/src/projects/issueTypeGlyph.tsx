/**
 * A ticket's own type icon — the same outline glyph wherever a card's type shows:
 * `BacklogTable`'s table, `GraphPane`'s nodes, `TaskLinksSection`'s linked-ticket rows. Keyed by
 * `TypeIconKey` (`@tm/shared/tickets`), the external-ticket superset of `IssueType`, so a caller
 * holding a native ticket's own `IssueType` can pass it straight through without resolving it
 * first. Monochrome on purpose — see `board-colour-budget`: colour is for things that MOVE, and
 * a ticket's type never does.
 */
import {
  BeakerRegular,
  BookmarkRegular,
  BugRegular,
  NoteRegular,
  PersonRegular,
  SparkleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { TypeIconKey } from '@tm/shared/tickets';

const TYPE_ICON: Record<TypeIconKey, JSX.Element> = {
  epic: <SparkleRegular />,
  story: <BookmarkRegular />,
  task: <TaskListSquareLtrRegular />,
  bug: <BugRegular />,
  subtask: <PersonRegular />,
  feature: <BeakerRegular />,
  note: <NoteRegular />,
};

export function issueTypeGlyph(key: TypeIconKey): JSX.Element {
  return TYPE_ICON[key];
}
