/**
 * Release: bring connectors from the development repo (appmixer-connectors
 * dev) to the release branch (appmixer-components master) through a pull
 * request — one commit per connector with the message
 * "<connector> <version> (<new|major|minor|patch>)", the convention of the
 * hand-made releases.
 *
 * Each commit mirrors the connector directory: files are added, changed and
 * deleted to match dev, while nested connectors (utils/http inside utils) and
 * excluded files (ai-artifacts, lockfiles) are left alone. It also carries the
 * added or changed shared files of the connector's namespace (google/auth.js,
 * microsoft/microsoft-commons.js, ...) — the connector was developed against
 * them. Shared files are never deleted: other connectors of the namespace that
 * are not part of the release may still need them.
 *
 * The commits are chained through the Git Data API in the head repo (the
 * `release` branch of a fork by default) on top of master, or on top of the
 * open release PR, which then just gets more commits. The head branch moves
 * once at the end, so either every commit lands or none does. Nothing reaches
 * master (and the Marketplace PRD workflow) until someone merges the PR with
 * "Rebase and merge", which keeps one commit per connector.
 */

import { getGitHubConfig } from '$lib/api/github.js';
import {
  CONNECTORS_ROOT,
  diffPaths,
  githubRequest,
  headInfo,
  loadReleaseState,
  mapLimit,
  snapshotInfo
} from './compare.js';

const BLOB_COPY_CONCURRENCY = 8;
const NO_CHANGES = { added: [], modified: [], removed: [] };
const PR_TITLE = '[RELEASE]';

export class ReleaseError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] - HTTP status for the API response
   */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const relative = (paths) => paths.map((path) => path.slice(CONNECTORS_ROOT.length));
const firstLine = (message) => String(message).split('\n')[0];

function summarize(step) {
  const { connector, own, shared } = step;
  return {
    connector: connector.name,
    version: connector.devVersion,
    type: connector.status,
    message: connector.message,
    added: relative(own.added),
    modified: relative(own.modified),
    removed: relative(own.removed),
    removedComponents: connector.removedComponents,
    renamedComponents: connector.renamedComponents,
    addedComponents: connector.addedComponents,
    shared: {
      added: relative(shared.added),
      modified: relative(shared.modified),
      // Shared files removed on dev stay on the release branch
      keptRemoved: relative(shared.removed)
    }
  };
}

function prBody(messages, source, target) {
  return [
    `Connectors from ${source.repo.fullName}@${source.repo.branch}, released from the appmixer-sanity Release page — one commit per connector:`,
    '',
    ...messages.map((message) => `- ${message}`),
    '',
    `**Merge with "Rebase and merge"** to keep one commit per connector on \`${target.repo.branch}\` (a squash merge folds them into one). Merging starts the Marketplace PRD workflow.`
  ].join('\n');
}

/** Head sha of a branch, null when the branch doesn't exist */
async function readBranch(token, repo) {
  try {
    const ref = await githubRequest(
      token,
      'GET',
      `/repos/${repo.fullName}/git/ref/heads/${encodeURIComponent(repo.branch)}`
    );
    return ref.object.sha;
  } catch (e) {
    if (/** @type {any} */ (e).status === 404) return null;
    throw e;
  }
}

/**
 * A head branch without an open PR gets reset onto the target branch. Refuse
 * when it carries commits the target doesn't have — compared by message,
 * because "Rebase and merge" rewrites the shas but keeps the messages — so
 * unmerged work is never thrown away.
 */
async function assertNothingUnmerged(token, target, head) {
  const compare = await githubRequest(
    token,
    'GET',
    `/repos/${target.repo.fullName}/compare/${encodeURIComponent(target.repo.branch)}...` +
      encodeURIComponent(`${head.owner}:${head.branch}`)
  );
  if (!compare.ahead_by) return;

  const onTarget = new Set();
  for (let page = 1; page <= 3; page++) {
    const commits = await githubRequest(
      token,
      'GET',
      `/repos/${target.repo.fullName}/commits?sha=${encodeURIComponent(target.repo.branch)}&per_page=100&page=${page}`
    );
    for (const commit of commits) onTarget.add(firstLine(commit.commit.message));
    if (commits.length < 100) break;
  }

  const unmerged = compare.commits.filter((c) => !onTarget.has(firstLine(c.commit.message)));
  if (unmerged.length > 0) {
    throw new ReleaseError(
      `${head.fullName}@${head.branch} has ${unmerged.length} commit(s) that are not on ` +
        `${target.repo.branch} and no open PR (e.g. "${firstLine(unmerged[0].commit.message)}") — ` +
        'merge or delete that branch first',
      409
    );
  }
}

