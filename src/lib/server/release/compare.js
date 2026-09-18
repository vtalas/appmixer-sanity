/**
 * Release comparison: the release repo (appmixer-components master — what the
 * PRD marketplace is built from) against the development repo
 * (appmixer-connectors dev).
 *
 * A connector is a directory under src/appmixer/ holding a bundle.json; its
 * version is bundle.json `version`. Everything comes from one recursive git
 * tree per repo plus the bundle.json blobs (cached in the DB by blob sha — git
 * blobs are content-addressed, so a cached entry never goes stale). Comparing
 * blob shas tells which files differ without downloading any of them.
 */

import { env } from '$env/dynamic/private';
import { getGitHubConfig } from '$lib/api/github.js';
import { getBundleBlobs, saveBundleBlobs } from '$lib/db/release.js';
import { parseVersion, compareParsed } from './version.js';
import { loadReadiness } from './readiness.js';

const GITHUB_API_BASE = 'https://api.github.com';
export const CONNECTORS_ROOT = 'src/appmixer/';
const BUNDLE_FETCH_CONCURRENCY = 10;
const GET_RETRIES = 2;
// A stalled connection must fail fast (and be retried) instead of hanging the
// page until the function timeout
const REQUEST_TIMEOUT_MS = 30000;
const TREE_CACHE_SIZE = 4;

// Files of recursive trees by tree sha. Content-addressed, so an entry never
// goes stale; kept for the life of the server instance. Each tree is ~3 MB of
// JSON and ~1.5 s to download, and a page load needs two.
/** @type {Map<string, Map<string, {sha: string, mode: string}>>} */
const treeCache = new Map();

// Statuses a connector can be released from (dev version is newer or the
// connector isn't on the release branch at all)
const RELEASABLE = new Set(['new', 'major', 'minor', 'patch']);

/**
 * Source (development), target (the release branch a PR goes into) and head
 * (the branch the release commits are pushed to — by default the `release`
 * branch of vtalas's fork, the head of every "[RELEASE]" PR so far).
 * `project` is the GitHub project the work is tracked on and `readyStatuses`
 * the values of its Status field that mean "ready to release".
 * @returns {{source: RepoRef, target: RepoRef, head: RepoRef, project: ProjectRef, readyStatuses: string[]}}
 *
 * @typedef {{owner: string, name: string, fullName: string, branch: string, url: string}} RepoRef
 * @typedef {{owner: string, number: number, url: string}} ProjectRef
 */
export function getReleaseConfig() {
  return {
    source: repoRef(
      env.RELEASE_SOURCE_REPO || 'Appmixer-ai/appmixer-connectors',
      env.RELEASE_SOURCE_BRANCH || 'dev'
    ),
    target: repoRef(
      env.RELEASE_TARGET_REPO || 'Appmixer-ai/appmixer-components',
      env.RELEASE_TARGET_BRANCH || 'master'
    ),
    head: repoRef(
      env.RELEASE_HEAD_REPO || 'vtalas/appmixer-components',
      env.RELEASE_HEAD_BRANCH || 'release'
    ),
    project: projectRef(env.RELEASE_PROJECT || 'Appmixer-ai/7'),
    readyStatuses: (env.RELEASE_READY_STATUSES || 'Done')
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean)
  };
}

/**
 * The open PR from the head branch into the target branch, if any.
 * @param {string} token
 * @param {{target: RepoRef, head: RepoRef}} config
 * @returns {Promise<{number: number, url: string, title: string} | null>}
 */
async function findReleasePr(token, { target, head }) {
  const prs = await githubRequest(
    token,
    'GET',
    `/repos/${target.fullName}/pulls?state=open&base=${encodeURIComponent(target.branch)}` +
      `&head=${encodeURIComponent(`${head.owner}:${head.branch}`)}`
  );
  const pr = prs[0];
  return pr ? { number: pr.number, url: pr.html_url, title: pr.title } : null;
}

/** @param {string} value - "<organization>/<project number>" */
function projectRef(value) {
  const [owner, number] = value.split('/');
  return {
    owner,
    number: Number(number),
    url: `https://github.com/orgs/${owner}/projects/${number}`
  };
}

