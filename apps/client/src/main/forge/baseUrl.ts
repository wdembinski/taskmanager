/**
 * The URL of a forge instance, as the human configured it — and the one guard in front of
 * every client built against one.
 *
 * It exists because a blank setting is not a blank *failure*. Both clients paste the setting
 * straight in front of their API path, so an empty one produces `/api/v4/projects/…` — a
 * relative URL — and `fetch` answers `TypeError: Invalid URL`. That is thrown from inside the
 * push-and-open path, whose whole contract is that every refusal names its own wall, and it
 * names nothing: not the forge, not the setting, not the screen it is on.
 *
 * `ipc.ts`'s `buildGitHubClient` / `buildGitLabClient` have always refused for this, in these
 * words. This is that refusal, lifted out so the third caller — `createPr.ts`, which builds
 * its clients from a token it was handed rather than from the store — asks the same question
 * and gets the same sentence, instead of carrying a second copy that could drift from it.
 */
import type { ForgeProvider } from '@shared/mergeRequest';
import type { AppSettings } from '@shared/settings';

/**
 * What each forge's URL setting is CALLED on the Settings screen, which is not the same as
 * what the forge is called: GitHub's field asks for an **API** root (`…/api/v3`, or
 * `api.github.com`) while GitLab's takes the instance itself. Telling somebody to "set the
 * GitHub URL" sends them to paste `https://github.com`, which is the one value that will not
 * work — so the sentence uses the label they are looking at.
 */
const URL_FIELD: Record<ForgeProvider, string> = {
  github: 'GitHub API URL',
  gitlab: 'GitLab URL',
};

/**
 * The configured base URL for `provider`, trimmed — or a thrown sentence naming the setting.
 *
 * Trimmed on the way out and not merely tested: `GitLabClient.url` strips a trailing slash
 * but not surrounding whitespace, so a pasted `" https://gitlab.example.com "` survives every
 * `.trim()` check written around it and still builds an unfetchable URL. Same class of
 * failure as a token pasted with a newline on it — see `@shared/secretToken`.
 */
export function forgeBaseUrl(provider: ForgeProvider, settings: AppSettings): string {
  const raw = (provider === 'github' ? settings.github?.baseUrl : settings.gitlab?.baseUrl) ?? '';
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Set the ${URL_FIELD[provider]} in Settings first.`);
  return trimmed;
}
