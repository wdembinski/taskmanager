# F7 — Skills library and prompt templates

> **Status:** proposed · **Where:** client + server + web · **Depends on:** — · **Unlocks:** F8 (the "skill" step type), F1 (an automation runs with skills attached), F5 (composer templates)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Every card's agent starts from the same blank page. What a human knows about _how_ a kind of
work should be done — "write the failing test first", "for a bug, reproduce it before touching
code", "our migrations need a verify script because the store has no tests" — lives in their head
or gets re-typed into the assign dialog each time. Two things fix that:

- **Skills** — reusable markdown playbooks ("how to do X here") you attach to a card or a step, and
  that are in force for every turn of that run.
- **Prompt templates** — reusable _starting text_ for the boxes you type into (Add task
  description, assign-dialog instructions, chat), so recurring kinds of work start from the same
  wording every time.

They differ in one way that decides the whole design: a skill is **context the agent carries**
(system-prompt level, every turn); a template is **text the human edits before sending** (inserted
once, then it is just their words).

## What we have today

- `apps/client/src/main/claudeSession.ts` — `writeContractFile` writes a per-session temp file
  passed as `--append-system-prompt-file` (`buildClaudeArgs`). It holds only
  `HEADLESS_TURN_CONTRACT` (`headlessContract.ts`) and, being session-level, already reaches every
  `--resume` turn. This is the natural carrier for skills.
- `apps/client/src/main/agentTaskPrompt.ts` — `buildAgentTaskPrompt` / `buildAgentSubtaskPrompt`
  already take the project's standing `instructions` (`Project.instructions` in
  `packages/shared/src/model.ts`) and a bounded `notes` history (`promptHistory.ts` budgets).
- `packages/shared/src/agent.ts` + `apps/server/src/agents/` + `apps/client/src/main/agentProfilesApi.ts`
  — agent profiles: server-only rows, no desktop copy. Shows the "server-authoritative" option and
  why it does not fit here (runs happen on the desktop and must work with the cloud down).
- `packages/shared/src/settings.ts` — `GLOBAL_SETTINGS_KEYS` / `pickGlobalSettings`, the settings
  mirror (`settings_mirrors`, `GET/PUT /v1/settings`); a guard test forces every new key to be
  classified global or local.
- `packages/ui/src/AddTaskDialog.tsx`, `AssignAgentDialog.tsx`, `TaskAgentPanel.tsx`,
  `TaskSteps.tsx`, `chat/`, `drafts.ts` — the three composers and the step list skills attach to.
- `apps/web/src/settings/settingsSections.ts` — the web settings registry.
- The `claude` CLI natively discovers `<cwd>/.claude/skills/*/SKILL.md` and offers them to the model,
  which _decides_ whether to invoke one. A repo that commits `.claude/skills/` therefore already has
  them in every worktree — but nothing guarantees one is used.

## Design

### Data model & contracts

New pure module `packages/shared/src/skills.ts`:

```ts
interface Skill {
  // a library skill — owned by this app
  id: string; // uuid
  name: string; // slug: [a-z0-9-]{1,64}
  description: string; // one line, shown in pickers
  body: string; // markdown, ≤ SKILL_BODY_MAX (64 KiB)
  createdAt: number;
  updatedAt: number;
}
interface RepoSkillSummary {
  projectId: string;
  name: string;
  description: string;
  path: string;
}
type SkillRef = { kind: 'library'; id: string } | { kind: 'repo'; name: string };
```

- `SkillRef` serialises as `lib:<id>` / `repo:<name>` (`formatSkillRef` / `parseSkillRef`), so a
  library skill and a repo skill with the same name can never collide.
- `parseSkillMarkdown(text)` / `serializeSkillMarkdown(skill)` speak the CLI's own `SKILL.md` format
  (frontmatter `name`, `description`, then body) — hand-written, no YAML dependency (the repo has
  none), CRLF-safe, tolerant of a missing frontmatter (name from file/folder).
- `Task.skillRefs?: string[]` — refs attached to a card **or** a step. A step runs with
  _card refs ∪ its own refs_, de-duplicated, card first.
