/**
 * The card's composer — one box, three destinations, and a footer that says who is
 * about to run and how.
 *
 * Shaped after the Claude Code chat input the user asked for: the text area and its
 * actions live **inside one group** (so it reads as a single control rather than a
 * field with buttons floating under it), and a muted strip under it names the
 * session's model and permission mode. Those two are editable here because they are the
 * settings you most want to change right before you say something — and changing them
 * does not restart anything: a live run keeps what it started with, so the choice
 * applies to the next run (`task:setAgentOptions`).
 *
 * All four actions stay visible. Chat is the primary one when there is an agent to talk
 * to; the others are how the same text becomes a note to yourself, the card's headline
 * on the board, or a comment on the ticket — and hiding them in an overflow made a
 * two-click job out of a one-click one.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AgentsRegular, AttachRegular, FlagRegular, SendRegular } from '@fluentui/react-icons';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import { MODELS } from '@tm/shared/model';
import type { Project, Task } from '@tm/shared/model';
import type { JiraUserOption } from '@tm/shared/ipc';
import type { ChatAvailability } from '../taskChat';
import { cardModelFromOption, projectDefaultLabel, PROJECT_DEFAULT } from '../modelChoice';
import { MentionPicker } from './MentionPicker';
import {
  findMentionQuery,
  insertMention,
  reconcileMentions,
  type ComposerValue,
  type MentionQuery,
} from './mentions';

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '4px' },
  /**
   * The composer has no surface of its own — it sits on the pane's bottom band, in the
   * band's colour and without a border or an inset. The placeholder and the action row
   * are the affordance, exactly as in the editor's chat input; the band owns the 12px
   * gutter, so adding one here would double it against the details band at the top.
   */
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: 0,
    backgroundColor: 'transparent',
  },
  /** The textarea carries no border of its own — the box is the border. */
  input: {
    width: '100%',
    '& textarea': {
      backgroundColor: 'transparent',
      border: 'none',
      padding: '2px 4px',
      /**
       * Room for four lines before it starts scrolling, against the two it opened with.
       * What you type here is usually a brief for an agent — a paragraph, not a chat line —
       * and at two rows you were writing into a slot that hid its own first sentence. The
       * ceiling rises with it so the growth still has somewhere to go.
       */
      minHeight: '72px',
      maxHeight: '220px',
    },
    '&::after': { display: 'none' },
    '&::before': { display: 'none' },
  },
  actions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  /** Model / mode / who is running it — muted, under the box, on the band's gutter. */
  footer: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: 0 },
  glyph: { color: tokens.colorBrandForeground1, display: 'flex' },
  muted: { color: tokens.colorNeutralForeground3 },
  /**
   * A ceiling as well as a floor: the model picker's empty choice names what it defers to
   * ("Project default · opus planning · sonnet steps" on a split project), and without one
   * that single option would set the width of the whole footer strip.
   */
  picker: { minWidth: '108px', maxWidth: '220px' },
  blocked: { color: tokens.colorPaletteYellowForeground1 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  chipX: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'inherit',
    padding: '0 0 0 4px',
    fontSize: tokens.fontSizeBase300,
    lineHeight: 1,
  },
});

export interface ComposerProps {
  task: Task;
  /** The agent project this card runs in, when it is delegated. */
  agentProject: Project | null;
  /** What chatting would do right now (or why it cannot). */
  chat: ChatAvailability | null;
  /** "Talking to step 2 of 4" — set when the target is a step of this card. */
  stepCaption: string | null;
  /** Text, the people named in it, and the files to attach. */
  value: ComposerValue;
  onChange: (value: ComposerValue) => void;
  busy: boolean;
  /** True when this card is linked to a ticket, so the third action makes sense. */
  isJira: boolean;
  /** Look people up for the @mention picker (JIRA cards only). */
  onSearchPeople?: (query: string) => Promise<JiraUserOption[]>;
  /** Open the OS file picker; returns the chosen absolute paths. */
  onPickAttachments?: () => Promise<string[]>;
  onSendChat: () => void;
  onAddNote: () => void;
  /** File the text as the card's progress note — the one line the board shows. */
  onPostStatus: () => void;
  onAddJiraComment: () => void;
  /**
   * Persist a model / permission-mode change for the next run. `model: null` is a real
   * choice — "follow the agent project" — not an absence, which is why it is nullable and
   * not merely optional.
   */
  onAgentOptions: (options: { model?: ClaudeModel | null; mode?: PermissionMode }) => void;
}