function repoRef(fullName, branch) {
  const [owner, name] = fullName.split('/');
  return { owner, name, fullName, branch, url: `https://github.com/${fullName}/tree/${branch}` };
}

/**
 * GitHub REST call. Throws with the HTTP status attached (`error.status`).
 * @param {string} token
 * @param {string} method
 * @param {string} path - API path starting with /
 * @param {any} [body]
 */
export async function githubRequest(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    // Reads are retried on network errors and 5xx — a multi-MB tree download
    // cut off halfway ("terminated") would otherwise fail the whole page
    const retry = method === 'GET' && attempt < GET_RETRIES;
    let response;
    try {
      response = await fetch(`${GITHUB_API_BASE}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'appmixer-sanity-check',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.ok) return await response.json();
    } catch (e) {
      if (!retry) throw e;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    if (retry && response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    const detail = await response.json().catch(() => null);
    const error = new Error(
      `GitHub ${method} ${path} failed: ${response.status}${detail?.message ? ` ${detail.message}` : ''}`
    );
    /** @type {any} */ (error).status = response.status;
    throw error;
  }
}

/**
 * Run `fn` over items with limited concurrency
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<any>} fn
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Branch head + every file under src/appmixer/ with its blob sha and mode.
 * @param {string} token
 * @param {RepoRef} repo
 */
async function fetchSnapshot(token, repo) {
  const base = `/repos/${repo.fullName}`;
  const branch = await githubRequest(
    token,
    'GET',
    `${base}/branches/${encodeURIComponent(repo.branch)}`
  );
  const treeSha = branch.commit.commit.tree.sha;

  let files = treeCache.get(treeSha);
  if (!files) {
    const tree = await githubRequest(token, 'GET', `${base}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) {
      throw new Error(
        `The git tree of ${repo.fullName}@${repo.branch} is too large to list in one request`
      );
    }
    files = new Map();
    for (const item of tree.tree) {
      if (item.type === 'blob' && item.path.startsWith(CONNECTORS_ROOT)) {
        files.set(item.path, { sha: item.sha, mode: item.mode });
      }
    }
    treeCache.set(treeSha, files);
    const oldest = treeCache.keys().next().value;
    if (treeCache.size > TREE_CACHE_SIZE && oldest) treeCache.delete(oldest);
  }

  return {
    repo,
    commitSha: branch.commit.sha,
    treeSha,
    committedAt: branch.commit.commit.committer?.date || null,
    files
  };
}

/** @param {Awaited<ReturnType<typeof fetchSnapshot>>} snapshot */
function snapshotInfo(snapshot) {
  return {
    repo: snapshot.repo.fullName,
    branch: snapshot.repo.branch,
    url: snapshot.repo.url,
    commitSha: snapshot.commitSha,
    committedAt: snapshot.committedAt
  };
}

/**
 * Files a release never carries and never deletes from the release repo: the
 * AI pipeline's scratch state (artifacts/ai-artifacts/) and npm lockfiles.
 * None of them has been released to appmixer-components master by hand either.
 * @param {string} path
 */
export function isExcluded(path) {
  const parts = path.split('/');
  return parts.includes('ai-artifacts') || parts[parts.length - 1] === 'package-lock.json';
}

/** Connector directories (relative to src/appmixer/) — every dir with a bundle.json */
function connectorRoots(files) {
  const roots = new Set();
  for (const path of files.keys()) {
    if (!path.endsWith('/bundle.json')) continue;
    const root = path.slice(CONNECTORS_ROOT.length, -'/bundle.json'.length);
    if (root) roots.add(root);
  }
  return roots;
}

/**
 * Nearest connector directory containing the path. Nested connectors win over
 * their parent (utils/http, not utils). null = a namespace's shared file
 * (google/auth.js) or a loose file.
 */
function ownerOf(path, roots) {
  const parts = path.slice(CONNECTORS_ROOT.length).split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    if (roots.has(dir)) return dir;
  }
  return null;
}

