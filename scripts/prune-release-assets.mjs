/**
 * Delete every asset uploaded to every release except the one `promote` just published —
 * the installers and feeds the Windows and Linux jobs leave behind pile up release after
 * release, and nothing else in this repository ever cleans them.
 *
 * The rule — "every asset of every release whose tag is not the one being kept, drafts
 * included" — lives here, next to its unit test, for the same reason `next-version.mjs`
 * does (see that file's header): `planPrune` is a pure function over plain data, so the
 * decision is testable without a GitHub token, a release, or an asset ever existing.
 *
 * ## Why GraphQL, not the REST list endpoint
 *
 * `GET /repos/{owner}/{repo}/releases` — what `gh release list` and a naive REST client
 * both call — returned a flat empty `[]` for this repo, every page it claimed to have, the
 * same failure `release.yml`'s Windows job already worked around for the upload side (see
 * its "Upload the installer and feed to the draft" comment). `gh api graphql` against
 * `repository.releases` does not go through that endpoint at all, so it is what this script
 * uses to both list releases and read their assets.
 *
 * ## Why two queries, not one
 *
 * The releases connection is queried once for every release's `releaseAssets.totalCount`
 * alone, with no asset nodes — that is one page of up to 100 releases per call. Only
 * releases that still have assets (almost always just the one or two most recent, since
 * this script deletes everything else) are then queried a second time for their assets'
 * actual names. Once a release has been pruned once, its `totalCount` is 0 forever after,
 * so every run after the first costs about one call per asset that still exists rather than
 * one per release — the difference between the GITHUB_TOKEN rate limit and the ~130 releases
 * this repo already had the first time this ran.
 *
 * ## Running it
 *
 *   node scripts/prune-release-assets.mjs --keep v0.120.0
 *   node scripts/prune-release-assets.mjs --keep v0.120.0 --dry-run
 *
 * Reads the repository from `GH_REPO` (`owner/name`, what `release.yml` already sets for
 * `promote`) and falls back to `gh repo view` for a local run. `--dry-run` lists what would
 * be deleted without calling `gh release delete-asset`. Deletions that fail are collected and
 * reported at the end rather than stopping the run — one bad asset should not strand every
 * other one — and the process exits non-zero if any failed, so a caller that wants this to
 * stay non-fatal (`promote` does — see `release.yml`) wraps the invocation in `|| echo
 * ::warning::...` rather than relying on this script to swallow the failure itself.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `{tag, asset}` pairs to delete: every asset of every release whose tag is not
 * `keepTag`. Drafts are not special-cased — a draft release's assets are pruned exactly
 * like a published one's, which is why this function never looks at an `isDraft` field.
 *
 * @param {{tag: string, assets: string[]}[]} releases
 * @param {string} keepTag
 * @returns {{tag: string, asset: string}[]}
 */
export function planPrune(releases, keepTag) {
  const pairs = [];
  for (const release of releases ?? []) {
    if (release.tag === keepTag) continue;
    for (const asset of release.assets ?? []) {
      pairs.push({ tag: release.tag, asset });
    }
  }
  return pairs;
}

/** Runs `gh api graphql`, with `query` and GraphQL variables, and returns the parsed `data`. */
function ghGraphQL(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push('-F', `${name}=${value}`);
  }
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out).data;
}

const RELEASE_SUMMARIES_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      releases(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          tagName
          releaseAssets(first: 1) { totalCount }
        }
      }
    }
  }
`;

const RELEASE_ASSET_NAMES_QUERY = `
  query($owner: String!, $name: String!, $tag: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      release(tagName: $tag) {
        releaseAssets(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  }
`;

/** Every release's tag and asset count, paginated — no asset names fetched here. */
function fetchReleaseSummaries(owner, name) {
  const summaries = [];
  let after = null;
  for (;;) {
    const data = ghGraphQL(RELEASE_SUMMARIES_QUERY, { owner, name, after });
    const connection = data.repository.releases;
    for (const node of connection.nodes) {
      summaries.push({ tag: node.tagName, assetCount: node.releaseAssets.totalCount });
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return summaries;
}

/** Every asset name on one release, paginated. */
function fetchAssetNames(owner, name, tag) {
  const names = [];
  let after = null;
  for (;;) {
    const data = ghGraphQL(RELEASE_ASSET_NAMES_QUERY, { owner, name, tag, after });
    const connection = data.repository.release.releaseAssets;
    for (const node of connection.nodes) names.push(node.name);
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return names;
}

/** Every release that still has at least one asset, with those assets' names filled in. */
function fetchReleasesWithAssets(owner, name) {
  const summaries = fetchReleaseSummaries(owner, name);
  const releases = [];
  for (const summary of summaries) {
    if (summary.assetCount === 0) continue;
    releases.push({ tag: summary.tag, assets: fetchAssetNames(owner, name, summary.tag) });
  }
  return releases;
}

/** `owner/name` from `GH_REPO`, or from `gh repo view` when that is unset (a local run). */
function readRepo() {
  if (process.env.GH_REPO) {
    const [owner, name] = process.env.GH_REPO.split('/');
    return { owner, name };
  }
  const out = execFileSync('gh', ['repo', 'view', '--json', 'owner,name'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  return { owner: parsed.owner.login, name: parsed.name };
}

function parseArgs(argv) {
  let keepTag = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') {
      keepTag = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  if (!keepTag) throw new Error('Usage: prune-release-assets.mjs --keep <tag> [--dry-run]');
  return { keepTag, dryRun };
}

function main() {
  const { keepTag, dryRun } = parseArgs(process.argv.slice(2));
  const { owner, name } = readRepo();

  const releases = fetchReleasesWithAssets(owner, name);
  const pairs = planPrune(releases, keepTag);

  if (pairs.length === 0) {
    console.log('Nothing to prune.');
    return;
  }

  const failures = [];
  for (const { tag, asset } of pairs) {
    if (dryRun) {
      console.log(`[dry run] would delete ${tag} ${asset}`);
      continue;
    }
    try {
      execFileSync('gh', ['release', 'delete-asset', tag, asset, '-y'], { stdio: 'pipe' });
      console.log(`deleted ${tag} ${asset}`);
    } catch (err) {
      console.log(`FAILED to delete ${tag} ${asset}: ${err.message}`);
      failures.push({ tag, asset, message: err.message });
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} asset(s) failed to delete:`);
    for (const failure of failures) console.log(`  ${failure.tag} ${failure.asset}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
