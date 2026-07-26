/**
 * The card's composer — one box, three destinations, and a footer that says who is
 * about to run and how.
 *
 * Shaped after the Claude Code chat input the user asked for: the text area and its
 * actions live **inside one bordered surface** (so it reads as a single control rather
 * than a field with buttons floating under it), and a muted strip under it names the
 * session's model and permission mode. Those two are editable here because they are the
 * settings you most want to change right before you say something — and changing them
 * does not restart anything: a live run keeps what it started with, so the choice
 * applies to the next run (`task:setAgentOptions`).
 *
 * All three actions stay visible. Chat is the primary one when there is an agent to talk
 * to; the other two are how the same text becomes a note to yourself or a comment on the
 * ticket, and hiding them in an overflow made a two-click job out of a one-click one.
 */
import {
  Button,
  Caption1,
  Dropdown,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AgentsRegular, SendRegular } from '@fluentui/react-icons';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { Project, Task } from '@shared/model';
import type { ChatAvailability } from '../taskChat';

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '4px' },
  /**
   * The composer sits ON the pane, in the pane's own colour and without a border — the
   * placeholder and the action row are the affordance, exactly as in the editor's chat
   * input. It is still one group: the textarea and its buttons share this box's padding.
   */
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'transparent',
  },
  /** The textarea carries no border of its own — the box is the border. */
  input: {
    width: '100%',
    '& textarea': {
      backgroundColor: 'transparent',
      border: 'none',
      padding: '2px 4px',
      maxHeight: '160px',
    },
    '&::after': { display: 'none' },
    '&::before': { display: 'none' },
  },
  actions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  /** Model / mode / who is running it — muted, under the box. */
  footer: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '0 4px' },
  glyph: { color: tokens.colorBrandForeground1, display: 'flex' },
  muted: { color: tokens.colorNeutralForeground3 },
  picker: { minWidth: '108px' },
  blocked: { color: tokens.colorPaletteYellowForeground1 },
});

export interface ComposerProps {
  task: Task;
  /** The agent project this card runs in, when it is delegated. */
  agentProject: Project | null;
  /** What chatting would do right now (or why it cannot). */
  chat: ChatAvailability | null;
  /** "Talking to step 2 of 4" — set when the target is a step of this card. */
  stepCaption: string | null;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  /** True when this card is linked to a ticket, so the third action makes sense. */
  isJira: boolean;
  onSendChat: () => void;
  onAddNote: () => void;
  onAddJiraComment: () => void;
  /** Persist a model / permission-mode change for the next run. */
  onAgentOptions: (options: { model?: ClaudeModel; mode?: PermissionMode }) => void;
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
  onSendChat,
  onAddNote,
  onAddJiraComment,
  onAgentOptions,
}: ComposerProps): JSX.Element {
  const styles = useStyles();
  const canChat = chat?.offered === true && chat.can;
  const empty = !value.trim();
  // The effective settings: this card's override, else the agent project's default.
  const model = task.agentModel ?? agentProject?.defaultModel ?? 'sonnet';
  const mode = task.agentMode ?? agentProject?.defaultPermissionMode ?? 'acceptEdits';
  const live = task.status === 'running' || task.status === 'waiting-input';

  return (
    <div className={styles.root}>
      {stepCaption && <Caption1 className={styles.muted}>{stepCaption}</Caption1>}
      {chat?.offered && !chat.can && <Caption1 className={styles.blocked}>{chat.hint}</Caption1>}

      <div className={styles.box}>
        <Textarea
          className={styles.input}
          appearance="filled-lighter"
          value={value}
          onChange={(_e, d) => onChange(d.value)}
          onKeyDown={(e) => {
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
          {isJira && (
            <Button
              size="small"
              title="Post this text on the linked JIRA issue"
              disabled={busy || empty}
              onClick={onAddJiraComment}
            >
              Add JIRA comment
            </Button>
          )}
          <span className={styles.grow} />
        </div>
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
          value={model}
          selectedOptions={[model]}
          title={live ? 'Applies to the next run — this one keeps its model' : 'Model'}
          onOptionSelect={(_e, d) =>
            d.optionValue && onAgentOptions({ model: d.optionValue as ClaudeModel })
          }
        >
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
