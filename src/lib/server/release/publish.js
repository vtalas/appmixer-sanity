/**
 * Release: copy connectors from the development repo (appmixer-connectors dev)
 * to the release repo (appmixer-components master) — one commit per connector
 * with the message "<connector> <version> (<new|major|minor|patch>)", the same
 * convention as the hand-made releases before.
 *
 * Each commit mirrors the connector directory: files are added, changed and
 * deleted to match dev, while nested connectors (utils/http inside utils) and
 * excluded files (ai-artifacts, lockfiles) are left alone. It also carries the
 * added or changed shared files of the connector's namespace (google/auth.js,
 * microsoft/microsoft-commons.js, ...) — the connector was developed against
 * them. Shared files are never deleted: other connectors of the namespace that
 * are not part of the release may still need them.
 *
 * The commits are chained through the Git Data API and published with a single
 * fast-forward of the branch ref at the end: either every commit lands or none
 * does, and a branch that moved meanwhile rejects the update.
 */

import { getGitHubConfig } from '$lib/api/github.js';
import {
  CONNECTORS_ROOT,
  diffPaths,
  githubRequest,
  loadReleaseState,
  mapLimit,
  snapshotInfo
} from './compare.js';

const BLOB_COPY_CONCURRENCY = 8;
const NO_CHANGES = { added: [], modified: [], removed: [] };

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
    shared: {
      added: relative(shared.added),
      modified: relative(shared.modified),
      // Shared files removed on dev stay on the release branch
      keptRemoved: relative(shared.removed)
    }
  };
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
  const { source, target } = state;
  const byName = new Map(state.connectors.map((c) => [c.name, c]));

  const selected = new Map();
  for (const item of items) {
    const connector = byName.get(item.name);
    if (!connector) {
      throw new ReleaseError(`Unknown connector: ${item.name}`, 404);
    }
    if (!connector.releasable) {
      throw new ReleaseError(`${item.name} has nothing to release (${connector.status})`, 409);
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

  // Plan the commits against a working copy of the release tree, so that a
  // namespace's shared files ship with the first of its connectors only
  const working = new Map(target.files);
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
    });

  if (dryRun) {
    return {
      dryRun: true,
      source: snapshotInfo(source),
      target: snapshotInfo(target),
      commits: steps.map(summarize)
    };
  }

  const base = `/repos/${target.repo.fullName}`;

  // Copy the blobs the release repo doesn't have yet. Git objects are
  // content-addressed: a file already present anywhere on the release branch
  // (unchanged icon, a file moved between components) needs no upload, and the
  // copy must come back with the same sha.
  const known = new Set([...target.files.values()].map((file) => file.sha));
  const missing = [
    ...new Set(steps.flatMap((step) => step.writes.map((path) => source.files.get(path).sha)))
  ].filter((sha) => !known.has(sha));
  await mapLimit(missing, BLOB_COPY_CONCURRENCY, async (sha) => {
    const blob = await githubRequest(
      token,
      'GET',
      `/repos/${source.repo.fullName}/git/blobs/${sha}`
    );
    const created = await githubRequest(token, 'POST', `${base}/git/blobs`, {
      content: blob.content.replace(/\n/g, ''),
      encoding: 'base64'
    });
    if (created.sha !== sha) {
      throw new Error(`Blob ${sha} was copied as ${created.sha}`);
    }
  });

  let parent = target.commitSha;
  let treeSha = target.treeSha;
  const commits = [];
  for (const step of steps) {
    const entries = [
      ...step.writes.map((path) => {
        const file = source.files.get(path);
        return { path, mode: file.mode, type: 'blob', sha: file.sha };
      }),
      ...step.deletes.map((path) => ({
        path,
        mode: target.files.get(path).mode,
        type: 'blob',
        sha: null
      }))
    ];
    if (entries.length === 0) continue;

    const tree = await githubRequest(token, 'POST', `${base}/git/trees`, {
      base_tree: treeSha,
      tree: entries
    });
    const commit = await githubRequest(token, 'POST', `${base}/git/commits`, {
      message: step.connector.message,
      tree: tree.sha,
      parents: [parent]
    });
    parent = commit.sha;
    treeSha = tree.sha;
    commits.push({ ...summarize(step), sha: commit.sha, url: commit.html_url });
  }

  if (commits.length === 0) {
    throw new ReleaseError('Nothing to commit — the release branch already has these files', 409);
  }

  try {
    await githubRequest(
      token,
      'PATCH',
      `${base}/git/refs/heads/${encodeURIComponent(target.repo.branch)}`,
      { sha: parent, force: false }
    );
  } catch (e) {
    if (/** @type {any} */ (e).status === 422) {
      throw new ReleaseError(
        `${target.repo.fullName}@${target.repo.branch} moved while releasing — nothing was published. Refresh and try again.`,
        409
      );
    }
    throw e;
  }

  return {
    dryRun: false,
    source: snapshotInfo(source),
    target: { ...snapshotInfo(target), newCommitSha: parent },
    commits,
    compareUrl: `https://github.com/${target.repo.fullName}/compare/${target.commitSha}...${parent}`
  };
}