- `PromptTemplate { id; name; body; surfaces: ('add-task'|'assign'|'chat')[] }` in
  `packages/shared/src/promptTemplates.ts`, stored as a **global** `AppSettings.promptTemplates`
  (rides the existing settings mirror). `renderTemplate(body, vars)` replaces `{{title}}`, `{{key}}`,
  `{{project}}`; unknown placeholders stay verbatim. `insertTemplate(text, caret, rendered)` is the
  pure caret-aware insert. Three defaults ship ("Bug: reproduce first", "Test-first feature",
  "Review only — change nothing").

### Engine

- **Delivery — inject, don't rely on discovery.** At every spawn (start _and_ resume) the scheduler
  resolves the run's refs → bodies and `writeContractFile` appends a "Skills in force for this run"
  section after the headless contract, with a closing line that skills never override the
  orchestrator rules above them. Reasons: the system prompt reaches every turn including chat
  resumes; an attached skill must be _in force_, not offered; and per the token audit prompt text is
  second-order (cache reads are 96% of spend) — a session avoided is what saves money, so a few KB of
  playbook is cheap.
- **Repo skills are injected with their path.** The body is read from the _worktree's_ copy
  (`<worktree>/.claude/skills/<name>/SKILL.md`, so a skill changed on the branch is the one used) and
  the section names that directory so `references/` resolve. Nothing is materialised for them — they
  are already on disk.
- **Library skills are single-file in v1** (no `references/`), so nothing is written into the
  worktree and nothing can be committed by accident.
- Bounded by `SKILLS_CHAR_BUDGET` (≈24 KiB total, `promptHistory.ts` style omission line naming
  what was dropped).