export function Composer({
  task,
  agentProject,
  chat,
  stepCaption,
  value,
  onChange,
  busy,
  isJira,
  onSearchPeople,
  onPickAttachments,
  onSendChat,
  onAddNote,
  onPostStatus,
  onAddJiraComment,
  onAgentOptions,
}: ComposerProps): JSX.Element {
  const styles = useStyles();
  const canChat = chat?.offered === true && chat.can;
  const empty = !value.text.trim();
  // The card's own model, or `null` while it follows its agent project — which is offered
  // here as a choice of its own rather than resolved away. A project now plans and executes
  // on different models, so showing its execution model as if the card had picked it would
  // make every card that merely inherits look pinned to one half of the split.
  const model = task.agentModel ?? null;
  const projectDefault = projectDefaultLabel(agentProject);
  const mode = task.agentMode ?? agentProject?.defaultPermissionMode ?? 'acceptEdits';
  const live = task.status === 'running' || task.status === 'waiting-input';

  // ---- @mentions -----------------------------------------------------------
  // Only offered on a JIRA card: the other three destinations are plain text, and a
  // picker that inserts a name nothing will resolve is a picker that lies.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [people, setPeople] = useState<JiraUserOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const mentionsOn = isJira && Boolean(onSearchPeople);
  const pickerOpen = mentionsOn && query !== null;

  // Debounced lookup. The generation counter is what keeps a slow response for "al"
  // from landing after a fast one for "alice" and replacing the better list.
  const generation = useRef(0);
  useEffect(() => {
    if (!pickerOpen || !onSearchPeople || !query) {
      setPeople([]);
      setSearching(false);
      return;
    }
    const mine = ++generation.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void onSearchPeople(query.query).then((found) => {
        if (generation.current !== mine) return;
        setPeople(found);
        setActiveIndex(0);
        setSearching(false);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [pickerOpen, query?.query, onSearchPeople]);

  /** Recompute the value and the open query after any edit to the textarea. */
  function editText(next: string, caret: number): void {
    onChange({
      ...value,
      text: next,
      mentions: reconcileMentions(value.mentions, value.text, next),
    });
    setQuery(mentionsOn ? findMentionQuery(next, caret) : null);
  }

  function acceptMention(person: JiraUserOption): void {
    if (!query) return;
    const next = insertMention(value, query, {
      accountId: person.id,
      displayName: person.displayName,
    });
    onChange(next.value);
    setQuery(null);
    // Put the caret back where the user was, after React has written the new value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  }

  async function attach(): Promise<void> {
    if (!onPickAttachments) return;
    const picked = await onPickAttachments();
    if (!picked.length) return;
    // De-duplicated: picking the same file twice would upload it twice.
    const merged = [...new Set([...value.attachments, ...picked])];
    onChange({ ...value, attachments: merged });
  }

  return (
    <div className={styles.root}>
      {stepCaption && <Caption1 className={styles.muted}>{stepCaption}</Caption1>}
      {chat?.offered && !chat.can && <Caption1 className={styles.blocked}>{chat.hint}</Caption1>}

      <div className={styles.box}>
        {pickerOpen && (
          <MentionPicker
            people={people}
            activeIndex={activeIndex}
            loading={searching}
            onPick={acceptMention}
            onHover={setActiveIndex}
          />
        )}
        <Textarea
          className={styles.input}
          appearance="filled-lighter"
          textarea={{ ref: textareaRef }}
          value={value.text}
          onChange={(e, d) => editText(d.value, (e.target as HTMLTextAreaElement).selectionStart)}
          // The caret can move without the text changing (arrows, a click), and that
          // alone opens or closes the picker.
          onSelect={(e) => {
            if (!mentionsOn) return;
            const el = e.target as HTMLTextAreaElement;
            setQuery(findMentionQuery(el.value, el.selectionStart));
          }}
          onBlur={() => setQuery(null)}
          onKeyDown={(e) => {
            // While the picker is open it owns the navigation keys — otherwise Enter
            // would send the half-typed comment instead of accepting the highlighted
            // name, which is the classic way these controls go wrong.
            if (pickerOpen && people.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % people.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + people.length) % people.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                acceptMention(people[activeIndex]);
                return;
              }
            }
            if (pickerOpen && e.key === 'Escape') {
              e.preventDefault();
              setQuery(null);
              return;
            }
            // Enter sends, Shift+Enter is a newline — the CLI's own contract.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && !empty) (canChat ? onSendChat : onAddNote)();
            }
          }}
          placeholder={
            chat?.offered
              ? 'Message the agent…  (Enter sends, Shift+Enter for a new line)'
              : 'Add a progress note…  (context for when you come back)'
          }
          resize="vertical"
        />
        <div className={styles.actions}>
          {chat?.offered && (
            <Button
              size="small"
              appearance={canChat ? 'primary' : 'secondary'}
              icon={<SendRegular />}
              title={chat.hint}
              disabled={busy || empty || !chat.can}
              onClick={onSendChat}
            >
              Chat with agent
            </Button>
          )}
          <Button
            size="small"
            appearance={canChat ? 'secondary' : 'primary'}
            title="Save this text on the card — only you ever read it"
            disabled={busy || empty}
            onClick={onAddNote}
          >
            Add note
          </Button>
          {/* A note you also want to see from the board. Separate from "Add note"
              because only one line can be the card's headline, and replacing it is a
              deliberate act — the ones it replaces stay in this conversation. */}
          <Button
            size="small"
            icon={<FlagRegular />}
            title="Show this on the card as where you are — it replaces the current status line"
            disabled={busy || empty}
            onClick={onPostStatus}
          >
            Post status
          </Button>
          {isJira && (
            <Button
              size="small"
              title="Post this text on the linked JIRA issue"
              disabled={busy || (empty && !value.attachments.length)}
              onClick={onAddJiraComment}
            >
              Add JIRA comment
            </Button>
          )}
          {isJira && onPickAttachments && (
            <Button
              size="small"
              appearance="subtle"
              icon={<AttachRegular />}
              title="Attach files to the JIRA issue and cite them in the comment"
              aria-label="Attach files"
              disabled={busy}
              onClick={() => void attach()}
            />
          )}
          <span className={styles.grow} />
        </div>

        {/* What will be uploaded with the comment. Files go onto the ISSUE and are
            referenced from the comment — a true inline attachment needs a media-services
            token exchange a plain REST client cannot do. */}
        {value.attachments.length > 0 && (
          <div className={styles.chips}>
            {value.attachments.map((path) => (
              <Badge
                key={path}
                appearance="tint"
                color="informative"
                title={path}
                icon={<AttachRegular />}
              >
                {path.split(/[\\/]/).pop()}
                <button
                  type="button"
                  className={styles.chipX}
                  aria-label={`Remove ${path}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      attachments: value.attachments.filter((p) => p !== path),
                    })
                  }
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Who runs this card, and how. Changing either applies to the NEXT run. */}
      <div className={styles.footer}>
        <span className={styles.glyph}>
          <AgentsRegular />
        </span>
        <Caption1 className={styles.muted}>
          {agentProject
            ? `Run by Claude in ${agentProject.name}`
            : 'Not delegated — run by Claude once you assign it'}
        </Caption1>
        <span className={styles.grow} />
        <Dropdown
          className={styles.picker}
          size="small"
          appearance="underline"
          value={model ?? projectDefault}
          selectedOptions={[model ?? PROJECT_DEFAULT]}
          title={
            live
              ? 'Applies to the next run — this one keeps its model'
              : model
                ? 'Model — this card overrides its project'
                : `Model — ${projectDefault}`
          }
          onOptionSelect={(_e, d) => onAgentOptions({ model: cardModelFromOption(d.optionValue) })}
        >
          {/* First, and naming what it defers to: a card that has never been told otherwise
              is already on this option, so it has to say what that costs. */}
          <Option value={PROJECT_DEFAULT} text={projectDefault}>
            {projectDefault}
          </Option>
          {MODELS.map((m) => (
            <Option key={m} value={m}>
              {m}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.picker}
          size="small"
          appearance="underline"
          value={PERMISSION_MODE_LABELS[mode]}
          selectedOptions={[mode]}
          title={live ? 'Applies to the next run — this one keeps its mode' : 'Permission mode'}
          onOptionSelect={(_e, d) =>
            d.optionValue && onAgentOptions({ mode: d.optionValue as PermissionMode })
          }
        >
          {MODES.map((m) => (
            <Option key={m} value={m} text={PERMISSION_MODE_LABELS[m]}>
              {PERMISSION_MODE_LABELS[m]}
            </Option>
          ))}
        </Dropdown>
      </div>
    </div>
  );
}
