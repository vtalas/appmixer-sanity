/**
 * Monthly statistics of the release repo (appmixer-components `master` — what
 * the production marketplace is built from): how many connectors, components
 * and E2E test flows it held at the end of a month (and how many it gained
 * that month), plus the releases of the month — every commit on master whose
 * message is a release message, `<connector> <version> (<new|major|minor|patch>)`.
 *
 * Counted the way appmixer-component-preview counts a local checkout — files
 * named bundle.json, component.json and test-flow*.json anywhere under
 * src/appmixer/ — so the numbers match its Statistics panel when it is
 * pointed at a checkout of the same commit. A month's state is the tree of
 * the last commit on master before the month ended (cached by tree sha in
 * memory, its counts in the DB); the bundle.json blobs come from the DB blob
 * cache of the release page.
 */

import { getGitHubConfig } from '$lib/api/github.js';
import { getTreeCounts, saveTreeCounts } from '$lib/db/statistics.js';
import {
  CONNECTORS_ROOT,
  connectorRoots,
  fetchTreeFiles,
  getReleaseConfig,
  githubRequest,
  ownerOf,
  readBundles
} from './release/compare.js';

const COMPONENT_FILE = 'component.json';
const TEST_FLOW_FILE = /^test-flow.*\.json$/;
// "hubspot 4.8.1 (patch)", "ai/typesafe 1.0.0 (new)" — the commit convention
// of appmixer-components master (the release page writes it the same way)
const RELEASE_MESSAGE = /^(\S+) (\d+\.\d+\.\d+\S*) \((new|major|minor|patch)\)\s*$/;
export const RELEASE_TYPES = ['new', 'major', 'minor', 'patch'];
const COMMITS_PAGE = 100;
const MAX_COMMIT_PAGES = 20;

/**
 * @typedef {{connectors: number, components: number, e2eFlows: number}} Counts
 * @typedef {{sha: string, url: string, date: string | null, treeSha: string, message: string}} Commit
 */

/**
 * Month boundaries (UTC). `month` is "YYYY-MM"; missing, invalid or in the
 * future → the current month.
 * @param {string | null | undefined} month
 */
export function monthRange(month) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let index = now.getUTCMonth();
  const match = month ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    if (m >= 0 && m < 12 && Date.UTC(y, m, 1) <= now.getTime()) {
      year = y;
      index = m;
    }
  }
  const start = new Date(Date.UTC(year, index, 1));
  const end = new Date(Date.UTC(year, index + 1, 1)); // exclusive
  const current = year === now.getUTCFullYear() && index === now.getUTCMonth();
  return {
    key: monthKey(start),
    start,
    end,
    current,
    previousKey: monthKey(new Date(Date.UTC(year, index - 1, 1))),
    nextKey: current ? null : monthKey(end)
  };
}

/** @param {Date} date */
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** @param {Date} date - exclusive end → the last second GitHub's inclusive `until` may match */
function untilParam(date) {
  return new Date(date.getTime() - 1000).toISOString();
}

/**
 * @param {any} item - GitHub commit list item
 * @param {string} fullName
 * @returns {Commit}
 */
function toCommit(item, fullName) {
  return {
    sha: item.sha,
    url: item.html_url || `https://github.com/${fullName}/commit/${item.sha}`,
    date: item.commit.committer?.date || item.commit.author?.date || null,
    treeSha: item.commit.tree.sha,
    message: String(item.commit.message || '').split('\n')[0]
  };
}

/**
 * The last commit on the branch before `until` (exclusive); null when the
 * branch has no commit that old.
 * @param {string} token
 * @param {{fullName: string, branch: string}} repo
 * @param {Date} until
 * @returns {Promise<Commit | null>}
 */
async function lastCommitBefore(token, repo, until) {
  const items = await githubRequest(
    token,
    'GET',
    `/repos/${repo.fullName}/commits?sha=${encodeURIComponent(repo.branch)}` +
      `&until=${encodeURIComponent(untilParam(until))}&per_page=1`
  );
  return items[0] ? toCommit(items[0], repo.fullName) : null;
}

