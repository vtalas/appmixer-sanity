/**
 * Release readiness: is the work a release would ship finished on the project
 * board?
 *
 * For every releasable connector the pull requests merged into the development
 * branch since its last release are looked up, and each of them is tracked on
 * the GitHub project in one of two ways:
 *  - the PR closes an issue (a "Closes" keyword or the Development sidebar,
 *    also across repositories) and the issue is a project item, or
 *  - the PR itself is a project item.
 * A connector is ready when every tracked PR has a ready status ("Done").
 *
 * The module is pure: GitHub is reached through the injected `graphql`
 * function, so it runs outside SvelteKit as well.
 */

import { parseVersion, compareParsed } from './version.js';

const CONNECTORS_ROOT = 'src/appmixer/';
// History by path is the expensive part of the GitHub GraphQL API — a few
// connectors per query keep it under the 10 s limit
const HISTORY_CHUNK = 6;
const PR_CHUNK = 30;
const CONCURRENCY = 4;
const DIR_HISTORY_LIMIT = 50;
const BUNDLE_HISTORY_LIMIT = 15;

export class ReadinessError extends Error {
  /**
   * @param {string} message
   * @param {'scope' | 'github'} code
   */
  constructor(message, code = 'github') {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {{owner: string, name: string, fullName: string, branch: string}} RepoRef
 * @typedef {{owner: string, number: number, url: string}} ProjectRef
 * @typedef {(query: string) => Promise<{data?: any, errors?: Array<{type?: string, message: string}>}>} Graphql
 */

const str = (value) => JSON.stringify(String(value));

async function mapLimit(items, limit, fn) {
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

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * Run a query; partial data is fine (an alias GitHub timed out on stays null),
 * a missing scope is not — without `read:project` every status would be empty
 * and every connector would look untracked.
 * @param {Graphql} graphql
 * @param {string} query
 */
async function run(graphql, query) {
  const response = await graphql(query);
  const errors = response.errors || [];
  if (errors.some((e) => e.type === 'INSUFFICIENT_SCOPES')) {
    throw new ReadinessError(
      'The GitHub token cannot read projects — it needs the read:project scope',
      'scope'
    );
  }
  if (!response.data) {
    throw new ReadinessError(errors[0]?.message || 'The GitHub GraphQL API returned no data');
  }
  return response.data;
}

function branchHistories(repo, fields) {
  return `query {
  repository(owner: ${str(repo.owner)}, name: ${str(repo.name)}) {
    ref(qualifiedName: ${str(`refs/heads/${repo.branch}`)}) { target { ... on Commit {
${fields.join('\n')}
    } } }
  }
}`;
}

/**
 * When each connector was last released: the newest commit of the release
 * branch under its directory. The **authored** date — "Rebase and merge" of the
 * release PR rewrites the committer date to the merge time, while the author
 * date stays at the moment the release mirrored the development branch.
 * @returns {Promise<Map<string, string>>} connector -> ISO date
 */
async function lastReleaseDates(graphql, target, connectors) {
  const released = connectors.filter((c) => c.masterVersion);
  const dates = new Map();
  await mapLimit(chunks(released, HISTORY_CHUNK * 3), CONCURRENCY, async (chunk) => {
    const fields = chunk.map(
      (c, i) =>
        `      r${i}: history(first: 1, path: ${str(CONNECTORS_ROOT + c.name)}) { nodes { authoredDate } }`
    );
    const data = await run(graphql, branchHistories(target, fields));
    const commit = data.repository?.ref?.target || {};
    chunk.forEach((c, i) => {
      const date = commit[`r${i}`]?.nodes?.[0]?.authoredDate;
      if (date) dates.set(c.name, date);
    });
  });
  return dates;
}

const COMMIT_FIELDS = `oid committedDate messageHeadline url
          associatedPullRequests(first: 5) { nodes { number baseRefName repository { nameWithOwner } } }`;

/**
 * Unreleased commits of each connector on the development branch, from two
 * angles that cover each other's blind spot:
 *  - commits under the connector's directory newer than the last release — also
 *    finds changes that did not bump the version, but misses the commits of a
 *    branch merged with a merge commit when they predate the release;
 *  - commits that changed bundle.json to a version above the released one —
 *    found whatever their date, but only when the version was bumped.
 * A connector with connectors nested in its directory (utils holds utils/http,
 * utils/xml, ...) goes by bundle.json alone: the history of its directory is
 * mostly the history of its children.
 * @returns {Promise<Map<string, any[]>>} connector -> commits, newest first
 */
async function unreleasedCommits(graphql, source, connectors, releaseDates, parents) {
  const commits = new Map();
  await mapLimit(chunks(connectors, HISTORY_CHUNK), CONCURRENCY, async (chunk) => {
    const fields = chunk.flatMap((c, i) => {
      const dir = CONNECTORS_ROOT + c.name;
      const bundle = `${dir}/bundle.json`;
      const since = releaseDates.get(c.name);
      return [
        parents.has(c.name)
          ? ''
          : `      d${i}: history(first: ${DIR_HISTORY_LIMIT}, path: ${str(dir)}${since ? `, since: ${str(since)}` : ''}) {
        nodes { ${COMMIT_FIELDS} }
      }`,
        `      b${i}: history(first: ${BUNDLE_HISTORY_LIMIT}, path: ${str(bundle)}) {
        nodes { ${COMMIT_FIELDS}
          file(path: ${str(bundle)}) { object { ... on Blob { text } } }
        }
      }`
      ];
    });
    const data = await run(graphql, branchHistories(source, fields));
    const commit = data.repository?.ref?.target || {};

    chunk.forEach((c, i) => {
      const released = parseVersion(c.masterVersion);
      const bumps = (commit[`b${i}`]?.nodes || []).filter((node) => {
        if (!released) return true;
        const version = parseVersion(bundleVersion(node.file?.object?.text));
        return version && compareParsed(version, released) > 0;
      });
      const byOid = new Map();
      for (const node of [...(commit[`d${i}`]?.nodes || []), ...bumps]) {
        if (!byOid.has(node.oid)) byOid.set(node.oid, node);
      }
      commits.set(
        c.name,
        [...byOid.values()].sort((a, b) => b.committedDate.localeCompare(a.committedDate))
      );
    });
  });
  return commits;
}

function bundleVersion(text) {
  try {
    return JSON.parse(text).version;
  } catch {
    return null;
  }
}

/** The PR a commit reached the development branch with (not a release or sync PR that merely contains it) */
function sourcePr(commit, source) {
  return (commit.associatedPullRequests?.nodes || []).find(
    (pr) => pr.repository?.nameWithOwner === source.fullName && pr.baseRefName === source.branch
  );
}

const PROJECT_ITEM = `fragment Item on ProjectV2Item {
  isArchived
  project { number url owner { ... on Organization { login } ... on User { login } } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
}`;

/**
 * Project tracking of the given PRs — each PR once, however many connectors it touched.
 * @returns {Promise<Map<number, any>>}
 */
async function pullRequests(graphql, source, numbers) {
  const prs = new Map();
  await mapLimit(chunks(numbers, PR_CHUNK), CONCURRENCY, async (chunk) => {
    const fields = chunk.map(
      (number) => `    p${number}: pullRequest(number: ${number}) {
      number title url state merged
      projectItems(first: 10) { nodes { ...Item } }
      closingIssuesReferences(first: 10) { nodes {
        number title url state repository { nameWithOwner }
        projectItems(first: 10) { nodes { ...Item } }
      } }
    }`
    );
    const data = await run(
      graphql,
      `${PROJECT_ITEM}
query {
  repository(owner: ${str(source.owner)}, name: ${str(source.name)}) {
${fields.join('\n')}
  }
}`
    );
    for (const number of chunk) {
      const pr = data.repository?.[`p${number}`];
      if (pr) prs.set(number, pr);
    }
  });
  return prs;
}

/** Status of an item on the tracked project; undefined when it isn't there */
function projectStatus(node, project) {
  const item = (node.projectItems?.nodes || []).find(
    (i) =>
      i.project?.number === project.number &&
      i.project?.owner?.login?.toLowerCase() === project.owner.toLowerCase()
  );
  return item ? (item.status?.name ?? null) : undefined;
}

/**
 * How one PR is tracked. Issues win over the PR's own project item — the issue
 * is where the work is moved across the board when both are there.
 * @param {any} pr
 * @param {ProjectRef} project
 * @param {Set<string>} readyStatuses - lower-cased
 */
export function describePullRequest(pr, project, readyStatuses) {
  const isReady = (status) => !!status && readyStatuses.has(status.toLowerCase());
  const issues = (pr.closingIssuesReferences?.nodes || []).map((issue) => {
    const status = projectStatus(issue, project);
    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      repo: issue.repository?.nameWithOwner ?? null,
      state: issue.state,
      tracked: status !== undefined,
      status: status ?? null,
      ready: isReady(status)
    };
  });
  const trackedIssues = issues.filter((issue) => issue.tracked);
  const ownStatus = projectStatus(pr, project);

  /** @type {'issue' | 'pr' | null} */
  let via = null;
  let statuses = [];
  if (trackedIssues.length > 0) {
    via = 'issue';
    statuses = trackedIssues.map((issue) => issue.status);
  } else if (ownStatus !== undefined) {
    via = 'pr';
    statuses = [ownStatus];
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    merged: pr.merged,
    via,
    status: ownStatus ?? null,
    statuses,
    ready: via !== null && statuses.every(isReady),
    issues
  };
}

/**
 * - `ready`: every tracked PR is ready (untracked ones are listed, they don't block)
 * - `not-ready`: a tracked PR still has another status
 * - `untracked`: PRs were found, none of them is on the project
 * - `unknown`: no unreleased PR was found at all (changes pushed without one)
 * @param {Array<{via: string | null, ready: boolean}>} prs
 */
export function readinessState(prs) {
  const tracked = prs.filter((pr) => pr.via);
  if (prs.length === 0) return 'unknown';
  if (tracked.length === 0) return 'untracked';
  return tracked.every((pr) => pr.ready) ? 'ready' : 'not-ready';
}

/**
 * @param {{
 *   graphql: Graphql,
 *   source: RepoRef,
 *   target: RepoRef,
 *   project: ProjectRef,
 *   readyStatuses: string[],
 *   connectors: Array<{name: string, masterVersion: string | null}>,
 *   roots?: Iterable<string>
 * }} options - `connectors` are the ones to look up, `roots` every connector
 *   directory there is (to tell which connectors have others nested in them)
 * @returns {Promise<Record<string, any>>} connector -> readiness
 */
export async function loadReadiness({
  graphql,
  source,
  target,
  project,
  readyStatuses,
  connectors,
  roots = []
}) {
  if (connectors.length === 0) return {};
  const ready = new Set(readyStatuses.map((status) => status.toLowerCase()));
  const allRoots = [...roots];
  const parents = new Set(
    connectors
      .filter((c) => allRoots.some((root) => root.startsWith(`${c.name}/`)))
      .map((c) => c.name)
  );

  const releaseDates = await lastReleaseDates(graphql, target, connectors);
  const commits = await unreleasedCommits(graphql, source, connectors, releaseDates, parents);

  const numbers = new Set();
  for (const list of commits.values()) {
    for (const commit of list) {
      const pr = sourcePr(commit, source);
      if (pr) numbers.add(pr.number);
    }
  }
  const prs = await pullRequests(graphql, source, [...numbers]);
  const described = new Map(
    [...prs].map(([number, pr]) => [number, describePullRequest(pr, project, ready)])
  );

  /** @type {Record<string, any>} */
  const result = {};
  for (const connector of connectors) {
    const list = commits.get(connector.name) || [];
    const seen = new Set();
    const connectorPrs = [];
    const directCommits = [];
    for (const commit of list) {
      const number = sourcePr(commit, source)?.number;
      const pr = number ? described.get(number) : null;
      if (!pr) {
        directCommits.push({
          sha: commit.oid,
          url: commit.url,
          message: commit.messageHeadline,
          date: commit.committedDate
        });
      } else if (!seen.has(number)) {
        seen.add(number);
        connectorPrs.push(pr);
      }
    }
    result[connector.name] = {
      state: readinessState(connectorPrs),
      since: releaseDates.get(connector.name) ?? null,
      prs: connectorPrs,
      directCommits,
      // The history is capped — a connector with more unreleased commits than
      // that may have PRs that are not listed
      truncated: list.length >= DIR_HISTORY_LIMIT
    };
  }
  return result;
}
