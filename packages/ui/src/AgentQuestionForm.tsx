/**
 * The form a human answers an agent's `AskUserQuestion` with.
 *
 * ## Why this is its own component
 *
 * Every other attention kind is a yes/no with an optional note, and the panel renders
 * those inline in a dozen lines. A question is different in three ways at once: there can
 * be SEVERAL of them in one call, each may accept more than one answer, and every option
 * carries a description that is the whole reason a structured question beats free text.
 * Squeezing that into the flat `options: string[]` path meant showing bare labels with no
 * descriptions — the version of the form that was unreadable.
 *
 * ## The shape of an answer
 *
 * Positional against `questions`: `selections[i]` are the chosen labels for question `i`,
 * and `freeText[i]` is what the human typed instead of picking. Positional rather than
 * keyed by header because a header is the CLI's own short chip label — it may be empty,
 * and nothing stops two questions sharing one.
 *
 * "Let the agent decide" is a `deny`, and it is deliberately a BUTTON rather than a
 * timeout: the agent gets to choose only because a human said so. That distinction is the
 * entire reason this attention kind exists.
 */
import { useMemo, useState } from 'react';
import {
  Button,
  Caption1,
  Checkbox,
  Radio,
  RadioGroup,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { AttentionAnswer, AttentionQuestion } from '@tm/shared/attention';
import { Markdown } from './chat/MarkdownView';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },
  /** One question: its chip, its text, its options. */
  question: { display: 'flex', flexDirection: 'column', gap: '6px' },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '1px 7px',
    borderRadius: '4px',
  },
  /** Agents write backticked identifiers into these, so the text is markdown. */
  prompt: { fontWeight: 600 },
  options: { display: 'flex', flexDirection: 'column', gap: '2px' },
  /**
   * An option is a row you can click anywhere on, not a bare radio with a label — the
   * description is the point, and it has to be part of the target.
   */
  option: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand.
  optionChosen: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /** Indented under its control so it reads as belonging to that option. */
  optionWhy: { color: tokens.colorNeutralForeground3, paddingLeft: '28px' },
  actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface AgentQuestionFormProps {
  questions: readonly AttentionQuestion[];
  /** Disables every control while an answer is in flight. */
  busy?: boolean;
  onAnswer: (answer: AttentionAnswer) => void;
}

export function AgentQuestionForm({
  questions,
  busy = false,
  onAnswer,
}: AgentQuestionFormProps): JSX.Element {
  const styles = useStyles();
  // Indexed by question. Chosen labels, and the free text that replaces them.
  const [selections, setSelections] = useState<string[][]>(() => questions.map(() => []));
  const [freeText, setFreeText] = useState<string[]>(() => questions.map(() => ''));

  const choose = (qi: number, label: string, multi: boolean): void => {
    setSelections((prev) => {
      const next = prev.map((row) => [...row]);
      if (!multi) {
        next[qi] = [label];
      } else if (next[qi].includes(label)) {
        next[qi] = next[qi].filter((l) => l !== label);
      } else {
        next[qi] = [...next[qi], label];
      }
      return next;
    });
  };

  /**
   * Every question must have an answer — a chosen option OR typed text. A partly filled
   * form cannot be sent, because the agent would have to guess the rest, which is the
   * behaviour this whole path exists to prevent.
   */
  const complete = useMemo(
    () => questions.every((_q, i) => selections[i]?.length > 0 || freeText[i]?.trim().length > 0),
    [questions, selections, freeText],
  );

  return (
    <div className={styles.root}>
      {questions.map((q, qi) => (
        <div key={`${qi}-${q.header}`} className={styles.question}>
          {q.header && <span className={styles.chip}>{q.header}</span>}
          <div className={styles.prompt}>
            <Markdown source={q.question} />
          </div>
          {q.multiSelect && <Caption1 className={styles.hint}>Choose as many as apply.</Caption1>}

          <div className={styles.options}>
            {q.multiSelect
              ? q.options.map((opt) => {
                  const chosen = selections[qi]?.includes(opt.label) ?? false;
                  return (
                    <label
                      key={opt.label}
                      className={`${styles.option} ${chosen ? styles.optionChosen : ''}`}
                    >
                      <Checkbox
                        checked={chosen}
                        disabled={busy}
                        label={opt.label}
                        onChange={() => choose(qi, opt.label, true)}
                      />
                      {opt.description && (
                        <Caption1 className={styles.optionWhy}>{opt.description}</Caption1>
                      )}
                    </label>
                  );
                })
              : null}

            {/* Single-select goes through one RadioGroup so arrow keys move between the
                options, which is what a keyboard user expects of a single choice. */}
            {!q.multiSelect && (
              <RadioGroup
                value={selections[qi]?.[0] ?? ''}
                onChange={(_e, d) => choose(qi, d.value, false)}
              >
                {q.options.map((opt) => {
                  const chosen = selections[qi]?.[0] === opt.label;
                  return (
                    <label
                      key={opt.label}
                      className={`${styles.option} ${chosen ? styles.optionChosen : ''}`}
                    >
                      <Radio value={opt.label} disabled={busy} label={opt.label} />
                      {opt.description && (
                        <Caption1 className={styles.optionWhy}>{opt.description}</Caption1>
                      )}
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </div>

          <Textarea
            value={freeText[qi] ?? ''}
            resize="vertical"
            disabled={busy}
            placeholder={q.options.length > 0 ? 'Or answer in your own words…' : 'Your answer…'}
            onChange={(_e, d) =>
              setFreeText((prev) => prev.map((t, i) => (i === qi ? d.value : t)))
            }
          />
        </div>
      ))}

      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={busy || !complete}
          title={complete ? undefined : 'Answer every question first.'}
          onClick={() =>
            onAnswer({
              decision: 'answers',
              selections,
              freeText: freeText.map((t) => (t.trim() ? t.trim() : null)),
            })
          }
        >
          Send answer
        </Button>
        <span className={styles.grow} />
        {/* The ONLY path by which the agent chooses — and it takes a deliberate click. */}
        <Button
          disabled={busy}
          title="The agent picks its own recommended option and carries on."
          onClick={() => onAnswer({ decision: 'deny', note: 'Use your own judgement.' })}
        >
          Let the agent decide
        </Button>
      </div>
      {!complete && (
        <Caption1 className={styles.hint}>
          <Text weight="semibold">
            {questions.length === 1 ? 'This question' : 'Every question'}
          </Text>{' '}
          needs an answer — pick an option or type one.
        </Caption1>
      )}
    </div>
  );
}
