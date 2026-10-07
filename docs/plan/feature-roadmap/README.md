# Feature roadmap — autonomy, review, authoring

> **Status:** proposed · **Written:** 2026-10-06
> This folder plans the next eleven features of the Task Manager: runs that start while you
> are away, reviewing an agent's work inside the app and from a phone, reusable skills
> and workflows, and native sprints to work it all one slice at a time. Each one fits our layout — Electron client, `apps/web`, `apps/server`,
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
| F4 | Linear integration: a fourth tracker | client · server | — | [F4](F4-linear-integration.md) |
| F5 | Task composer + issue browser with one-click hand-to-agent | client · web | F7 (soft) | [F5](F5-composer-and-hand-to-agent.md) |
| F10 | Variants: run a card N times, compare, keep one | client | F6 | [F10](F10-variants.md) |
| F11 | Sprints: native sprints, sprint planning in the Backlog, "Current sprint" for native tickets, milestone and sprint date ranges with a "Current milestone" view | client · server · web | — | [F11](F11-sprints.md) |

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
1. **F1** first: it makes the app work while you are away, and reuses the most of what
   exists (tracker polling, the chain engine, the limit and sign-in parks).
2. **F6**: the most visible gap, and self-contained.
3. **F2**: makes F1's unattended work visible.
4. Then F7 → F8, F3, F9, F4, F5, in whatever order the need arises.
5. **F10** last, and only if the need is still there. It is the YAGNI candidate.

Multi-user features for the cloud dashboard (teams, roles, custom fields) belong to a
separate, later roadmap and are not part of this folder.