/** Commit messages of a PR, oldest first */
async function listPrMessages(token, target, number) {
  const messages = [];
  for (let page = 1; page <= 3; page++) {
    const commits = await githubRequest(
      token,
      'GET',
      `/repos/${target.repo.fullName}/pulls/${number}/commits?per_page=100&page=${page}`
    );
    messages.push(...commits.map((c) => firstLine(c.commit.message)));
    if (commits.length < 100) break;
  }
  return messages;
}

/**
 * Plan (dryRun) or perform a release.
 * @param {string} userId - User ID (email); their GitHub token overrides the env token
 * @param {Array<{name: string, devVersion?: string}>} items - Connectors to release.
 *   `devVersion` is the version the caller reviewed — the release is refused
 *   when dev has moved to another version since.
 * @param {{dryRun?: boolean}} [options]
 */
export async function releaseConnectors(userId, items, { dryRun = false } = {}) {
  const { token } = await getGitHubConfig(userId);
  if (!token) {
    throw new ReleaseError('No GitHub token configured (SANITY_GITHUB_TOKEN or Settings)', 400);
  }

  const state = await loadReleaseState(token);
  const { source, target, pending, pr, head } = state;
  const byName = new Map(state.connectors.map((c) => [c.name, c]));

  const selected = new Map();
  for (const item of items) {
    const connector = byName.get(item.name);
    if (!connector) {
      throw new ReleaseError(`Unknown connector: ${item.name}`, 404);
    }
    if (!connector.releasable) {
      throw new ReleaseError(
        connector.inPr
          ? `${item.name} ${connector.devVersion} is already in PR #${connector.inPr.number}`
          : `${item.name} has nothing to release (${connector.status})`,
        409
      );
    }
    if (item.devVersion && item.devVersion !== connector.devVersion) {
      throw new ReleaseError(
        `${item.name} changed on ${source.repo.branch} since the page was loaded ` +
          `(${item.devVersion} → ${connector.devVersion}) — refresh and review it again`,
        409
      );
    }
    selected.set(connector.name, connector);
  }

  // The commits build on the open release PR when there is one, else on the
  // release branch itself. Planned against a working copy of that tree, so a
  // namespace's shared files ship with the first of its connectors only.
  const base = pending || target;
  const working = new Map(base.files);
  const steps = [...selected.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((connector) => {
      const own = diffPaths(state.byConnector.get(connector.name) || [], source.files, working);
      const shared = connector.namespace
        ? diffPaths(state.byNamespace.get(connector.namespace) || [], source.files, working)
        : NO_CHANGES;
      const writes = [...own.added, ...own.modified, ...shared.added, ...shared.modified];
      for (const path of writes) working.set(path, source.files.get(path));
      for (const path of own.removed) working.delete(path);
      return { connector, own, shared, writes, deletes: own.removed };
    })
    .filter((step) => step.writes.length + step.deletes.length > 0);

  if (steps.length === 0) {
    throw new ReleaseError('Nothing to commit — the release branch already has these files', 409);
  }

  if (dryRun) {
    return {
      dryRun: true,
      source: snapshotInfo(source),
      target: snapshotInfo(target),
      head: headInfo(head),
      pr,
      commits: steps.map(summarize)
    };
  }

  // Without an open PR the head branch is reset onto the release branch —
  // check it first, before anything is written
  const existingHead = pr ? null : await readBranch(token, head);
  if (existingHead) {
    await assertNothingUnmerged(token, target, head);
  }
  const previousMessages = pr ? await listPrMessages(token, target, pr.number) : [];

  const headApi = `/repos/${head.fullName}`;

  // Copy the blobs the head repo doesn't have yet. Git objects are
  // content-addressed: a file already present anywhere in the base tree
  // (unchanged icon, a file moved between components) needs no upload, and the
  // copy must come back with the same sha. A fork shares its parent's objects,
  // so the base tree itself needs no copying.
  const known = new Set([...base.files.values()].map((file) => file.sha));
  const missing = [
    ...new Set(steps.flatMap((step) => step.writes.map((path) => source.files.get(path).sha)))
  ].filter((sha) => !known.has(sha));
  await mapLimit(missing, BLOB_COPY_CONCURRENCY, async (sha) => {
    const blob = await githubRequest(
      token,
      'GET',
      `/repos/${source.repo.fullName}/git/blobs/${sha}`
    );
    const created = await githubRequest(token, 'POST', `${headApi}/git/blobs`, {
      content: blob.content.replace(/\n/g, ''),
      encoding: 'base64'
    });
    if (created.sha !== sha) {
      throw new Error(`Blob ${sha} was copied as ${created.sha}`);
    }
  });

  let parent = base.commitSha;
  let treeSha = base.treeSha;
  const commits = [];
  for (const step of steps) {
    const entries = [
      ...step.writes.map((path) => {
        const file = source.files.get(path);
        return { path, mode: file.mode, type: 'blob', sha: file.sha };
      }),
      ...step.deletes.map((path) => ({
        path,
        mode: base.files.get(path)?.mode || '100644',
        type: 'blob',
        sha: null
      }))
    ];
    const tree = await githubRequest(token, 'POST', `${headApi}/git/trees`, {
      base_tree: treeSha,
      tree: entries
    });
    const commit = await githubRequest(token, 'POST', `${headApi}/git/commits`, {
      message: step.connector.message,
      tree: tree.sha,
      parents: [parent]
    });
    parent = commit.sha;
    treeSha = tree.sha;
    commits.push({ ...summarize(step), sha: commit.sha, url: commit.html_url });
  }

  // Move the head branch once: fast-forward onto the open PR, else reset it
  // onto the release branch (checked above) or create it
  const refPath = `${headApi}/git/refs/heads/${encodeURIComponent(head.branch)}`;
  try {
    if (pr) {
      await githubRequest(token, 'PATCH', refPath, { sha: parent, force: false });
    } else if (existingHead) {
      await githubRequest(token, 'PATCH', refPath, { sha: parent, force: true });
    } else {
      await githubRequest(token, 'POST', `${headApi}/git/refs`, {
        ref: `refs/heads/${head.branch}`,
        sha: parent
      });
    }
  } catch (e) {
    if (/** @type {any} */ (e).status === 422) {
      throw new ReleaseError(
        `${head.fullName}@${head.branch} moved while releasing — nothing was published. Refresh and try again.`,
        409
      );
    }
    // A ref that brings .github/workflows/ changes into a fork (its branches are
    // behind upstream) needs a token with the `workflow` scope — without it the
    // ref API answers 404, while blobs, trees and commits still go through
    if (/** @type {any} */ (e).status === 404) {
      throw new ReleaseError(
        `GitHub refused to ${pr || existingHead ? 'move' : 'create'} ${head.fullName}@${head.branch} (404) — nothing was published. ` +
          `The commits bring in .github/workflows/ changes the fork doesn't have yet, and pushing those needs a GitHub token ` +
          `with the "workflow" scope. Add that scope to the token (or sync the fork's master with upstream) and try again.`,
        403
      );
    }
    throw e;
  }

  const messages = [...previousMessages, ...commits.map((c) => c.message)];
  let releasePr;
  try {
    if (pr) {
      await githubRequest(token, 'PATCH', `/repos/${target.repo.fullName}/pulls/${pr.number}`, {
        body: prBody(messages, source, target)
      });
      releasePr = { ...pr, created: false };
    } else {
      const created = await githubRequest(token, 'POST', `/repos/${target.repo.fullName}/pulls`, {
        title: PR_TITLE,
        head: `${head.owner}:${head.branch}`,
        base: target.repo.branch,
        body: prBody(messages, source, target)
      });
      releasePr = {
        number: created.number,
        url: created.html_url,
        title: created.title,
        created: true
      };
    }
  } catch (e) {
    throw new ReleaseError(
      `The commits are on ${head.fullName}@${head.branch}, but ${pr ? 'updating' : 'opening'} the PR failed: ` +
        `${/** @type {any} */ (e).message} — open it on GitHub by hand`,
      502
    );
  }

  return {
    dryRun: false,
    source: snapshotInfo(source),
    target: snapshotInfo(target),
    head: { ...headInfo(head), sha: parent },
    pr: releasePr,
    commits
  };
}