/**
 * Every commit on the branch within [start, end), newest first.
 * @param {string} token
 * @param {{fullName: string, branch: string}} repo
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<Commit[]>}
 */
async function commitsBetween(token, repo, start, end) {
  /** @type {Commit[]} */
  const commits = [];
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    const items = await githubRequest(
      token,
      'GET',
      `/repos/${repo.fullName}/commits?sha=${encodeURIComponent(repo.branch)}` +
        `&since=${encodeURIComponent(start.toISOString())}` +
        `&until=${encodeURIComponent(untilParam(end))}` +
        `&per_page=${COMMITS_PAGE}&page=${page}`
    );
    for (const item of items) commits.push(toCommit(item, repo.fullName));
    if (items.length < COMMITS_PAGE) break;
  }
  return commits;
}

/**
 * Counts of a tree and, per connector directory, its component and flow counts.
 * @param {Map<string, {sha: string, mode: string}>} files
 */
function summarizeTree(files) {
  const roots = connectorRoots(files);
  /** @type {Map<string, {components: number, e2eFlows: number}>} */
  const perConnector = new Map([...roots].map((root) => [root, { components: 0, e2eFlows: 0 }]));
  let components = 0;
  /** @type {{connector: string, fileName: string, path: string}[]} */
  const e2eFlows = [];

  for (const path of files.keys()) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const isComponent = fileName === COMPONENT_FILE;
    const isFlow = !isComponent && TEST_FLOW_FILE.test(fileName);
    if (!isComponent && !isFlow) continue;

    const owner = ownerOf(path, roots);
    const stats = owner ? perConnector.get(owner) : null;
    if (isComponent) {
      components++;
      if (stats) stats.components++;
    } else {
      if (stats) stats.e2eFlows++;
      e2eFlows.push({
        // Nested connectors keep their full directory (microsoft/calendar)
        connector: owner || path.slice(CONNECTORS_ROOT.length).split('/')[0],
        fileName,
        path
      });
    }
  }
  e2eFlows.sort((a, b) => a.path.localeCompare(b.path));

  return {
    roots,
    perConnector,
    e2eFlows,
    counts: { connectors: roots.size, components, e2eFlows: e2eFlows.length }
  };
}

/**
 * What the DB keeps of a tree: the counts and the connector directories
 * @param {ReturnType<typeof summarizeTree>} summary
 */
function treeRecord(summary) {
  return { ...summary.counts, roots: [...summary.roots].sort() };
}

/**
 * Counts and connector directories of a tree — from the DB when the tree was
 * counted before.
 * @param {string} token
 * @param {string} fullName
 * @param {string} treeSha
 * @returns {Promise<Counts & {roots: string[]}>}
 */
async function treeCounts(token, fullName, treeSha) {
  const cached = (await getTreeCounts([treeSha])).get(treeSha);
  if (cached && Array.isArray(cached.roots)) return { ...cached, roots: cached.roots };
  const record = treeRecord(summarizeTree(await fetchTreeFiles(token, fullName, treeSha)));
  await saveTreeCounts(treeSha, record);
  return record;
}

/**
 * @param {string | null | undefined} content - bundle.json content, null when unknown
 * @returns {{name: string | null, version: string | null} | null} null when it does not parse
 */
function parseBundle(content) {
  if (content == null) return null;
  try {
    const bundle = JSON.parse(content);
    return {
      name: typeof bundle.name === 'string' ? bundle.name : null,
      version: typeof bundle.version === 'string' ? bundle.version : null
    };
  } catch {
    return null;
  }
}

/**
 * Statistics of one month for the /statistics page.
 * @param {string} userId - User ID (email); their GitHub token overrides the env token
 * @param {string | null | undefined} month - "YYYY-MM", default the current month
 */
