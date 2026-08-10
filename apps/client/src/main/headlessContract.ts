/**
 * What every orchestrated run is told about the shape of its own session.
 *
 * The bug this exists for: a card ran 50 tool calls, spent $1.70, ended its turn with
 * "I'll continue once those return" — and produced nothing. It had launched three
 * subagents in the BACKGROUND and stopped to wait for a notification that headless mode
 * never delivers. The CLI reported `stopReason: end_turn`, `terminalReason: completed`,
 * `success: true`, so the orchestrator filed it as a success and told the human the work
 * had finished on its branch.
 *
 * `run_in_background` defaults to **true**, which is what makes this the DEFAULT path
 * rather than an unlucky one. The same model, on the same orchestrator, delegating with
 * `run_in_background: false`, got its answers mid-turn and went on to produce a plan — so
 * the fix is to say which of the two applies here, not to ban delegation.
 *
 * Why this is a system prompt and not a line in `agentTaskPrompt.ts`: it is a property of
 * the SESSION, not of any one task, and it has to reach the one path that has no prompt
 * builder at all — a chat resume, whose prompt is the human's raw words (see
 * `Scheduler.launch`, `prompt = run.chatPrompt ?? …`). Appending it there would also put
 * these words in the human's mouth.
 *
 * Delivered via `--append-system-prompt-file` rather than `--append-system-prompt`,
 * because the CLI is spawned with `shell: true` (so Windows can resolve `claude.cmd` from
 * PATH) and a multi-line argument containing quotes and ampersands would be mangled by
 * `cmd.exe`. Only a path crosses the shell.
 */
export const HEADLESS_TURN_CONTRACT = [
  'You are running headless, driven by an orchestrator, in a SINGLE automated turn.',
  'Nobody is watching this turn as it happens.',
  '',
  'The rule that follows from that, and the one thing you must not get wrong:',
  '**ending your turn ends the session.** There is no next turn. Nothing that is still in',
  'flight when you stop will ever finish, no notification will arrive to wake you up, and',
  'anything you were waiting for is discarded along with the process.',
  '',
  'So:',
  '',
  '- If you delegate to subagents, you MUST pass `run_in_background: false` on every one of',
  '  them, so their results come back inside this turn. A background subagent is killed',
  '  when your turn ends and its work is lost — silently, because you will already have',
  '  reported that you are waiting for it.',
  '- Never end a turn waiting on anything: not a subagent, not a background command, not a',
  '  build. Wait for it here, or do the work yourself.',
  '- Finish the task, or state plainly what blocked you. "I will continue once X returns"',
  '  is never a valid way to end — there is no later in which to continue.',
  '- If you are in plan mode, the plan only reaches the human when you call `ExitPlanMode`.',
  '  A plan written out as prose in your reply is discarded with the session.',
].join('\n');
