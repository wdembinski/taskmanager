/**
 * Skills settings section (F7.8) — list, edit, import and export the library of reusable
 * `SKILL.md` playbooks, plus a read-only view of every connected project's own repo skills
 * (`.claude/skills`), backed by `skillsEditorState.ts`'s pure saved/draft pair so nothing
 * reaches `skill:save`/`skill:import`/etc until the human actually asks for it.
 *
 * Owns its own load (`skill:list` + `project:list` + one `skill:listRepo` per project) rather
 * than taking props the way `PromptTemplatesSection` does — the library here is a PICKER with
 * its own selection, not a flat list edited in place, so there is no single "draft" a host
 * screen could usefully hold on its behalf.
 *
 * `canUseFileSystem` gates the whole Import menu and Export: `skill:import` and `skill:export`
 * are both host-only channels, so a transport without them (apps/web) passes `false` and this
 * hides every entry point to them — including **Paste text…**, which does not touch the file
 * system itself but lands on the same host-only `skill:import` channel as the rest of the menu
 * — rather than offering a button that can never answer.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArrowExportRegular,
  ArrowImportRegular,
  BookRegular,
  DocumentArrowUpRegular,
  FolderRegular,
} from '@fluentui/react-icons';
import type { RepoSkillDetail, RepoSkillSummary } from '@tm/shared/skills';
import {
  applyDelete,
  applyImportResults,
  applySaveResult,
  cancelPendingSelection,
  canSave,
  confirmPendingSelection,
  copyRepoToLibrary,
  discardDraft,
  dismissClash,
  editDraft,
  isDirty,
  nextImportReplace,
  openSkillsEditor,
  reloadLibrary,
  replaceDraft,
  selectLibrary,
  selectRepo,
  skipImportClash,
  startNew,
  validateDraft,
  type SkillsEditorState,
} from './skillsEditorState';
import { Markdown } from './chat/MarkdownView';
import { PaneLoading } from './PaneLoading';
import { useInitialLoad } from './useInitialLoad';
import { useTransport } from './transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  hint: { color: tokens.colorNeutralForeground3 },
  layout: { display: 'flex', gap: '16px', minHeight: 0 },
  left: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '280px',
    flexShrink: 0,
    overflowY: 'auto',
  },
  groupLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    marginTop: '8px',
  },
  row: { padding: '4px', cursor: 'pointer' },
  rowSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  rowHeader: { display: 'flex', flexDirection: 'column', gap: '2px' },
  rowTop: { display: 'flex', alignItems: 'center', gap: '6px' },
  right: { display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  grid: { display: 'flex', flexDirection: 'column', gap: '12px' },
  bodyHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  body: { fontFamily: 'ui-monospace, Consolas, monospace' },
  preview: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px',
    minHeight: '200px',
  },
  actions: { display: 'flex', alignItems: 'center', gap: '12px' },
  error: { color: tokens.colorPaletteRedForeground1 },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  notices: { display: 'flex', flexDirection: 'column', gap: '2px' },
});

export interface SkillsSectionProps {
  /** Whether the host can open native file/folder dialogs — `false` hides the whole Import
   *  menu (Files…, Folder… and Paste text…, which all land on the same host-only
   *  `skill:import` channel) and both Export buttons, since `skill:import`/`skill:export` are
   *  host-only channels a browser transport cannot answer. Defaults to `true` (desktop). */
  canUseFileSystem?: boolean;
  /** The host's own project list, by id/name — when given, `load()` uses it directly instead
   *  of the relayed `project:list`, so a host that already holds the list (apps/web, off its
   *  board mirror) does not need a live desktop Client just to show this picker. Desktop
   *  leaves this unset and loads its own. */
  projects?: Array<{ id: string; name: string }>;
}

