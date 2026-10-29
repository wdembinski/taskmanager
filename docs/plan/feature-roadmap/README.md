# Feature roadmap — autonomy, review, authoring

> **Status:** proposed · **Written:** 2026-10-06
> This folder plans the next twelve features of the Task Manager: runs that start while you
> are away, reviewing an agent's work inside the app and from a phone, reusable skills
> and workflows, native sprints to work it all one slice at a time, and one task panel to manage a ticket from any screen. Each one fits our layout — Electron client, `apps/web`, `apps/server`,
> `packages/*` — and our engine (chains, gates, parks, tracker sync).

## How to use these files

Each feature file is written in the plan grammar the app already parses
(`apps/client/src/main/planParser.ts`, described in `docs/03-how-orchestration-works.md`):

- a heading sets the **phase** that labels every task under it;
- only `- [ ]` checkboxes become **cards**; prose, tables, and plain bullets are ignored;
- a trailing `@needs: <full title>` holds a card until that prerequisite is done.

So a file can be imported as a project plan as it stands. To file cards by hand instead,
copy a checkbox line as the card title and the nested bullets under it as the description.

Keep the **blank line** between a checkbox and its description bullets. The parser folds
every indented line that directly follows a checkbox into that card's title
(`planParser.ts`, the continuation rule). Only a blank line stops the fold, so without one
the whole description would become the title, and an `@needs:` clause would swallow it.

