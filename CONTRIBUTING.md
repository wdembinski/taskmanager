# Contributing

**Audience: anyone committing to this repository — a human, or an agent running
unattended.** This file is the contract for two things a commit must get right:
**how its message is written**, and **which version it ships**.

The wider "how do I make a change" material — recipes, where code lives, the
security boundary — lives in [`docs/04-contributing-guide.md`](docs/04-contributing-guide.md).
The release procedure lives in [`RELEASE.md`](RELEASE.md), and the pipeline that
now performs it in [`docs/11-ci-cd-pipeline.md`](docs/11-ci-cd-pipeline.md). This
file sits between them: it governs the commit itself.

---

## The short version

Every commit that ships work:

1. Has a **Conventional Commits** subject, 50 characters or fewer.
2. Has a **plain-text body** wrapped at 72 characters, ending in a `Ticket ID:`
   (when there is one) and a `Tested:` line.
3. **Bumps `version` in `apps/client/package.json`**, in that same commit —
   when you know what the change is worth.

The tag used to be step 4. It is not yours any more: pushing to `development`
runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which tags,
packages and publishes. Bump if you can — the pipeline honours the version it
finds — and if you don't, it patch-bumps for you. Either way the release happens.
See §4.

---

## 1. The subject line

```text
<type>(<scope>): <summary>
```

- **50 characters maximum, for the whole line** — `type`, parentheses, scope,
  colon and summary all counted. This is tighter than it sounds; it is a real
  constraint on the summary, not a suggestion.
- Lower case, no trailing full stop.
- Imperative mood: _"add the merge switch"_, not _"added"_ or _"adds"_.
- The **scope** is optional but preferred. Use the area of the app the change
  lives in — `board`, `merge`, `jira`, `limit`, `release`, `ipc`, `db`. One word.

### Types

| Type       | Use it for                                     | Version bump |
| ---------- | ---------------------------------------------- | ------------ |
| `feat`     | New behaviour a user could notice              | MINOR        |
| `fix`      | A bug corrected                                | PATCH        |
| `refactor` | Code reshaped, behaviour identical             | PATCH        |
| `test`     | Tests added or changed, nothing else           | PATCH        |
| `docs`     | Documentation only                             | PATCH        |
| `chore`    | Build, tooling, dependencies, release plumbing | PATCH        |
| `perf`     | Faster or lighter, behaviour identical         | PATCH        |

A **breaking change** adds `!` after the scope — `feat(ipc)!: drop the v1 channel` —
and explains the break in the body. See §4 for what it does to the version while
we are pre-1.0.

---

## 2. The body

The full shape of a commit message:

```text
<subject, max 50 chars>

<description, each line max 72 chars>

Ticket ID: <ticket id, omit this line entirely if there is none>
Tested: <how the change was actually tested>
```

Rules, all of them load-bearing:

- **Blank line after the subject.** Without it, git treats the whole thing as one
  subject and every log view is unreadable.
- **Wrap the description at 72 characters.** Hard wrap it yourself; git does not
  wrap for you, and terminals do not either.
- **No Markdown.** No `#`, no `**bold**`, no backticks-as-formatting, no
  `[links](…)`. A commit message is read in a terminal, where those are noise. A
  bare path or symbol name written plainly is fine and preferred.
- **Bullets use `-` and nothing else.** No `*`, no `•`, no `+`, no `1.`.
- **Continuation lines align under the first line's text.** In a bullet that is
  two spaces in; under `Tested:` it is eight. This is what keeps the block
  readable at 72 columns, and it is also what lets git parse `Tested:` as a
  trailer rather than as loose prose.
- **Blank line before the trailer block.** `Ticket ID:` and `Tested:` are
  trailers; git only recognises them as such if they sit in the final paragraph.

### Trailers

- **`Ticket ID:`** — the identifier of the ticket this commit closes or advances.
  If there is no ticket, **leave the line out**. Do not write `Ticket ID: none`.
- **`Tested:`** — how you actually convinced yourself the change works. Name the
  commands you ran and what you clicked. "Tested: yes" is not an answer; neither
  is a description of testing you did not do. If a change genuinely could not be
  tested (a docs edit, say), say that in one clause and say why.
- **`Co-Authored-By:`** — goes last, in the same trailer block, when you paired
  with an agent.

---

## 3. Worked examples

A feature, with a ticket:

```text
feat(merge): put the auto-merge switch on cards

Three switches, in the three places the question actually gets
asked: Settings, each project's dialog, and the card's Details
Panel on the board.

Setting a switch to what it was already inheriting stores null
rather than the same value again, which is how a level goes back
to following the one above it.

Ticket ID: TM-412
Tested: pnpm typecheck, pnpm test (168 green), then pnpm dev and
        toggled the switch at all three levels, confirming the
        card falls back to the project when set to inherit.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

A fix, no ticket, with a list in the description:

```text
fix(limit): resume a card's steps when the limit resets

The gate remembered the card but not the chain it was driving, so
a plan stopped mid-way stayed stopped after the reset. Parking the
whole chain in the gate fixes three symptoms at once:

- a paused step never restarted
- the board showed "waiting" forever
- the next card in the queue was never reached, because the
  runner still counted the parked one as busy