- On start, one timeline note: "Skills in force: a, b" (or "Skill X no longer exists — this run
  started without it"). Detaching takes effect on the next spawn; the note says so.
- Repo discovery goes through the project's `ExecHost` (`apps/client/src/main/exec/`), so a WSL
  project reads Linux paths correctly.

### Server & sync

- Desktop SQLite is the source of truth (runs execute there, cloud is optional).
- Library skills are mirrored through a **dedicated, per-skill endpoint** (`PUT/DELETE /v1/skills/:id`,
  `GET /v1/skills`), pushed only when changed — **not** inside `SyncRequest`, because an uncapped
  sync payload already wedged the mirror once (`one-answer-wedges-the-mirror`). Server caps the body
  at `SKILL_BODY_MAX` and answers 413 with a sentence the desktop shows.
- Repo skill _summaries_ (name, description, path — never bodies) ride the project mirror so the web
  can offer them in a picker.
- Templates need nothing new: `promptTemplates` is a global settings key.
- Web writes (create/edit/delete a skill, attach refs to a card) go through relay commands to the
  desktop, as every other web mutation does; reads are the direct tier.

### UI — desktop

- **Settings → Skills**: list (library + each project's repo skills, source badge, monochrome),
  editor (name, description, markdown body with preview), **Import** (a `.md` / `SKILL.md` file, a
  folder of them, or pasted text), **Export** (writes `SKILL.md` into a chosen folder — commit it and
  it becomes a repo skill), **Copy to library** on a repo skill, Delete.
- **Settings → Prompt templates**: list, edit, reorder, reset to defaults; explicit Save.
- **Skill picker** (multi-select popover with filter) in `AssignAgentDialog`, `TaskAgentPanel`, and on
  each step row in `TaskSteps`. Attached skills show as a "Skills · a · b" line in the agent panel.
- **Templates menu** button beside the Add-task description, the assign-dialog instructions and the
  chat composer; filtered to that surface.
- State lives in pure modules (`skillsEditorState.ts`, `skillPicker.ts`) tested like
  `packages/ui/src/taskTimeline.ts` — there is no DOM harness.

### UI — web

The same `@tm/ui` components (the web mirrors the desktop): Skills and Prompt templates sections in
`settingsSections.ts`, the picker and templates menu wherever the web already shows those dialogs.
Repo skills are read-only on the web. Import/Export are desktop-only (they touch the file system).

### Failure modes & edge cases

- **Dangling ref** (skill deleted, repo skill absent on this branch) → dropped from the run, named on
  the timeline; the run still starts.
- **Over budget** → later skills truncated with an omission line naming them; never silently.
- **A skill that contradicts the orchestrator** ("merge when done", "comment on the JIRA ticket") →
  section ordering + the closing line; the agent prompt's existing "do not write to the tracker" and
  "merging is the tool's" rules stay authoritative.
- **Malformed `SKILL.md` on import** → imported with a warning, name from the file/folder.
- **Name clash on import** → refused with the existing skill named; offer "replace" explicitly.
- **WSL project** → paths via `ExecHost.toNative`/`toApp`; the contract file already crosses.
- **413 from the server** → skill stays local, Settings shows "too large to sync (N KiB > 64 KiB)".
- **Two desktops** → last-write-wins on the mirror; a skill created on desktop A is not replayed to
  desktop B in v1 (same known gap as settings).

## Out of scope (v1)

- A team/community skills repository (git clone + refresh) and auto-updates.
- Directory library skills with `references/` (and therefore any materialisation into worktrees).
- Project-wide default skills (project `instructions` already covers "every run here").
- Import from a URL.
- Versioning/history of skill edits.

## Open questions

- **Should `~/.claude/skills` (user-global CLI skills) be listed too?** Default: no — the CLI already
  offers them natively; listing them adds a third source for little gain.
- **Should a skill be attachable to a whole project?** Default: no, use project instructions.
- **Do skills replay to other desktops?** Default: not in v1; revisit with settings convergence.
- **Should templates support more placeholders (branch, URL)?** Default: only `{{title}}`, `{{key}}`,
  `{{project}}`; add on demand.

## F7.5 — decisions taken (step 1 of 3)

Three build steps are approved for F7.5. Step 1 is not code — it is the decisions step 2's
`listRepoSkills`/`readRepoSkill` build on, settled here so a headless session does not
re-derive them with no one to ask.

### The folder name is the skill's name

A `repo:<name>` ref (`parseSkillRef`, `skills.ts:98-112`) and F7.6's
`<worktree>/.claude/skills/<name>/SKILL.md` lookup both address the folder, not whatever a
`SKILL.md`'s frontmatter happens to say. So the folder decides `RepoSkillSummary.name`, and a
frontmatter `name` that disagrees is silently ignored rather than surfaced as a warning —
there is no "import" step here to attach a warning to, and a name mismatch between two
sources describing the same skill is not a fault worth reporting on every listing.

Mechanically: `readRepoSkill` calls `parseSkillMarkdown(text, folderName)` — the folder name
as the **fallback** — and then overwrites `result.name = folderName` unconditionally
afterwards, rather than relying on the fallback ever being reached. `parseSkillMarkdown`
only falls back to its `fallbackName` argument when frontmatter is missing or its own `name`
is invalid (`skills.ts:215-225`); a well-formed `SKILL.md` with a *different* valid name would
otherwise win, which would let two folders disagree with their own directory listing.

### A folder name that fails `isValidSkillName` is skipped

No `repo:<name>` ref could ever address such a folder, so listing it would offer something
nothing could later resolve back to. `readRepoSkill` validates the folder name with
`isValidSkillName` (`skills.ts:73-75`) before doing anything else and returns `null` if it
fails; `listRepoSkills` drops those entries rather than including them with a broken ref.

This same check is what keeps path traversal out: `SKILL_NAME_RE` (`skills.ts:69`,
`[a-z0-9-]{1,64}`) cannot match a name containing `..` or `/`, so a folder entry from
`readdir` can never be joined into a path that escapes `.claude/skills/`. No separate
traversal check is needed because the slug regex already excludes every character that
traversal depends on.

### Path traversal stays inside the skills folder, structurally

`listRepoSkills` reads `.claude/skills/` with `readdir(dir, { withFileTypes: true })` (the
same call `listClaudeSessions` already uses, `claudeSessions.ts:213`), keeps only entries
where `entry.isDirectory()`, and for each one requires `<dir>/<entry.name>/SKILL.md` to
`stat` as a regular file before reading it. That means:

- a loose file directly under `.claude/skills/` (not a directory) is ignored — `isDirectory()`
  excludes it before a name or a `SKILL.md` is even considered.
- any other file inside a skill's own folder (`references/`, `notes.md`, …) is ignored — only
  `SKILL.md` itself is ever opened.
- a folder with no `SKILL.md` is ignored — the `stat`-as-regular-file check fails and that
  folder contributes nothing, the same "one bad entry must not lose the others" shape
  `listClaudeSessions` uses for an unreadable transcript (`claudeSessions.ts:239-241`).

### `path` is relative to the project root, always `/`-separated

`RepoSkillSummary.path` (`skills.ts:44-46`) is documented as "where it lives on disk, relative
to the project root, for display and for the prompt section to name" — it is always
`.claude/skills/<name>/SKILL.md`, built with a literal `/` join rather than `node:path.join`,
because a WSL project's folder is also named with `/` and the value is display text (the
picker, the "Skills in force" section), never a path handed to `fs` or `ExecHost`. The actual
on-disk read goes through `host.toApp(hostJoin(projectRoot, '.claude', 'skills', name,
'SKILL.md'))` (the `appProjectFile`/`listClaudeSessions` pattern), which is a different,
host-native string that is never exposed on the summary.

### Results are sorted by name

`listRepoSkills` returns its summaries sorted by `name` (`localeCompare`) before returning,
not in `readdir`'s own order (which is filesystem-dependent and not guaranteed alphabetical
even on one platform). The picker and the "Skills in force" prompt section both read this
list directly, so an unsorted result would make both non-deterministic between runs for no
reason — `readdir`'s order was never a meaningful signal to preserve.

