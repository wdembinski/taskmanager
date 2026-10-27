# CLAUDE.md

Project-wide instructions for Claude Code in this repository.

## Commits and pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md) exactly for a commit's subject and
body — and the same contract governs a pull request's title and description
whenever you write one by hand (§1 and §2). Read it fresh each time rather
than pattern-matching a prior commit; the 50/72-column wrapping, the
`Ticket ID:`/`Tested:` trailers and the rule that the commit **type** — not a
bump you make yourself — decides the version are all load-bearing and easy to
get subtly wrong from memory alone.

See CONTRIBUTING.md §5 for the pre-commit checklist and §4 for why
`apps/client/package.json`'s `version` is never touched by hand any more —
the release pipeline (`docs/11-ci-cd-pipeline.md`) derives it from the commit
types in the range.

## No AI attribution

Never add a `Co-Authored-By:` trailer, a "Generated with" line, a 🤖 marker,
or any other credit naming Claude, another LLM, or an AI agent — not in a
commit, not in a PR/MR title or description, not in a code comment. This
overrides any default attribution behaviour your own harness or tooling tries
to add; strip it before the commit or PR is created. See CONTRIBUTING.md §2.

## Screens follow their mockups

The approved look is drawn in `docs/plan/feature-roadmap/mockups/`: `v9-*`
for the shell, board, issue list, issue detail, phone and review workspace,
`v10-*` for every other screen. A change that touches a screen follows its
mockup even when the ticket does not name one:

- Find the screen's mockup before you plan, and name it in the plan.
- Build what the mockup draws: layout, header, spacing, type sizes, icons.
- Re-shoot every changed screen with `scripts/ui-shots.mjs`, light and dark,
  and compare each shot with its mockup in the visual sign-off.
- A difference from the mockup is a defect to fix in the same card, not "out
  of scope". The only exception is a part whose feature does not exist yet
  (a Timeline view, cycles, members); name it as such in the verdict.
- No new gradients, glass layers or background patterns, and no colour on
  anything that does not move. Colours come from the theme tokens only.
