/**
 * Renders the blocks `markdown.ts` parses (Phase 12, phase 5).
 *
 * Fenced code gets its own panel with the language and a copy button — the one piece of
 * an agent's answer people take away with them. There is no syntax highlighting: it
 * would mean a dependency several times the size of this whole module, and monospace on
 * a contrasting surface is what makes code readable at this size anyway.
 */
import { useState } from 'react';
import { Button, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkRegular, CopyRegular } from '@fluentui/react-icons';
import { parseInline, parseMarkdown, type Inline } from './markdown';
import { CODE_BG, CODE_BORDER, CODE_INLINE_BG, MONO, fontPx } from '../theme';

const useStyles = makeStyles({
  // 10px between blocks, and a line height with room to breathe: an agent's answer is
  // prose, and prose set solid is the thing people call "a wall of text".
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 },
  para: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.55' },
  heading: { fontWeight: tokens.fontWeightSemibold, marginTop: '6px' },
  list: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '4px' },
  item: { display: 'flex', gap: '8px', alignItems: 'baseline' },
  bullet: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  quote: {
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
    paddingLeft: '10px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  code: {
    fontFamily: MONO,
    fontSize: fontPx(12),
    // Blue-tinted, not neutral: against the pane's dark grey a neutral fill was nearly
    // invisible, so `an inline span` read as ordinary prose.
    backgroundColor: CODE_INLINE_BG,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusSmall,
    padding: '1px 5px',
  },
  codeBlock: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${CODE_BORDER}`,
    backgroundColor: CODE_BG,
    overflow: 'hidden',
  },
  codeHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '2px 4px 2px 10px',
    borderBottom: `1px solid ${CODE_BORDER}`,
  },
  lang: { color: tokens.colorNeutralForeground3 },
  grow: { flex: 1 },
  /** Wide code scrolls inside its panel — never widening the pane. */
  pre: {
    margin: 0,
    padding: '8px 10px',
    overflowX: 'auto',
    fontFamily: MONO,
    fontSize: fontPx(12),
    lineHeight: '1.5',
  },
  link: { color: tokens.colorBrandForegroundLink },
});

function InlineRun({ parts }: { parts: Inline[] }): JSX.Element {
  const styles = useStyles();
  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === 'code')
          return (
            <span key={i} className={styles.code}>
              {part.text}
            </span>
          );
        if (part.kind === 'strong')
          return (
            <Text key={i} weight="semibold">
              {part.text}
            </Text>
          );
        if (part.kind === 'em') return <em key={i}>{part.text}</em>;
        if (part.kind === 'link')
          return (
            <a
              key={i}
              className={styles.link}
              href={part.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {part.text}
            </a>
          );
        return <span key={i}>{part.text}</span>;
      })}
    </>
  );
}

/**
 * Copy to the clipboard, falling back to the old `execCommand` path. The async
 * Clipboard API needs a secure context, which a packaged `file://` renderer is not
 * always treated as — and a Copy button that silently does nothing is worse than none.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

function CodeBlock({ lang, code }: { lang: string | null; code: string }): JSX.Element {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <Caption1 className={styles.lang}>{lang ?? 'code'}</Caption1>
        <span className={styles.grow} />
        <Button
          size="small"
          appearance="subtle"
          icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
          onClick={() => {
            void copyText(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={styles.pre}>{code}</pre>
    </div>
  );
}

/** One markdown document — an agent turn, or any other body worth formatting. */
export function Markdown({ source }: { source: string }): JSX.Element {
  const styles = useStyles();
  const blocks = parseMarkdown(source);
  return (
    <div className={styles.root}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={i} lang={block.lang} code={block.code} />;
          case 'heading':
            return (
              <Text key={i} className={styles.heading} size={block.level <= 2 ? 400 : 300}>
                <InlineRun parts={parseInline(block.text)} />
              </Text>
            );
          case 'list':
            return (
              <div key={i} className={styles.list}>
                {block.items.map((item, j) => (
                  <div key={j} className={styles.item}>
                    <span className={styles.bullet}>{block.ordered ? `${j + 1}.` : '•'}</span>
                    <span className={styles.para}>
                      <InlineRun parts={parseInline(item)} />
                    </span>
                  </div>
                ))}
              </div>
            );
          case 'quote':
            return (
              <div key={i} className={styles.quote}>
                <InlineRun parts={parseInline(block.text)} />
              </div>
            );
          default:
            return (
              <div key={i} className={styles.para}>
                <InlineRun parts={parseInline(block.text)} />
              </div>
            );
        }
      })}
    </div>
  );
}
