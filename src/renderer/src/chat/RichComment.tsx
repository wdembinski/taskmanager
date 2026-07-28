/**
 * RichComment — a ticket comment rendered with its structure intact.
 *
 * The pane used to show a flattened string, which was fine until you noticed what the
 * flattening threw away. A mention is a node whose label lives in `attrs.text`, so
 * "@Alice can you look" arrived as " can you look" — the app deleted the name of the
 * person the comment was addressed to, which is usually the most important word in it.
 *
 * So mentions render as a tinted inline chip (they are people, not prose), links as
 * real links that open in the browser, and files as a paperclip row under the text.
 * Attachment URLs are authenticated, so they are opened rather than fetched — an inline
 * image would need a `jira:attachmentData` proxy, which can follow later.
 */
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { AttachRegular } from '@fluentui/react-icons';
import type { AdfBlock, AdfSpan, CommentAttachment } from '@shared/adf';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '4px' },
  block: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  heading: { fontWeight: tokens.fontWeightSemibold },
  quote: {
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '8px',
    color: tokens.colorNeutralForeground2,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    padding: '6px 8px',
    overflowX: 'auto',
  },
  inlineCode: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    padding: '0 3px',
  },
  list: { margin: 0, paddingLeft: '20px' },
  /** A person, not prose — so it reads as a distinct object in the sentence. */
  mention: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    borderRadius: tokens.borderRadiusSmall,
    padding: '0 3px',
    fontWeight: tokens.fontWeightSemibold,
  },
  link: { color: tokens.colorBrandForegroundLink },
  files: { display: 'flex', flexWrap: 'wrap', gap: '8px', paddingTop: '2px' },
  file: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: tokens.colorBrandForegroundLink,
  },
});

/** Bytes as something a human reads at a glance. */
function fmtSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '';
  if (bytes < 1024) return ` (${bytes} B)`;
  if (bytes < 1024 * 1024) return ` (${Math.round(bytes / 1024)} KB)`;
  return ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
}

function Spans({ spans }: { spans: readonly AdfSpan[] }): React.JSX.Element {
  const styles = useStyles();
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'mention':
            return (
              <span key={i} className={styles.mention}>
                {span.text}
              </span>
            );
          case 'link':
            return (
              <a
                key={i}
                className={styles.link}
                href={span.href}
                target="_blank"
                rel="noreferrer"
              >
                {span.text}
              </a>
            );
          case 'code':
            return (
              <code key={i} className={styles.inlineCode}>
                {span.text}
              </code>
            );
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

export interface RichCommentProps {
  blocks: readonly AdfBlock[];
  attachments?: readonly CommentAttachment[];
}

export function RichComment({ blocks, attachments = [] }: RichCommentProps): React.JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <div key={i} className={`${styles.block} ${styles.heading}`}>
                <Spans spans={block.spans} />
              </div>
            );
          case 'quote':
            return (
              <div key={i} className={`${styles.block} ${styles.quote}`}>
                <Spans spans={block.spans} />
              </div>
            );
          case 'codeBlock':
            return (
              <pre key={i} className={styles.code}>
                {block.text}
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={i} className={styles.list}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className={styles.list}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ul>
            );
          case 'media':
            return (
              <Caption1 key={i} className={styles.file}>
                <AttachRegular />
                {block.filename ?? 'attachment'}
              </Caption1>
            );
          default:
            return (
              <div key={i} className={styles.block}>
                <Spans spans={block.spans} />
              </div>
            );
        }
      })}

      {attachments.length > 0 && (
        <div className={styles.files}>
          {attachments.map((file) => (
            <Caption1 key={file.filename} className={styles.file}>
              <AttachRegular />
              {file.url ? (
                <a
                  className={styles.link}
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  title={file.mimeType ?? undefined}
                >
                  {file.filename}
                </a>
              ) : (
                file.filename
              )}
              {fmtSize(file.size)}
            </Caption1>
          ))}
        </div>
      )}
    </div>
  );
}