Dependencies **between** files (for example, F3 needs F6's diff viewer) are recorded in
each file's header and in the order below, not in `@needs:`, since each file is its own
plan. Start a dependent file only after the file it depends on has shipped.

Every phase ends green: `pnpm typecheck`, `pnpm test`, `pnpm build`.

## The features

| # | Feature | Where | Depends on | File |
|---|---|---|---|---|
| F1 | Automation triggers + calendar: schedule- and tracker-event-started runs | client · server · web | — | [F1](F1-automation-triggers.md) |
| F2 | Activity dashboard: feed, cost and token trends, queue | client · server · web | F1 (soft) | [F2](F2-activity-dashboard.md) |
| F6 | In-app code review: diff viewer, line comments sent back to the agent | client · web | — | [F6](F6-in-app-code-review.md) |
| F3 | Mobile-first review cockpit | web | F6 | [F3](F3-mobile-review-cockpit.md) |
| F7 | Skills library + prompt templates | client · server | — | [F7](F7-skills-and-prompt-templates.md) |
| F8 | Visual workflow builder: skills and gates as one declarative chain | client | F7 | [F8](F8-workflow-builder.md) |
| F9 | Command palette (Ctrl+K) + voice dictation | client · web | — | [F9](F9-command-palette-and-dictation.md) |
| F4 | ~~Linear integration: a fourth tracker~~ — **withdrawn** 2026-10-15, replaced by the built-in tracker (F19–F27) | client · server | — | [F4](F4-linear-integration.md) |
| F5 | Task composer + issue browser with one-click hand-to-agent | client · web | F7 (soft) | [F5](F5-composer-and-hand-to-agent.md) |
| F10 | Variants: run a card N times, compare, keep one | client | F6 | [F10](F10-variants.md) |
| F11 | Sprints: native sprints, sprint planning in the Backlog, "Current sprint" for native tickets, milestone and sprint date ranges with a "Current milestone" view | client · server · web | — | [F11](F11-sprints.md) |
| F12 | One task panel: the board's detail pane gains the ticket fields and links, and opens from the Backlog, Timeline and Graph | client · web | — | [F12](F12-one-task-panel.md) |

"Soft" means the feature works without the other one and gains a piece once it exists.

## Recommended order

```
F1 Triggers ──► F2 Dashboard        (F2 shows what F1 started unattended)
F6 Review   ──► F3 Mobile           (mobile review needs the diff viewer)
            └─► F10 Variants        (comparing variants needs the diff viewer)
F7 Skills   ──► F8 Workflows        (a workflow step can be a skill)
            └─► F5 Composer         (the composer picks a template)
F9, F4      — independent
```

0. **F11** before the rest, if the roadmap is to be worked one sprint at a time: it is what
   lets the board show only the current sprint's cards instead of all of them. It sits outside
   the four milestones because it serves all of them.
0. **F12** alongside F11, and for the same reason: every later feature is worked from the
   board, and F12 is what lets a card's milestone, sprint and links be managed there.
1. **F1** first: it makes the app work while you are away, and reuses the most of what
   exists (tracker polling, the chain engine, the limit and sign-in parks).
2. **F6**: the most visible gap, and self-contained.
3. **F2**: makes F1's unattended work visible.
4. Then F7 → F8, F3, F9, F4, F5, in whatever order the need arises.
5. **F10** last, and only if the need is still there. It is the YAGNI candidate.

## Next: a team tracker, real reviews, autonomous delivery (F13–F27)

> **Status:** proposed · **Written:** 2026-10-15

The second wave grows the app's own tracker into a full team tracker, turns F6 into a
full-screen review workspace that also handles colleagues' PRs/MRs, adds an AI reviewer and
autonomous delivery, and puts the app on Android. The agent engine stays the differentiator:
every tracker feature is designed around cards that agents can run. F11 is superseded by F24
(its date-range work carries over, see F24's mapping table); F9's palette becomes F25's base.

| # | Feature | Where | Depends on | File |
|---|---|---|---|---|
| F13 | Design system and shell: flat content under glass chrome, light + dark tokens, activity bar, milestone tree, gradient status bar | client · web | F12 | [F13](F13-design-system-and-shell.md) |
| F14 | Milestone archiving: hide finished milestones everywhere, restore in one click, optional auto-archive | client · web | — | [F14](F14-milestone-archiving.md) |
| F15 | Review workspace: full-screen reviews of agent cards and of PRs/MRs requested from you | client · web | F6, F13 | [F15](F15-review-workspace.md) |
| F16 | AI reviewer: a read-only headless review that lands as drafts you curate | client | F15 | [F16](F16-ai-reviewer.md) |
| F17 | Autonomous delivery: Manual / Auto-merge / AI review → merge, then the next unblocked card starts | client | F16 | [F17](F17-autonomous-delivery.md) |
| F18 | Review round-trip with GitHub and GitLab: threads in, one review out | client | F15, F16 (soft) | [F18](F18-forge-review-round-trip.md) |
| F19 | Workspaces and sync: local and cloud workspaces, server-owned tickets, offline replica, members and roles | client · server · web | cloud resumed | [F19](F19-workspaces-and-sync.md) |
| F20 | Agents in a team workspace: agent assignees, run leases, team-visible runs | client · server · web | F19 | [F20](F20-agents-in-a-team-workspace.md) |
| F21 | Issue model and workflow: teams, custom states, sub-issues, relations, templates, recurring tickets | client · server · web | F19 | [F21](F21-issue-model-and-workflow.md) |
| F22 | Collaboration: assignees, mentions, threaded comments, history, notifications inbox, team docs | client · server · web | F19, F21 | [F22](F22-collaboration.md) |
| F23 | Android app: a Capacitor shell around the compact web app, with push | web · server · CI | F3, F22 | [F23](F23-android-app.md) |
| F24 | Planning: cycles (replacing F11), projects, initiatives, status updates, roadmap | client · server · web | F19, F21 | [F24](F24-planning.md) |
| F25 | Speed and views: keyboard everywhere, palette, saved views, bulk edit, search, insights | client · web | F9, F21 | [F25](F25-speed-and-views.md) |
| F26 | Triage and git automation: triage inbox, AI triage, ticket-key branches, PR-driven moves, imports | client · server | F20, F21, F22 | [F26](F26-triage-and-git-automation.md) |
| F27 | Enterprise: SSO and SCIM via the IAM, audit log, guests and permissions, workspace export | server · web | F19, F22 | [F27](F27-enterprise.md) |

Mockups are in [`mockups/`](mockups/), all in the approved look. The `v9-*` set covers the
issues list, issue detail, review workspace, board (sidebar folded) and mobile, light and dark.
The `v10-*` set covers every other tab: milestones, timeline, cycles, projects and initiatives,
inbox, agents, automations, insights, triage, settings, the command palette, the archive, and
the board's chain links in all three modes (All, Focus, Off).

### Two tracks

```
Track 1 — no cloud needed
F12 ──► F13 Shell ──► F14 Archiving
              └─────► F15 Review ──► F16 AI reviewer ──► F17 Autonomous delivery
                             └─────► F18 Round-trip with GitHub / GitLab

Track 2 — cloud (resume the paused cloud first; F19 Phase 0)
F19 Workspaces ──► F20 Agents in a team
               ──► F21 Issue model ──► F22 Collaboration ──► F23 Android
                                  ├──► F24 Planning
                                  ├──► F25 Speed and views
                                  └──► F26 Triage and git automation (also F20, F22)
               ──► F27 Enterprise (after F22)
```

### Decisions taken with the user

- **Two kinds of workspace.** A *local* workspace is today's model: desktop-owned, no cloud, no
  account, and it must keep working exactly as it does now. A *cloud* workspace is the team
  model: the server owns tickets, every desktop keeps a full replica with an offline outbox,
  the server allocates keys (offline tickets show `TM-?` until synced), and the last write to a
  field wins. Agent runs always stay on the desktop that runs them.
- **Out of scope for good:** a public tracker API or MCP server, Slack/Teams integrations,
  customer intake (asks, helpdesk integrations, SLAs).
- **Archiving hides, it does not freeze.** Archived milestones, epics, cycles and projects
  disappear from the tree, board, Gantt, pickers and palette; direct links work, archived
  tickets stay editable, and restoring is one click. It ships early, on today's local tracker.
- **Reviews.** The diff comes from a local clone when the repo is a project in the app,
  otherwise from the forge API. AI findings are always drafts the human curates; nothing
  reaches GitHub/GitLab without the human.
- **AI approval.** The verdict is recorded in the app and as a PR comment; an optional
  reviewer bot token casts a real forge approval (GitHub forbids approving your own PR);
  without one the app merges when branch protection allows, and otherwise parks with the
  reason. Merge policy per project and card: Manual, Auto-merge (no AI), AI review → merge.
- **Look.** Minimal, Scandinavian, Fluent 2: v3's calm with a hint of glass (near-opaque panes), one brand blue,
  colour only for things that move, a blue-to-indigo gradient status bar that turns orange on
  attention, a foldable sidebar with a milestone › epic › ticket tree, and board chain links
  routed through the column gutters (never across a card) with an Off / Focus / All toggle.
- **Android** is a Capacitor shell around the existing compact web app, not a rewrite.

### Recommended order

1. **F12**, then **F13**: every later screen is built inside the new shell.
2. **F14**: small, and it immediately un-clutters today's board.
3. **F15 → F16 → F17**: the biggest daily win, with no cloud cost. F17 also fixes the engine
   gap where a plan never advances on its own (a `@needs` is satisfied only by `done`, which
   the engine never sets).
4. **F18** when reviewing colleagues' PRs from the app becomes the daily path.
5. **Track 2** once the cloud is resumed: F19 first (its Phase 0 fixes a mirror cursor bug that
   already affects the web board), then F20 and F21, then the rest by need.