export function SkillsSection({
  canUseFileSystem = true,
  projects: projectsProp,
}: SkillsSectionProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  const [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<SkillsEditorState>(() => openSkillsEditor([]));
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(projectsProp ?? []);
  const [repoSkills, setRepoSkills] = useState<Record<string, RepoSkillSummary[]>>({});

  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewBody, setPreviewBody] = useState(false);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);

  const [repoDetail, setRepoDetail] = useState<RepoSkillDetail | null>(null);
  const [repoDetailLoading, setRepoDetailLoading] = useState(false);
  const [repoDetailError, setRepoDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [skills, projectList] = await Promise.all([
      transport.invoke('skill:list'),
      projectsProp
        ? Promise.resolve(projectsProp)
        : transport
            .invoke('project:list')
            .then((list) => list.map((p) => ({ id: p.project.id, name: p.project.name }))),
    ]);
    const repoLists = await Promise.all(
      projectList.map((p) => transport.invoke('skill:listRepo', p.id)),
    );
    const repoMap: Record<string, RepoSkillSummary[]> = {};
    projectList.forEach((p, i) => {
      repoMap[p.id] = repoLists[i];
    });
    setProjects(projectList);
    setRepoSkills(repoMap);
    setEditor((prev) => reloadLibrary(prev, skills));
    setLoaded(true);
  }, [transport, projectsProp]);

  const initial = useInitialLoad(load);

  // Any edit, selection switch or discard invalidates the "Saved." confirmation — only a
  // successful `skill:save` sets it back to true.
  function apply(updater: (state: SkillsEditorState) => SkillsEditorState): void {
    setEditor(updater);
    setSaved(false);
  }

  const selection = editor.selection;
  const selRepoProjectId = selection?.kind === 'repo' ? selection.projectId : null;
  const selRepoName = selection?.kind === 'repo' ? selection.name : null;

  useEffect(() => {
    if (!selRepoProjectId || !selRepoName) {
      setRepoDetail(null);
      setRepoDetailError(null);
      return;
    }
    let live = true;
    setRepoDetail(null);
    setRepoDetailError(null);
    setRepoDetailLoading(true);
    transport
      .invoke('skill:getRepo', selRepoProjectId, selRepoName)
      .then((detail) => {
        if (live) setRepoDetail(detail);
      })
      .catch((e: unknown) => {
        if (live) setRepoDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setRepoDetailLoading(false);
      });
    return () => {
      live = false;
    };
  }, [transport, selRepoProjectId, selRepoName]);

  async function save(): Promise<void> {
    if (!editor.draft) return;
    setSaving(true);
    try {
      const result = await transport.invoke('skill:save', editor.draft);
      setEditor((prev) => applySaveResult(prev, result));
      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function replaceExisting(): Promise<void> {
    const draft = replaceDraft(editor);
    if (!draft) return;
    setSaving(true);
    try {
      const result = await transport.invoke('skill:save', draft);
      setEditor((prev) => applySaveResult(prev, result));
      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSkill(): Promise<void> {
    const id = editor.draft?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const ok = await transport.invoke('skill:delete', id);
      if (ok) apply((prev) => applyDelete(prev, id));
    } finally {
      setDeleting(false);
    }
  }

  async function exportIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const result = await transport.invoke('skill:export', ids);
      if (result) {
        const message =
          result.written.length === 1
            ? `Exported "${result.written[0]}" to ${result.dir}.`
            : `Exported ${result.written.length} skills to ${result.dir}.`;
        setEditor((prev) => ({ ...prev, notices: [...prev.notices, message] }));
      }
    } finally {
      setExporting(false);
    }
  }

  async function importFrom(source: 'files' | 'folder'): Promise<void> {
    setImporting(true);
    try {
      const results = await transport.invoke('skill:import', { source });
      if (results) apply((prev) => applyImportResults(prev, results));
    } finally {
      setImporting(false);
    }
  }

  async function importPastedText(): Promise<void> {
    if (!pasteText.trim()) return;
    setPasteBusy(true);
    try {
      const results = await transport.invoke('skill:import', { source: 'text', text: pasteText });
      if (results) apply((prev) => applyImportResults(prev, results));
      setPasteOpen(false);
      setPasteText('');
    } finally {
      setPasteBusy(false);
    }
  }

  if (!loaded) {
    return (
      <PaneLoading
        label="Loading skills…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const draft = editor.draft;
  const errors: Partial<Record<'name' | 'body', string>> = draft
    ? validateDraft(draft, editor.library)
    : {};
  const repoGroups = projects
    .map((p) => ({ project: p, skills: repoSkills[p.id] ?? [] }))
    .filter((g) => g.skills.length > 0);
  const headClashEntry = editor.importQueue[0];
  const headClash = headClashEntry?.status === 'clash' ? headClashEntry : undefined;

  return (
    <div className={styles.root}>
      <Body1 className={styles.hint}>
        Reusable playbooks a card or step carries into every turn of a run. A library skill is yours
        end to end and syncs to the cloud; a repo skill already lives under a project’s own{' '}
        <code>.claude/skills</code> and is read-only here — bring one into the library with{' '}
        <strong>Copy to library</strong> to edit it.
      </Body1>

      <div className={styles.toolbar}>
        <Button icon={<AddRegular />} onClick={() => apply((p) => startNew(p))}>
          New skill
        </Button>
        {canUseFileSystem && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button icon={<ArrowImportRegular />} disabled={importing}>
                Import
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={<DocumentArrowUpRegular />}
                  onClick={() => void importFrom('files')}
                >
                  Files…
                </MenuItem>
                <MenuItem icon={<FolderRegular />} onClick={() => void importFrom('folder')}>
                  Folder…
                </MenuItem>
                <MenuItem onClick={() => setPasteOpen(true)}>Paste text…</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
        {canUseFileSystem && (
          <Button
            icon={<ArrowExportRegular />}
            disabled={exporting || editor.library.length === 0}
            onClick={() => void exportIds(editor.library.map((s) => s.id))}
          >
            Export all
          </Button>
        )}
      </div>

      {headClash && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {headClash.message}
            {editor.importQueue.length > 1
              ? ` (${editor.importQueue.length} imports waiting on a decision.)`
              : ''}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              size="small"
              appearance="primary"
              onClick={() => apply((p) => nextImportReplace(p))}
            >
              Replace existing
            </Button>
            <Button
              size="small"
              appearance="secondary"
              onClick={() => apply((p) => skipImportClash(p))}
            >
              Skip
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {editor.notices.length > 0 && (
        <div className={styles.notices}>
          {editor.notices.map((notice, i) => (
            <Caption1 key={i} className={styles.hint}>
              {notice}
            </Caption1>
          ))}
          <div>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => apply((p) => ({ ...p, notices: [] }))}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className={styles.layout}>
        <div className={styles.left}>
          <Caption1 className={styles.groupLabel}>Library</Caption1>
          {editor.library.length === 0 && (
            <Caption1 className={styles.hint}>No library skills yet.</Caption1>
          )}
          {editor.library.map((skill) => (
            <SkillRow
              key={skill.id}
              name={skill.name}
              description={skill.description}
              kind="library"
              selected={selection?.kind === 'library' && selection.id === skill.id}
              onClick={() => apply((p) => selectLibrary(p, skill.id))}
            />
          ))}

          {repoGroups.map((group) => (
            <div key={group.project.id}>
              <Caption1 className={styles.groupLabel}>Repo · {group.project.name}</Caption1>
              {group.skills.map((skill) => (
                <SkillRow
                  key={skill.name}
                  name={skill.name}
                  description={skill.description}
                  kind="repo"
                  selected={
                    selection?.kind === 'repo' &&
                    selection.projectId === group.project.id &&
                    selection.name === skill.name
                  }
                  onClick={() => apply((p) => selectRepo(p, group.project.id, skill.name))}
                />
              ))}
            </div>
          ))}
        </div>

        <div className={styles.right}>
          {!selection && (
            <Body1 className={styles.hint}>Select a skill on the left, or start a new one.</Body1>
          )}

          {selection?.kind === 'repo' && (
            <div className={styles.grid}>
              <Subtitle2>{selection.name}</Subtitle2>
              {repoDetailLoading && <Spinner size="tiny" label="Loading…" />}
              {repoDetailError && (
                <MessageBar intent="error">
                  <MessageBarBody>{repoDetailError}</MessageBarBody>
                </MessageBar>
              )}
              {repoDetail && (
                <>
                  <Caption1 className={styles.hint}>{repoDetail.path}</Caption1>
                  {repoDetail.description && <Body1>{repoDetail.description}</Body1>}
                  {repoDetail.warnings.map((w, i) => (
                    <Caption1 key={i} className={styles.hint}>
                      {w}
                    </Caption1>
                  ))}
                  <div className={styles.preview}>
                    <Markdown source={repoDetail.body} />
                  </div>
                  <div className={styles.actions}>
                    <Button
                      appearance="primary"
                      onClick={() => apply((p) => copyRepoToLibrary(p, repoDetail))}
                    >
                      Copy to library
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {draft && (selection?.kind === 'library' || selection?.kind === 'new') && (
            <div className={styles.grid}>
              <Field
                label="Name"
                hint="Lower-case letters, numbers and hyphens, 1 to 64 characters."
                validationState={errors.name ? 'error' : 'none'}
                validationMessage={errors.name}
              >
                <Input
                  value={draft.name}
                  placeholder="my-skill-name"
                  onChange={(_e, d) => apply((p) => editDraft(p, { name: d.value }))}
                />
              </Field>

              <Field label="Description" hint="One line, shown next to the name in pickers.">
                <Input
                  value={draft.description}
                  placeholder="What this skill is for"
                  onChange={(_e, d) => apply((p) => editDraft(p, { description: d.value }))}
                />
              </Field>

              <div>
                <div className={styles.bodyHead}>
                  <Text weight="semibold">Body</Text>
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => setPreviewBody((v) => !v)}
                  >
                    {previewBody ? 'Edit' : 'Preview'}
                  </Button>
                </div>
                {previewBody ? (
                  <div className={styles.preview}>
                    <Markdown source={draft.body} />
                  </div>
                ) : (
                  <Textarea
                    className={styles.body}
                    value={draft.body}
                    resize="vertical"
                    textarea={{ rows: 16 }}
                    placeholder="Markdown body…"
                    onChange={(_e, d) => apply((p) => editDraft(p, { body: d.value }))}
                  />
                )}
                {errors.body && <Caption1 className={styles.error}>{errors.body}</Caption1>}
              </div>

              {editor.clash && (
                <MessageBar intent="warning">
                  <MessageBarBody>{editor.clash.message}</MessageBarBody>
                  <MessageBarActions>
                    <Button
                      size="small"
                      appearance="primary"
                      onClick={() => void replaceExisting()}
                    >
                      Replace existing
                    </Button>
                    <Button
                      size="small"
                      appearance="secondary"
                      onClick={() => apply((p) => dismissClash(p))}
                    >
                      Cancel
                    </Button>
                  </MessageBarActions>
                </MessageBar>
              )}

              <div className={styles.actions}>
                <Button
                  appearance="primary"
                  disabled={!canSave(editor) || saving}
                  onClick={() => void save()}
                >
                  Save
                </Button>
                <Button
                  appearance="secondary"
                  disabled={!isDirty(editor)}
                  onClick={() => apply((p) => discardDraft(p))}
                >
                  Discard
                </Button>
                <Button
                  appearance="secondary"
                  disabled={!draft.id || deleting}
                  onClick={() => void deleteSkill()}
                >
                  Delete
                </Button>
                {canUseFileSystem && (
                  <Button
                    appearance="secondary"
                    disabled={!draft.id || exporting}
                    onClick={() => void exportIds(draft.id ? [draft.id] : [])}
                  >
                    Export
                  </Button>
                )}
                {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
              </div>
            </div>
          )}
        </div>
      </div>

      {editor.pendingSelection && (
        <Dialog open onOpenChange={(_e, d) => !d.open && apply((p) => cancelPendingSelection(p))}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogContent>
                <Body1>
                  This skill has unsaved changes. Switching to another one will discard them.
                </Body1>
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  onClick={() => apply((p) => cancelPendingSelection(p))}
                >
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => apply((p) => confirmPendingSelection(p))}
                >
                  Discard changes
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}

      {pasteOpen && (
        <Dialog open onOpenChange={(_e, d) => !d.open && !pasteBusy && setPasteOpen(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Paste a SKILL.md</DialogTitle>
              <DialogContent>
                <Textarea
                  className={styles.body}
                  value={pasteText}
                  resize="vertical"
                  textarea={{ rows: 16 }}
                  placeholder={
                    '---\nname: my-skill\ndescription: What this skill is for\n---\n\nBody…'
                  }
                  onChange={(_e, d) => setPasteText(d.value)}
                />
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  disabled={pasteBusy}
                  onClick={() => setPasteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  disabled={pasteBusy || !pasteText.trim()}
                  onClick={() => void importPastedText()}
                >
                  Import
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}

interface SkillRowProps {
  name: string;
  description: string;
  kind: 'library' | 'repo';
  selected: boolean;
  onClick: () => void;
}

/** One row in the left-column picker — a monochrome `Library`/`Repo` badge beside the name,
 *  never coloured: the badge names a static fact about the row, not something that moved. */
function SkillRow({ name, description, kind, selected, onClick }: SkillRowProps): JSX.Element {
  const styles = useStyles();
  return (
    <Card
      className={selected ? `${styles.row} ${styles.rowSelected}` : styles.row}
      onClick={onClick}
      selected={selected}
    >
      <CardHeader
        header={
          <div className={styles.rowHeader}>
            <div className={styles.rowTop}>
              <Text weight="semibold">{name}</Text>
              <Badge
                appearance="tint"
                color="informative"
                icon={kind === 'library' ? <BookRegular /> : <FolderRegular />}
              >
                {kind === 'library' ? 'Library' : 'Repo'}
              </Badge>
            </div>
            {description && <Caption1 className={styles.hint}>{description}</Caption1>}
          </div>
        }
      />
    </Card>
  );
}
