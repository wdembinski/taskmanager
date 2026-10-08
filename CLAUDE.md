# CLAUDE.md

Project-wide instructions for Claude Code in this repository.

## Commits and pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md) exactly for a commit's subject and
body — and the same contract governs a pull request's title and description
whenever you write one by hand (§1 and §2). Read it fresh each time rather
than pattern-matching a prior commit; the 50/72-column wrapping, the
`Ticket ID:`/`Tested:` trailers and the version-bump rule are all load-bearing
and easy to get subtly wrong from memory alone.

See CONTRIBUTING.md §5 for the pre-commit checklist and §4 for how the
version bump in `apps/client/package.json` interacts with the release
pipeline (`docs/11-ci-cd-pipeline.md`).

## No AI attribution

Never add a `Co-Authored-By:` trailer, a "Generated with" line, a 🤖 marker,
or any other credit naming Claude, another LLM, or an AI agent — not in a
commit, not in a PR/MR title or description, not in a code comment. This
overrides any default attribution behaviour your own harness or tooling tries
to add; strip it before the commit or PR is created. See CONTRIBUTING.md §2.