/**
 * Group the paths of both repos by connector, and the paths no connector owns
 * by namespace (first directory: google, microsoft, aws, ...).
 */
function indexPaths(roots, ...fileMaps) {
  /** @type {Map<string, string[]>} */
  const byConnector = new Map();
  /** @type {Map<string, string[]>} */
  const byNamespace = new Map();
  const seen = new Set();

  for (const files of fileMaps) {
    for (const path of files.keys()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const owner = ownerOf(path, roots);
      if (owner) {
        if (!byConnector.has(owner)) byConnector.set(owner, []);
        byConnector.get(owner).push(path);
        continue;
      }
      const rel = path.slice(CONNECTORS_ROOT.length);
      const slash = rel.indexOf('/');
      if (slash <= 0) continue; // loose file directly in src/appmixer/
      const namespace = rel.slice(0, slash);
      if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
      byNamespace.get(namespace).push(path);
    }
  }

  return { byConnector, byNamespace };
}

/**
 * File-level diff of the given paths from the release repo (target) to dev
 * (source). Excluded files are skipped on both sides.
 * @param {string[]} paths
 * @param {Map<string, {sha: string, mode: string}>} sourceFiles
 * @param {Map<string, {sha: string, mode: string}>} targetFiles
 */
export function diffPaths(paths, sourceFiles, targetFiles) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const path of paths) {
    if (isExcluded(path)) continue;
    const src = sourceFiles.get(path);
    const dst = targetFiles.get(path);
    if (src && !dst) added.push(path);
    else if (!src && dst) removed.push(path);
    else if (src && dst && (src.sha !== dst.sha || src.mode !== dst.mode)) modified.push(path);
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

/**
 * Read every connector's bundle.json from both repos — from the DB cache by
 * blob sha, fetching (and caching) only blobs not seen before.
 * @returns {Promise<Map<string, string>>} blob sha -> content
 */
async function readBundles(token, snapshots, roots) {
  /** @type {Map<string, RepoRef>} */
  const wanted = new Map();
  for (const snapshot of snapshots) {
    for (const root of roots) {
      const file = snapshot.files.get(`${CONNECTORS_ROOT}${root}/bundle.json`);
      if (file && !wanted.has(file.sha)) wanted.set(file.sha, snapshot.repo);
    }
  }

  const contents = await getBundleBlobs([...wanted.keys()]);
  const missing = [...wanted].filter(([sha]) => !contents.has(sha));
  const fetched = [];
  try {
    await mapLimit(missing, BUNDLE_FETCH_CONCURRENCY, async ([sha, repo]) => {
      const blob = await githubRequest(token, 'GET', `/repos/${repo.fullName}/git/blobs/${sha}`);
      const content = Buffer.from(blob.content, 'base64').toString('utf-8');
      contents.set(sha, content);
      fetched.push([sha, content]);
    });
  } finally {
    // Keep what was fetched even when one blob failed — the retry is then cheaper
    await saveBundleBlobs(fetched);
  }
  return contents;
}

function parseBundle(content) {
  if (content == null) return null;
  try {
    const bundle = JSON.parse(content);
    return {
      version: typeof bundle.version === 'string' ? bundle.version : null,
      changelog: bundle.changelog && typeof bundle.changelog === 'object' ? bundle.changelog : {}
    };
  } catch {
    return { version: null, changelog: {} };
  }
}

/**
 * Commit message of a release — the convention of appmixer-components master:
 * "<connector> <version> (<new|major|minor|patch>)", e.g. "hubspot 4.8.1 (patch)".
 */
function releaseMessage(name, version, status) {
  return `${name} ${version} (${status})`;
}

/**
 * Compare one connector between the two repos.
 */
function describeConnector(name, state, bundles) {
  const { source, target, pending, pr } = state;
  const bundlePath = `${CONNECTORS_ROOT}${name}/bundle.json`;
  const devFile = source.files.get(bundlePath);
  const masterFile = target.files.get(bundlePath);
  const dev = devFile ? parseBundle(bundles.get(devFile.sha)) : null;
  const master = masterFile ? parseBundle(bundles.get(masterFile.sha)) : null;
  const devParsed = parseVersion(dev?.version);
  const masterParsed = parseVersion(master?.version);

  const diff = diffPaths(state.byConnector.get(name) || [], source.files, target.files);
  const changed = diff.added.length + diff.modified.length + diff.removed.length > 0;

  let status;
  if (!dev) status = 'master-only';
  else if (!devParsed) status = 'invalid';
  else if (!master) status = 'new';
  else if (!masterParsed) status = 'invalid';
  else {
    const cmp = compareParsed(devParsed, masterParsed);
    if (cmp < 0) status = 'behind';
    else if (cmp === 0) status = changed ? 'drift' : 'same';
    else if (devParsed.major !== masterParsed.major) status = 'major';
    else if (devParsed.minor !== masterParsed.minor) status = 'minor';
    else status = 'patch';
  }

  // Already on its way: the open release PR carries another bundle than master
  const pendingFile = pending?.files.get(bundlePath);
  const pendingVersion =
    pendingFile && pendingFile.sha !== masterFile?.sha
      ? (parseBundle(bundles.get(pendingFile.sha))?.version ?? null)
      : null;
  const inPr = pendingVersion ? { number: pr.number, url: pr.url, version: pendingVersion } : null;

  // Releasable unless the open PR already carries this very version
  const releasable = RELEASABLE.has(status) && !(inPr && inPr.version === dev?.version);

  // Changelog entries the release would ship (everything newer than master)
  const changelog = Object.entries(dev?.changelog || {})
    .map(([version, items]) => ({
      version,
      parsed: parseVersion(version),
      items: (Array.isArray(items) ? items : [items]).map((item) => String(item))
    }))
    .filter(
      (entry) => entry.parsed && (!masterParsed || compareParsed(entry.parsed, masterParsed) > 0)
    )
    .sort((a, b) => compareParsed(a.parsed, b.parsed))
    .map(({ version, items }) => ({ version, items }));

  const prefix = `${CONNECTORS_ROOT}${name}/`;
  const relative = (paths) => paths.map((path) => path.slice(prefix.length));
  const componentOf = (path) => path.slice(prefix.length).split('/').slice(-2, -1)[0];
  const isComponent = (path) => path.endsWith('/component.json');

  // A component whose directory only changed case or place (MakeAPICall →
  // MakeApiCall) shows up as removed + added — report it as renamed instead
  const removedNames = diff.removed.filter(isComponent).map(componentOf);
  const addedNames = diff.added.filter(isComponent).map(componentOf);
  const renamedComponents = [];
  for (const from of removedNames) {
    const to = addedNames.find((added) => added.toLowerCase() === from.toLowerCase());
    if (to) renamedComponents.push({ from, to });
  }

  return {
    name,
    namespace: name.includes('/') ? name.slice(0, name.indexOf('/')) : null,
    devVersion: dev?.version ?? null,
    masterVersion: master?.version ?? null,
    status,
    releasable,
    inPr,
    message: RELEASABLE.has(status) ? releaseMessage(name, dev.version, status) : null,
    changes: {
      added: relative(diff.added),
      modified: relative(diff.modified),
      removed: relative(diff.removed)
    },
    // Components the release deletes (on master, dev doesn't have them at all)
    removedComponents: removedNames.filter((n) => !renamedComponents.some((r) => r.from === n)),
    addedComponents: addedNames.filter((n) => !renamedComponents.some((r) => r.to === n)),
    renamedComponents,
    changelog
  };
}

// The comparison is a pure function of the two trees (bundle.json contents are
// content-addressed too), so it is reused while neither branch has moved
/** @type {{key: string, analysis: any} | null} */
let lastComparison = null;

/**
 * Fetch both repos and compare every connector. Also returns the raw
 * snapshots and path index the release needs.
 * @param {string} token
 */
export async function loadReleaseState(token) {
  const config = getReleaseConfig();
  const [source, target, pr] = await Promise.all([
    fetchSnapshot(token, config.source),
    fetchSnapshot(token, config.target),
    findReleasePr(token, config)
  ]);
  // With an open release PR, its branch is what the next commits build on, and
  // it tells which connectors are already on their way to the release branch
  const pending = pr ? await fetchSnapshot(token, config.head) : null;
  const live = { source, target, pending, pr, head: config.head };

  const key =
    `${source.repo.fullName}:${source.treeSha}|${target.repo.fullName}:${target.treeSha}|` +
    (pending ? `${pr.number}:${pending.treeSha}` : '-');
  if (lastComparison?.key === key) {
    // Fresh commit info (a new commit can keep the same tree), cached analysis
    return { ...lastComparison.analysis, ...live };
  }

  // Union of both repos' roots, so a file is attributed to the same connector
  // on both sides (e.g. a connector that got its bundle.json only on dev)
  const roots = new Set([...connectorRoots(source.files), ...connectorRoots(target.files)]);
  const { byConnector, byNamespace } = indexPaths(roots, source.files, target.files);
  const bundles = await readBundles(
    token,
    pending ? [source, target, pending] : [source, target],
    roots
  );

  const state = { source, target, pending, pr, roots, byConnector, byNamespace };
  const connectors = [...roots].sort().map((name) => describeConnector(name, state, bundles));

  // Shared namespace files (google/auth.js, microsoft/microsoft-commons.js, ...)
  // that differ — they ship with the namespace's connectors
  const namespaces = [...byNamespace]
    .map(([name, paths]) => {
      const diff = diffPaths(paths, source.files, target.files);
      const prefix = `${CONNECTORS_ROOT}${name}/`;
      return {
        name,
        added: diff.added.map((p) => p.slice(prefix.length)),
        modified: diff.modified.map((p) => p.slice(prefix.length)),
        removed: diff.removed.map((p) => p.slice(prefix.length))
      };
    })
    .filter((ns) => ns.added.length + ns.modified.length + ns.removed.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const analysis = { roots, byConnector, byNamespace, connectors, namespaces };
  lastComparison = { key, analysis };
  return { ...analysis, ...live };
}

/** @param {RepoRef} head */
function headInfo(head) {
  return { repo: head.fullName, branch: head.branch, url: head.url };
}

/**
 * Project status of the work each releasable connector would ship (see
 * readiness.js). Never rejects — the comparison is useful without it, so a
 * failure (typically a token without `read:project`) comes back as `error`.
 * @param {string} token
 * @param {any[]} connectors
 * @returns {Promise<{connectors: Record<string, any>, error: string | null, code?: string}>}
 */
async function releaseReadiness(token, connectors) {
  const { source, target, project, readyStatuses } = getReleaseConfig();
  try {
    return {
      connectors: await loadReadiness({
        graphql: (query) => githubRequest(token, 'POST', '/graphql', { query }),
        source,
        target,
        project,
        readyStatuses,
        connectors: connectors.filter((c) => RELEASABLE.has(c.status)),
        roots: connectors.map((c) => c.name)
      }),
      error: null
    };
  } catch (e) {
    console.error('Release readiness failed:', e);
    return {
      connectors: {},
      error: /** @type {any} */ (e)?.message || 'Release readiness failed',
      code: /** @type {any} */ (e)?.code
    };
  }
}

/**
 * Comparison for the /releases page and GET /api/releases.
 * @param {string} userId - User ID (email); their GitHub token overrides the env token
 * @param {{readiness?: boolean}} [options] - `readiness` adds a **promise** of
 *   the release readiness: the page streams it in after the comparison (it
 *   costs several seconds of GitHub GraphQL calls), the API awaits it
 */
export async function compareReleases(userId, { readiness = false } = {}) {
  const { token } = await getGitHubConfig(userId);
  const state = await loadReleaseState(token);
  const { project, readyStatuses } = getReleaseConfig();
  return {
    source: snapshotInfo(state.source),
    target: snapshotInfo(state.target),
    head: headInfo(state.head),
    pr: state.pr,
    project: { ...project, readyStatuses },
    connectors: state.connectors,
    namespaces: state.namespaces,
    ...(readiness ? { readiness: releaseReadiness(token, state.connectors) } : {})
  };
}

export { snapshotInfo, headInfo };
