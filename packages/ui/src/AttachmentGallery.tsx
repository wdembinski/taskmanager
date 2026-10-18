/**
 * AttachmentGallery — the files a run produced, wherever a human reads them without going
 * near a step's editor: the Inbox item and the card's "waiting for you" banner (both read
 * this off whichever task the live question belongs to), and the card panel's own "Files"
 * section (`FilesSection.tsx`, grouped by step).
 *
 * `@tm/shared/attachmentDisplay`'s `groupAttachmentsForDisplay` does the sorting into
 * `pairs`/`images`/`files`; this only draws the three shapes. Opening one branches on the
 * host exactly once, in {@link Openable} below, rather than in every thumbnail and chip:
 * the desktop hands off to `attachment:open` (the OS's own viewer/app), and the web host —
 * which that channel always refuses — opens `transport.attachmentUrl`'s own link in a new
 * tab instead, the browser's native "view full size" / download.
 */
import type { ReactNode } from 'react';
import { Badge, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { AttachRegular } from '@fluentui/react-icons';
import { attachmentUrl, type TaskAttachment } from '@tm/shared/attachments';
import { groupAttachmentsForDisplay } from '@tm/shared/attachmentDisplay';
import { type Transport, useTransport } from './transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  pairs: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  pair: { display: 'flex', gap: '4px' },
  images: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  thumbButton: {
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    display: 'block',
  },
  thumb: {
    maxWidth: '96px',
    maxHeight: '72px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'block',
    objectFit: 'cover',
  },
  chipLink: { textDecoration: 'none', color: 'inherit' },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** `transport.attachmentUrl?.(a) ?? attachmentUrl(a.id)` — `AttachmentStrip.tsx`'s own
 *  expression, so an image preview resolves the same way everywhere it is used. */
function imageSrc(transport: Transport, a: TaskAttachment): string {
  return transport.attachmentUrl?.(a) ?? attachmentUrl(a.id);
}

/**
 * Wraps `children` so clicking opens `a` — a `<button>` calling `attachment:open` on every
 * host but the web, where that channel always rejects; there it is an `<a>` over
 * `transport.attachmentUrl`'s own link (opened in a new tab), or nothing clickable at all
 * when that comes back `''` ("this host can't serve these bytes yet").
 */
function Openable({
  a,
  className,
  children,
}: {
  a: TaskAttachment;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const transport = useTransport();
  if (transport.host === 'web') {
    const href = transport.attachmentUrl?.(a) ?? '';
    if (!href) return <span className={className}>{children}</span>;
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={`Open ${a.fileName}`}
      onClick={() => void transport.invoke('attachment:open', a.id)}
    >
      {children}
    </button>
  );
}

export interface AttachmentGalleryProps {
  attachments: readonly TaskAttachment[];
}

/** Renders nothing for an empty (or entirely-unrecognized) list. */
export function AttachmentGallery({ attachments }: AttachmentGalleryProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const { pairs, images, files } = groupAttachmentsForDisplay(attachments);

  if (pairs.length === 0 && images.length === 0 && files.length === 0) return null;

  return (
    <div className={styles.root} data-attachment-gallery>
      {pairs.length > 0 && (
        <div className={styles.pairs}>
          {pairs.map((pair) => (
            <div key={pair.name} className={styles.pair}>
              <Openable a={pair.real} className={styles.thumbButton}>
                <img
                  className={styles.thumb}
                  src={imageSrc(transport, pair.real)}
                  alt={pair.name}
                />
              </Openable>
              {pair.mockup && (
                <Openable a={pair.mockup} className={styles.thumbButton}>
                  <img
                    className={styles.thumb}
                    src={imageSrc(transport, pair.mockup)}
                    alt={`${pair.name} — mockup`}
                  />
                </Openable>
              )}
            </div>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((a) => (
            <Openable key={a.id} a={a} className={styles.thumbButton}>
              <img className={styles.thumb} src={imageSrc(transport, a)} alt={a.fileName} />
            </Openable>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className={styles.chips}>
          {files.map((a) => (
            <Openable key={a.id} a={a} className={styles.chipLink}>
              <Badge appearance="tint" color="informative" icon={<AttachRegular />}>
                {a.fileName}
              </Badge>
            </Openable>
          ))}
        </div>
      )}

      {transport.host === 'web' &&
        [
          ...pairs.flatMap((p) => [p.real, ...(p.mockup ? [p.mockup] : [])]),
          ...images,
          ...files,
        ].some((a) => !(transport.attachmentUrl?.(a) ?? '')) && (
          <Caption1 className={styles.hint}>
            Some files aren&apos;t pushed to the cloud yet — open them from the desktop.
          </Caption1>
        )}
    </div>
  );
}
