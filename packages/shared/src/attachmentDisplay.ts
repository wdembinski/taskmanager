/**
 * How ANY list of attachments splits into the three shapes a human actually reads —
 * independent of `visualSignOff.ts`'s own card panel, and used wherever a run's files need
 * to be shown without sending someone to a step's editor to find them: the Inbox item and
 * the card's "waiting for you" banner (item 7 of the plan this ships with), and the card
 * panel's own "Files" section (item 8).
 *
 * Reuses {@link shotPairs} for the one naming convention worth drawing as a pair rather
 * than two separate thumbnails — `NAME.png` + `NAME-mockup.png` — rather than re-deriving
 * it, so a screen `ui-shots.mjs` wrote is never shown twice, once here and once in the
 * sign-off section.
 */
import type { TaskAttachment } from './attachments';
import { shotPairs, type ShotPair } from './visualSignOff';

export interface AttachmentDisplayGroups {
  /** `NAME.png` + `NAME-mockup.png`, side by side. */
  pairs: readonly ShotPair[];
  /** Every other image — its own thumbnail, full size on open. */
  images: readonly TaskAttachment[];
  /** Everything that is neither part of a pair nor an image — an openable chip. */
  files: readonly TaskAttachment[];
}

/**
 * Split `attachments` into {@link AttachmentDisplayGroups}. `images`/`files` preserve
 * `attachments`' own order; a `.png` that {@link shotPairs} claimed for a pair (the real
 * shot or its mockup) never also appears in `images`.
 */
export function groupAttachmentsForDisplay(
  attachments: readonly TaskAttachment[],
): AttachmentDisplayGroups {
  const { pairs } = shotPairs(attachments);
  const paired = new Set<string>();
  for (const pair of pairs) {
    paired.add(pair.real.id);
    if (pair.mockup) paired.add(pair.mockup.id);
  }

  const images: TaskAttachment[] = [];
  const files: TaskAttachment[] = [];
  for (const a of attachments) {
    if (paired.has(a.id)) continue;
    if (a.mimeType?.startsWith('image/')) images.push(a);
    else files.push(a);
  }
  return { pairs, images, files };
}