Tested: pnpm test, plus a seeded chain driven through a forced
        limit and a manual reset via apps/client/scripts/unblock-limit.cjs.
```

### What a bad message looks like

```text
fix: fixed the bug where the merge switch on the card didn't work properly
* it now works
* also updated docs
Tested: yes
```

Four faults: the subject is 74 characters and in the past tense; there is no
blank line after it; the bullets use `*`; and `Tested:` says nothing a reviewer
could check.

---

## 4. Versioning

The version lives in one place — `version` in `apps/client/package.json` — and
**it is the release**. Nothing else names the version; the installer, the update
feed and the tag all derive from it. The root `package.json` is the workspace
manifest and stays at `0.0.0`; it is never bumped.

### The rule

**A commit that changes the product bumps the version, and the bump rides inside
that same commit.** Not a follow-up commit, not a batch at release time. The
commit that introduces the change and the commit that names its version are one
commit, so `git log` can never show you a change without telling you which
version it landed in.

That is still how it should read. What has changed is the consequence of
forgetting. The bump is no longer the last thing standing between a merge and a
release: **the pipeline reads the version, and supplies one if the range has
none.** `scripts/next-version.mjs` takes a manifest version newer than every
existing tag as the answer, and otherwise patch-bumps the highest **released**
version and commits that as `chore(release): vX.Y.Z`. So:

- **You bumped.** The pipeline uses your number exactly, including a MINOR bump
  it would never have chosen for itself. This is why bumping still matters —
  only you know a `feat` when you write one.
- **You didn't.** The release is a PATCH and nothing is lost. It used to be a
  release that silently never happened, which is why this section once said a
  commit that leaves the version alone "is not finished".

The one thing that is still yours alone is choosing MINOR. A feature that ships
as a patch is a wrong version number, not a missing release, and no script can
tell the difference after the fact.

### Choosing the bump

We are pre-1.0 (`0.x`), where the usual semver contract shifts down one place:

- **MINOR** (`0.53.0` → `0.54.0`) — a `feat`, or any breaking change. While the
  major is `0`, a break bumps MINOR; it does not bump MAJOR.
- **PATCH** (`0.53.0` → `0.53.1`) — everything else: `fix`, `refactor`, `test`,
  `docs`, `chore`, `perf`.
- **MAJOR** — reserved for `1.0.0`, which is a decision, not a consequence.
  Do not bump it on your own; ask.

If one commit contains both a `feat` and a `fix`, the highest bump wins. If you
are splitting work across several commits, each one bumps — that is the point.

### Tagging

**Do not tag.** The pipeline does, as `github-actions[bot]`, on the merge commit —
and a tag pushed from a laptop for a version the pipeline is about to compute is
a collision nobody enjoys resolving. Tag by hand only when you are releasing by
hand, which means Actions is unavailable and you are following
[`RELEASE.md`](RELEASE.md) §3 deliberately.

The shape of a tag is unchanged, and the pipeline obeys all of it:

```bash
git tag -a v0.53.1 -m "v0.53.1 - <one line saying what changed>"
```

- Annotated (`-a`), never lightweight. Lightweight tags carry no author, no date
  and no message, and `git describe` treats them differently.
- The name is the version with a leading `v` — `v0.53.1`, matching `0.53.1` in
  `package.json` exactly.
- Push with `git push --follow-tags`, so the tag and the commit travel together.
  A tag pushed without its commit points at nothing anybody else can see.
- **Never move or re-point a tag that has been pushed.** If a tagged version is
  wrong, bump again and tag the correction. This one outlives the pipeline: it is
  why `next-version.mjs` only ever proposes a version newer than every tag it can
  see, rather than trusting the manifest.

### How this meets the release procedure

Your commit's job is now the **version**, and only the version.
[`.github/workflows/release.yml`](.github/workflows/release.yml) does the rest on
every push to `development`, following [`RELEASE.md`](RELEASE.md) section by
section — see [`docs/11-ci-cd-pipeline.md`](docs/11-ci-cd-pipeline.md). A bump that
rides inside the work commit is honoured as the release's version; a range with no
bump gets the lone `chore(release): vX.Y.Z` commit RELEASE.md §2 always allowed,
except that the pipeline writes it rather than a person.

RELEASE.md is still the procedure of record. It is what you follow when the
pipeline cannot run, and it is the specification the pipeline is checked against.

---

## 5. Before you commit

```bash
pnpm format
pnpm typecheck
pnpm test
```

All three green, and — for anything with a visible effect — `pnpm dev` opened and
the change seen working. Then:

- [ ] Subject is Conventional Commits, 50 characters or fewer, imperative.
- [ ] Blank line after the subject; body wrapped at 72; plain text; `-` bullets;
      continuations aligned.
- [ ] `Ticket ID:` present if a ticket exists, omitted if not.
- [ ] `Tested:` says what you actually ran.
- [ ] `apps/client/package.json` `version` bumped in this commit — and bumped
      MINOR if this is a `feat` or a break, which is the one call the pipeline
      cannot make for you.
- [ ] No tag. The pipeline cuts it when this lands on `development` (§4).