### The module is read-only

`repoSkills.ts` never writes, creates or deletes anything — every project's `.claude/skills/`
is the human's or the repo's, not this app's. `readRepoSkill`/`listRepoSkills` only ever
`readdir`/`stat`/read a file; there is no companion "write a repo skill" function in this
module (library skills already cover the editable case — `Skill` in `skills.ts:23-36` — and
F7's "Export" writes a `SKILL.md` through a separate, explicit action, not through this
discovery path).

## Tasks

### F7 · Phase 1 — Skill and template model

- [ ] F7.1 Define the Skill types, SkillRef format and SKILL.md parser in shared

  - New `packages/shared/src/skills.ts`: `Skill`, `RepoSkillSummary`, `SkillRef`, `formatSkillRef`, `parseSkillRef`, `isValidSkillName`, `parseSkillMarkdown`, `serializeSkillMarkdown`, `SKILL_BODY_MAX`.
  - Acceptance: `skills.test.ts` covers round-trip, CRLF, missing/malformed frontmatter, invalid names, ref parse of unknown prefixes (rejected); `pnpm typecheck` and `pnpm test` green.

- [ ] F7.2 Build the skills-in-force system prompt section with a size budget @needs: F7.1 Define the Skill types, SkillRef format and SKILL.md parser in shared

  - Pure `buildSkillsSection(resolved, budget)` in `apps/client/src/main/skillsPrompt.ts`: ordering, repo-skill path line, omission line, the "never overrides the rules above" closing line.
  - Acceptance: `skillsPrompt.test.ts` covers empty (returns nothing), one, many, over-budget truncation naming dropped skills.

- [ ] F7.3 Add prompt templates as a global setting with pure render and insert

  - `AppSettings.promptTemplates` + three defaults in `packages/shared/src/settings.ts`, listed in `GLOBAL_SETTINGS_KEYS`; `packages/shared/src/promptTemplates.ts` with `renderTemplate`, `insertTemplate`, `templatesFor(surface)`.
  - Acceptance: `promptTemplates.test.ts` (placeholders, unknown left verbatim, caret at start/middle/end, selection replaced); the existing settings classification guard passes.

### F7 · Phase 2 — Desktop storage and delivery

- [ ] F7.4 Add the skills table and task skill refs to the desktop store @needs: F7.1 Define the Skill types, SkillRef format and SKILL.md parser in shared

  - `apps/client/src/main/store.ts`: `CREATE TABLE skills`, `ALTER TABLE tasks ADD COLUMN skill_refs`, CRUD + `setTaskSkillRefs`.
  - Acceptance: `scripts/verify-skills-migration.mjs` (the store has no tests — use the drop-column + `ELECTRON_RUN_AS_NODE` recipe from `verify-resume-migration.mjs`) proves a fresh DB and an upgraded one both work; it fails when the ALTER is removed.

- [ ] F7.5 Discover repo skills in a project's .claude/skills through the exec host @needs: F7.1 Define the Skill types, SkillRef format and SKILL.md parser in shared

  - `apps/client/src/main/repoSkills.ts`: list `*/SKILL.md` under a directory and read one, via `ExecHost`, read-only.
  - Acceptance: `repoSkills.test.ts` against a temp directory in `os.tmpdir()` (never inside the repo): finds skills, ignores non-skill files, missing directory = empty list.

