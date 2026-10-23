# 13. The UI verification contract

A card that changes the UI is not Done when its tests are green. A human (or the project's
AI reviewer) has to look at screenshots of the real UI next to the mockup and sign off.
The app does not know how to take those screenshots for your repo, and does not try to.
It only knows **where to pick them up**. This page is the contract between the two: the
one setting that tells the planner which command takes the shots, and the folder that
command fills.

This repo's own command is `node scripts/ui-shots.mjs --attach`
([`CONTRIBUTING.md` §6](../CONTRIBUTING.md#6-ui-changes)). Any other repo can implement the
same contract with its own tooling.

---

## The setting

**Projects → Edit → UI verification command.** It is a free-text command, run from the
root of a card's worktree, for example `node scripts/ui-shots.mjs --attach` or
`pnpm exec playwright test ui-shots`. It is stored per project as `Project.uiVerifyCommand`,
trimmed on save. Empty means the project has none. Existing projects start empty: nothing
is guessed or detected for you.

**The app never runs it.** The command is only quoted into the prompts an agent gets:

- **A plan.** When the field is set, the planner is told that any step changing the UI
  must run that command in its Verification. A build or a test run proves the code runs,
  not that it looks right. When the field is empty, the planner is told the project has no
  headless screenshot command. A plan with UI work must then first propose a step that
  adds one, writing the files below, before it may claim the UI verified. Its Facts
  section has to say the command is missing.
- **The AI reviewer's fix step.** When the reviewer asks for changes, the fix step it adds
  to the card says to re-take the shots with the same command. When the field is empty,
  it says "the project's screenshot command".

Whatever runs the command is the agent, inside its own worktree, as part of its step.

---

## The outbox

The command's only job, as far as the app is concerned, is to leave files in one folder:

```text
<worktree>/.vipper/attach/
  NAME.png            the real screenshot of one screen
  NAME-mockup.png     that screen's mockup, at the same size (optional)
  verdicts.txt        one line per screen, written by the agent after it looks
```

- **A screen is `NAME.png`.** Its mockup is `NAME-mockup.png`, with the same `NAME`. A
  screen with no mockup just has no `-mockup.png`. Pick stable names such as
  `board-light` or `project-form-dark`. The name is how a re-run finds the previous shot.
- **Anything else in the folder is attached too.** This repo's script also drops
  `NAME.html` (the two images side by side), `index.html` (a contact sheet) and
  `shots.json`. The card panel's **Visual sign-off** section links `NAME.html` and
  `index.html` when they are there. None of them is required.
- **`verdicts.txt` is read, not attached.** It becomes a comment on the card. It has one
  line per screen:

  ```text
  <screen>: <verdict> — <note>
  ```

  `<screen>` is the `NAME` of a `NAME.png`. **Only `ok` counts as a match.** Any other
  verdict word is read as a mismatch, and the rest of the line becomes its note, so a
  human looks at it. That includes the `close`, `partly` and `far` the plan prompt asks
  for, and `mismatch` itself. Blank lines, and lines with no `:`, are skipped. If there is
  no `verdicts.txt`, the comment says the shots were attached but a human still has to
  look.

### What the app does with it

1. **After the run settles successfully**, and only then, the app reads the folder. A
   failed or stopped run leaves it alone.
2. Every file but `verdicts.txt` is attached to the **owner card**. For a plan step, that
   is the card the step belongs to, not the step. The shots are about the card's UI, and
   the card is where a human looks for them.
3. **A re-run replaces same-named files.** Before it attaches, the app removes the
   owner's existing attachments that share a name with an incoming file or a screen
   named in `verdicts.txt`. A retried step shows the latest `board-light.png`, not
   `board-light-2.png`.
4. **Files are removed from the outbox once they are attached.** A file that failed to
   attach (too big, for example) stays where it is, and the failure goes to the log.
5. `verdicts.txt` is turned into the sign-off comment, then removed.

The ingest is `ingestAttachOutbox` in
[`apps/client/src/main/attachOutbox.ts`](../apps/client/src/main/attachOutbox.ts). The
verdict format is `parseVisualVerdicts` in
[`packages/shared/src/visualSignOff.ts`](../packages/shared/src/visualSignOff.ts).

---

## Rules for the command

- **Headless only. Never launch the user's app.** The person running the board is often
  using the same app on the same machine, and a second copy can close theirs. Render the
  UI in a headless browser against a fixture or a built bundle, never through `pnpm dev`
  or an installed binary.
- **Exit non-zero, and refuse to attach, when a shot was not really taken.** A click that
  missed, a selector that never matched, or two screens with the same pixels all mean the
  screenshot is not the screen it claims to be. Handing that to a human as "the real UI"
  is worse than handing them nothing. Write nothing into `.vipper/attach/`, print what
  went wrong, and exit with a non-zero code. The plan prompt tells the agent to fix the
  click or selector it names and re-run, not to ignore the refusal.
- **Replace the folder, don't add to it.** Clear `.vipper/attach/` before writing, so a
  screen dropped from this run does not linger from the last one.
- **Do not write `verdicts.txt` from the command.** The verdict is the agent's own
  judgement, written after it opens each pair. The command takes the pictures.
- **Keep `.vipper/` out of git.** Add it to the repo's `.gitignore`.

---

## The reference implementation

[`scripts/ui-shots.mjs`](../scripts/ui-shots.mjs) in this repo does all of the above:

- It renders each screen from `scripts/shots/screens/` in headless Chrome, against a
  seeded fixture, and rasterizes its mockup at the same size.
- It writes everything to `.vipper/shots/` first, then checks the run. A setup step that
  threw, an `expect` selector that missed, or two shots with the same hash is a problem.
- With `--attach`, it copies the run into `.vipper/attach/` only if there were no
  problems. Otherwise it prints them, attaches nothing, and exits 1.

How to add a screen to it is in [`CONTRIBUTING.md` §6](../CONTRIBUTING.md#6-ui-changes).

## A sketch for another repo

Another repo does not need any of that machinery. A Playwright script is enough. This
one assumes the app can be served as a static build, and that mockups are PNGs kept in
the repo:

```js
// scripts/ui-verify.mjs — run as: node scripts/ui-verify.mjs
import { chromium } from 'playwright';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = join(process.cwd(), '.vipper', 'attach');
const BASE = process.env.UI_VERIFY_URL ?? 'http://localhost:4173';

// One entry per screen: a stable name, a URL, a selector proving the page got there,
// and the mockup to lay beside it (or null).
const SCREENS = [
  {
    name: 'orders-light',
    path: '/orders',
    expect: '[data-orders-table]',
    mockup: 'design/orders.png',
  },
  { name: 'order-detail-light', path: '/orders/1', expect: '[data-order-detail]', mockup: null },
];

rmSync(OUT, { recursive: true, force: true });
const staging = join(process.cwd(), '.vipper', 'shots');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const browser = await chromium.launch(); // headless by default
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
const hashes = new Map();

for (const screen of SCREENS) {
  try {
    await page.goto(BASE + screen.path);
    await page.waitForSelector(screen.expect, { timeout: 10_000 });
    const file = join(staging, `${screen.name}.png`);
    await page.screenshot({ path: file });
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (hashes.has(hash)) problems.push(`${screen.name} is identical to ${hashes.get(hash)}`);
    hashes.set(hash, screen.name);
    if (screen.mockup && existsSync(screen.mockup)) {
      copyFileSync(screen.mockup, join(staging, `${screen.name}-mockup.png`));
    }
  } catch (e) {
    problems.push(`${screen.name}: ${e.message}`);
  }
}
await browser.close();

if (problems.length > 0) {
  console.error(`${problems.length} problem(s), refusing to attach:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
cpSync(staging, OUT, { recursive: true });
console.log(`attached: ${OUT}`);
```

Then set that project's **UI verification command** to `node scripts/ui-verify.mjs` (with
whatever starts the static server first, if the script does not). The agent runs it,
opens each `NAME.png` / `NAME-mockup.png` pair, writes `.vipper/attach/verdicts.txt`, and
the app does the rest once the step settles.