export async function loadMonthlyStatistics(userId, month) {
  const { token } = await getGitHubConfig(userId);
  const { target } = getReleaseConfig();
  const range = monthRange(month);

  const [head, previousHead, commits] = await Promise.all([
    lastCommitBefore(token, target, range.end),
    lastCommitBefore(token, target, range.start),
    commitsBetween(token, target, range.start, range.end)
  ]);

  // Releases of the month: release commits by type, the rest kept aside
  const releases = [];
  const other = [];
  for (const commit of commits) {
    const match = RELEASE_MESSAGE.exec(commit.message);
    if (match) {
      releases.push({ ...commit, connector: match[1], version: match[2], type: match[3] });
    } else {
      other.push(commit);
    }
  }
  /** @type {Record<string, number>} */
  const releasesByType = Object.fromEntries(RELEASE_TYPES.map((type) => [type, 0]));
  for (const release of releases) releasesByType[release.type]++;

  const base = {
    repo: { repo: target.fullName, branch: target.branch, url: target.url },
    month: {
      key: range.key,
      current: range.current,
      previousKey: range.previousKey,
      nextKey: range.nextKey
    },
    releases,
    releasesByType,
    other
  };

  if (!head) {
    // The repo is younger than the month
    return {
      ...base,
      head: null,
      counts: { connectors: 0, components: 0, e2eFlows: 0 },
      previous: null,
      connectorChanges: null,
      connectors: [],
      e2eFlows: []
    };
  }

  const [files, previousTree, cachedCounts] = await Promise.all([
    fetchTreeFiles(token, target.fullName, head.treeSha),
    previousHead ? treeCounts(token, target.fullName, previousHead.treeSha) : null,
    getTreeCounts([head.treeSha])
  ]);
  const summary = summarizeTree(files);
  if (!cachedCounts.get(head.treeSha)?.roots) {
    await saveTreeCounts(head.treeSha, treeRecord(summary));
  }

  // Connectors that came and went during the month — the net change of the
  // connector count hides a removal behind the new ones (5 new, 1 removed = +4)
  const previousRoots = new Set(previousTree?.roots || []);
  const connectorChanges = previousTree
    ? {
        added: [...summary.roots].filter((root) => !previousRoots.has(root)).sort(),
        removed: [...previousRoots].filter((root) => !summary.roots.has(root)).sort()
      }
    : null;

  // Links pin the month's commit — a link into `master` would drift away from the month
  const fileUrl = (/** @type {string} */ path) =>
    `https://github.com/${target.fullName}/blob/${head.sha}/${path}`;

  const bundles = await readBundles(token, [{ repo: target, files }], summary.roots);
  const connectors = [...summary.roots]
    .map((directory) => {
      const path = `${CONNECTORS_ROOT}${directory}/bundle.json`;
      const file = files.get(path);
      const bundle = parseBundle(file ? bundles.get(file.sha) : null);
      const stats = summary.perConnector.get(directory) || { components: 0, e2eFlows: 0 };
      return {
        name: bundle?.name || `appmixer.${directory.replace(/\//g, '.')}`,
        directory,
        version: bundle?.version ?? null,
        valid: bundle !== null,
        components: stats.components,
        e2eFlows: stats.e2eFlows,
        url: fileUrl(path)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...base,
    head: { sha: head.sha, url: head.url, date: head.date },
    counts: summary.counts,
    previous: previousHead
      ? {
          month: range.previousKey,
          head: { sha: previousHead.sha, url: previousHead.url, date: previousHead.date },
          counts: previousTree
            ? {
                connectors: previousTree.connectors,
                components: previousTree.components,
                e2eFlows: previousTree.e2eFlows
              }
            : null
        }
      : null,
    connectorChanges,
    connectors,
    e2eFlows: summary.e2eFlows.map((flow) => ({ ...flow, url: fileUrl(flow.path) }))
  };
}