- [ ] F7.6 Resolve a run's skills and append them to the session system prompt file @needs: F7.2 Build the skills-in-force system prompt section with a size budget, F7.4 Add the skills table and task skill refs to the desktop store, F7.5 Discover repo skills in a project's .claude/skills through the exec host

  - Pure `resolveRunSkills(card, step, lookups)` (card ∪ step, dedupe, dangling reported); `writeContractFile` takes the extra section; scheduler writes the "Skills in force" / dangling timeline note at every spawn including resume.
  - Acceptance: unit tests for the resolver; `claudeSession.test.ts` asserts the contract file contains the section; a headless run with a stub `claude` on PATH shows the file content on start and on a chat resume.

- [ ] F7.7 Expose skills, repo skills and task skill refs over IPC with relay coverage @needs: F7.4 Add the skills table and task skill refs to the desktop store, F7.5 Discover repo skills in a project's .claude/skills through the exec host

  - Channels in `packages/shared/src/ipc.ts` + handlers in `apps/client/src/main/ipc.ts`: list/get/save/delete/import/export, `task:setSkillRefs`; register in the relay.
  - Acceptance: `test/ipc-relay-coverage.test.ts` passes with the new channels classified; handler unit tests for name-clash refusal and import of a malformed file.

### F7 · Phase 3 — Desktop UI

- [ ] F7.8 Add the Skills settings section with editor, import and export @needs: F7.7 Expose skills, repo skills and task skill refs over IPC with relay coverage

  - `packages/ui` Skills section + pure `skillsEditorState.ts` (dirty tracking, validation, clash handling); wire into desktop `Settings.tsx`.
  - Acceptance: state-machine tests (edit/save/discard/clash/replace); `pnpm build` green; source badges are monochrome (board colour budget).

- [ ] F7.9 Add a skill picker to the assign dialog, agent panel and step rows @needs: F7.7 Expose skills, repo skills and task skill refs over IPC with relay coverage

  - Shared `SkillPicker` + pure `skillPicker.ts` (filter, selection, card-vs-step inheritance display); "Skills · a · b" line in `TaskAgentPanel`.
  - Acceptance: picker state tests including an inherited card skill shown as non-removable on a step.

- [ ] F7.10 Add the Prompt templates settings section and the insert-template menu @needs: F7.3 Add prompt templates as a global setting with pure render and insert

  - Settings section (edit, reorder, reset, explicit Save) and a `TemplateMenu` in `AddTaskDialog`, `AssignAgentDialog` and the chat composer, filtered by surface.
  - Acceptance: tests for the section's pure state; inserting at the caret preserves the user's existing text (covered by `insertTemplate` tests plus a view-model test per surface).

### F7 · Phase 4 — Cloud and web

- [ ] F7.11 Mirror library skills to the cloud through a dedicated bounded endpoint @needs: F7.4 Add the skills table and task skill refs to the desktop store

  - Server: `skillMirror.entity.ts`, migration, controller `GET /v1/skills`, `PUT/DELETE /v1/skills/:id` with the 64 KiB cap; desktop pusher (changed-only, 413 surfaced); repo skill summaries on the project mirror.
  - Acceptance: controller tests (auth, cap → 413, tombstone on delete); pusher test proves an unchanged skill is not re-sent; `nest build` actually emits (see `noemit-makes-build-a-noop`).

- [ ] F7.12 Show and attach skills and templates in the web client @needs: F7.11 Mirror library skills to the cloud through a dedicated bounded endpoint, F7.8 Add the Skills settings section with editor, import and export, F7.9 Add a skill picker to the assign dialog, agent panel and step rows, F7.10 Add the Prompt templates settings section and the insert-template menu

  - `apps/web`: settings sections, direct-tier reads, relay writes, picker and templates menu in the web dialogs; Import/Export hidden.
  - Acceptance: `settingsSections.test.ts` and `test/shell-parity.test.ts` pass; a relayed attach lands on the desktop's card (transport test).

- [ ] F7.13 Document skills and prompt templates for users @needs: F7.12 Show and attach skills and templates in the web client

  - `docs/03-how-orchestration-works.md` (what "in force" means, card vs step), `docs/05-glossary.md` (skill, repo skill, template).
  - Acceptance: docs reviewed against the shipped behaviour; formatter clean.
