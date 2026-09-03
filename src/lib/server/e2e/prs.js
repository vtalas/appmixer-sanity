import {
  getGitHubConfig,
  listOpenPullRequests,
  listPullRequestFiles,
  listConnectorRoots,
  fetchJsonAtRef,
  fetchPullRequestDetail,
  fetchCommitDate,
  fetchCommitCiState,
  fetchIssue,
  listIssueComments
} from '$lib/api/github.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';
import { getPRs, replacePRs, upsertPR, deletePR } from '$lib/db/prs.js';
import { getE2EFlows, getAccountServices } from '$lib/db/e2e.js';
import { connectorServices } from '$lib/server/e2e/scan.js';

const PR_BATCH = 5;
const CONTENT_BATCH = 5;

/**
 * Run `fn` over items with limited concurrency
 * @param {Array<any>} items
 * @param {number} limit
 * @param {(item: any, i: number) => Promise<any>} fn
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Test-flow file locations — same convention as findTestFlowFiles / the appmixer CLI:
 *   src/appmixer/<connector...>/artifacts/test-flows/test-flow-*.json  (canonical)
 *   src/appmixer/<connector...>/test-flow*.json                        (legacy)
 * @param {string} path
 */
function isTestFlowPath(path) {
  if (!path.startsWith('src/appmixer/') || !path.endsWith('.json')) return false;
  if (!path.split('/').pop().startsWith('test-flow')) return false;
  if (path.includes('/artifacts/')) {
    return path.includes('/artifacts/test-flows/');
  }
  return true;
}

/**
 * Connector root directory of a manifest file path (bundle/service/package.json
 * directly in a connector directory), or null.
 * @param {string} path
 */
function manifestRoot(path) {
  if (!path.startsWith('src/appmixer/')) return null;
  const parts = path.split('/');
  const fileName = parts[parts.length - 1];
  if (fileName !== 'bundle.json' && fileName !== 'service.json' && fileName !== 'package.json') {
    return null;
  }
  return parts.slice(2, -1).join('/') || null;
}

/**
 * Map a changed file path to its connector using the known connector roots
 * (longest match wins — handles nested connectors like "microsoft/calendar").
 * Falls back to the first path segment under src/appmixer/.
 * @param {string} path
 * @param {Set<string>} connectorRoots
 * @returns {string|null}
 */
function connectorForPath(path, connectorRoots) {
  if (!path.startsWith('src/appmixer/')) return null;
  const segments = path.split('/').slice(2, -1);
  if (segments.length === 0) return null;

  for (let len = segments.length; len > 0; len--) {
    const candidate = segments.slice(0, len).join('/');
    if (connectorRoots.has(candidate)) return candidate;
  }
  return segments[0];
}

/**
 * Closing issue references in a PR body — the repo convention is
 * `Closes Appmixer-ai/appmixer-components#123`, but plain `#123`, full issue
 * URLs and all GitHub closing keywords are recognized too.
 * @param {string} body
 * @param {string} defaultOwner - Owner of the PR repo (for plain `#123` refs)
 * @param {string} defaultRepo
 * @returns {Array<{owner: string, repo: string, number: number}>}
 */
export function parseClosingRefs(body, defaultOwner, defaultRepo) {
  if (!body) return [];
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?:([\w.-]+)\/([\w.-]+))?#(\d+))/gi;

  /** @type {Array<{owner: string, repo: string, number: number}>} */
  const refs = [];
  const seen = new Set();
  for (const match of body.matchAll(pattern)) {
    const owner = match[1] || match[4] || defaultOwner;
    const repo = match[2] || match[5] || defaultRepo;
    const number = Number(match[3] || match[6]);
    const key = `${owner}/${repo}#${number}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ owner, repo, number });
    }
  }
  return refs;
}

/**
 * Find the newest E2E report comment on an issue. A report is either marked
 * with a machine-readable marker (written by the /pr-finalize workflow):
 *   <!-- e2e-report {"allPassed":true,...} -->
 * or detected heuristically: a comment mentioning E2E with a results table.
 * @param {Array<{body: string, createdAt: string, url: string}>} comments
 * @returns {{createdAt: string, url: string, allPassed: boolean, source: string, connector?: string, instance?: string}|null}
 */
export function findE2EReport(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];

    const marker = comment.body.match(/<!--\s*e2e-report\s*({[\s\S]*?})\s*-->/);
    if (marker) {
      try {
        const meta = JSON.parse(marker[1]);
        return {
          createdAt: comment.createdAt,
          url: comment.url,
          allPassed: meta.allPassed === true,
          connector: meta.connector,
          instance: meta.instance,
          source: 'marker'
        };
      } catch {
        // fall through to the heuristic
      }
    }

    if (!/\be2e\b/i.test(comment.body)) continue;
    const tableLines = comment.body.split('\n').filter((line) => line.trim().startsWith('|'));
    if (tableLines.length < 3) continue; // header + separator + at least one flow
    const hasPass = tableLines.some((line) => /✓|✅|\bpass(ed)?\b/i.test(line));
    // Zero-failure counts ("0 failed", "failed: 0") are green, not failures
    const hasFail = tableLines.some((line) => {
      const cleaned = line
        .replace(/\b0\s+fail(?:ed|ing|ures?)?\b/gi, '')
        .replace(/\bfail(?:ed|ing|ures?)?\b\W{0,3}0\b/gi, '');
      return /✗|❌|\bfail(ed|ing)?\b/i.test(cleaned);
    });
    return {
      createdAt: comment.createdAt,
      url: comment.url,
      allPassed: hasPass && !hasFail,
      source: 'heuristic'
    };
  }
  return null;
}

/**
 * Scan all open PRs of the connectors repo: which connectors each PR touches
 * and which test-flow files it adds/changes (with the flow identity read from
 * the PR head). Replaces the e2e_prs cache of the configured repo.
 * @param {any} userId - User ID (email) or null for env credentials (cron)
 * @returns {Promise<{total: number, withTestFlows: number, errors: Array<string>}>}
 */
export async function scanPRs(userId) {
  /** @type {Array<string>} */
  const errors = [];

  const config = await getGitHubConfig(userId);
  const repoKey = `${config.owner}/${config.repo}`;

  const [prs, connectorRoots] = await Promise.all([
    listOpenPullRequests(userId),
    listConnectorRoots(userId).catch((e) => {
      errors.push(`Failed to list connector roots: ${e.message}`);
      return new Set();
    })
  ]);

  const rows = await mapLimit(prs, PR_BATCH, (pr) =>
    buildPRRow(userId, config, pr, connectorRoots, errors)
  );

  await replacePRs(repoKey, rows);

  return {
    total: rows.length,
    withTestFlows: rows.filter((r) => r.testFlows.length > 0).length,
    errors
  };
}

/**
 * Refresh a single PR in the cache — same data as a full scan, but for one PR
 * (a handful of GitHub calls instead of a few hundred). Drops the PR from the
 * cache when it turns out to be merged or closed.
 * @param {any} userId - User ID (email) or null for env credentials
 * @param {number} number - PR number
 * @returns {Promise<{number: number, removed: boolean, state: string, pr: any, errors: Array<string>}>}
 */
export async function scanPR(userId, number) {
  /** @type {Array<string>} */
  const errors = [];

  const config = await getGitHubConfig(userId);
  const repoKey = `${config.owner}/${config.repo}`;

  const [detail, connectorRoots] = await Promise.all([
    fetchPullRequestDetail(userId, number),
    listConnectorRoots(userId).catch((e) => {
      errors.push(`Failed to list connector roots: ${e.message}`);
      return new Set();
    })
  ]);

  if (detail.state !== 'open') {
    await deletePR(repoKey, number);
    return {
      number,
      removed: true,
      state: detail.merged ? 'merged' : detail.state,
      errors,
      pr: null
    };
  }

  // The detail response already carries everything the list endpoint returns,
  // so pass it along instead of fetching the PR twice.
  const row = await buildPRRow(userId, config, detail, connectorRoots, errors, detail);
  await upsertPR(repoKey, row);

  return { number, removed: false, state: 'open', pr: row, errors };
}

/**
 * Build one cache row for a PR: changed files → touched connectors and
 * test-flow files (with the flow identity read from the PR head), plus
 * mergeability, head commit CI state, linked issues and their newest E2E
 * report. Never throws — failures land in `errors` and yield an empty row.
 * @param {any} userId - User ID (email) or null for env credentials
 * @param {{owner: string, repo: string}} config - GitHub config
 * @param {any} pr - PR as returned by listOpenPullRequests / fetchPullRequestDetail
 * @param {Set<string>} connectorRoots - Connector roots of the dev tree
 * @param {Array<string>} errors - Collector for non-fatal failures
 * @param {any} [prefetchedDetail] - PR detail when the caller already has it
 * @returns {Promise<any>}
 */
async function buildPRRow(userId, config, pr, connectorRoots, errors, prefetchedDetail = null) {
  try {
    const [files, detail, headCommittedAt, ciStatus] = await Promise.all([
      listPullRequestFiles(userId, pr.number),
      prefetchedDetail ||
        fetchPullRequestDetail(userId, pr.number).catch((e) => {
          errors.push(`PR #${pr.number} detail: ${e.message}`);
          return { mergeable: null };
        }),
      pr.headSha
        ? fetchCommitDate(userId, pr.headSha).catch((e) => {
            errors.push(`PR #${pr.number} head commit: ${e.message}`);
            return null;
          })
        : null,
      pr.headSha
        ? fetchCommitCiState(userId, pr.headSha).catch((e) => {
            errors.push(`PR #${pr.number} CI state: ${e.message}`);
            return null;
          })
        : null
    ]);

    // Linked issues (closing refs) and the newest E2E report posted on them.
    // Independent of the changed files, so it runs alongside the flow-content
    // reads below instead of before them.
    const issuesPromise = collectLinkedIssues(userId, config, pr, errors);

    // Connector roots added by the PR itself (a brand-new connector doesn't
    // exist in the dev tree yet — without this it would map to its parent,
    // e.g. "ai/huggingface" to "ai")
    const prRoots = new Set(connectorRoots);
    for (const file of files) {
      if (file.status === 'removed') continue;
      const root = manifestRoot(file.path);
      if (root) prRoots.add(root);
    }

    const connectors = new Set();
    /** @type {Array<{path: string, status: string, flowName: string|null, connector: string|null}>} */
    const testFlows = [];

    for (const file of files) {
      const connector = connectorForPath(file.path, prRoots);
      if (connector) connectors.add(connector);

      if (isTestFlowPath(file.path)) {
        testFlows.push({
          path: file.path,
          status: file.status,
          flowName: null,
          connector
        });
      } else if (file.previousPath && isTestFlowPath(file.previousPath)) {
        // Renamed away from a test-flow location — treat as removed
        testFlows.push({
          path: file.previousPath,
          status: 'removed',
          flowName: null,
          connector: connectorForPath(file.previousPath, prRoots)
        });
      }
    }

    // Read the flow identity (JSON "name") from the PR head for present files
    const [{ linkedIssues, e2eReport }] = await Promise.all([
      issuesPromise,
      mapLimit(
        testFlows.filter((tf) => tf.status !== 'removed'),
        CONTENT_BATCH,
        async (tf) => {
          try {
            const content = await fetchJsonAtRef(userId, tf.path, pr.headSha);
            tf.flowName = content?.name || null;
          } catch (e) {
            errors.push(`PR #${pr.number} ${tf.path}: ${e.message}`);
          }
        }
      )
    ]);

    return {
      ...pr,
      connectors: [...connectors].sort(),
      testFlows,
      filesCount: files.length,
      headCommittedAt,
      mergeable: detail.mergeable,
      ciStatus,
      linkedIssues,
      e2eReport
    };
  } catch (e) {
    errors.push(`PR #${pr.number}: ${e.message}`);
    return {
      ...pr,
      connectors: [],
      testFlows: [],
      filesCount: null,
      headCommittedAt: null,
      mergeable: null,
      ciStatus: null,
      linkedIssues: [],
      e2eReport: null
    };
  }
}

/**
 * Closing-ref issues of a PR and the newest E2E report comment on any of them.
 * Every ref is resolved in parallel (and the issue and its comments together),
 * so a PR costs one round trip here instead of two per linked issue.
 * @param {any} userId - User ID (email) or null for env credentials
 * @param {{owner: string, repo: string}} config - GitHub config
 * @param {any} pr - PR with a `body`
 * @param {Array<string>} errors - Collector for non-fatal failures
 * @returns {Promise<{linkedIssues: Array<any>, e2eReport: any}>}
 */
async function collectLinkedIssues(userId, config, pr, errors) {
  const refs = parseClosingRefs(pr.body, config.owner, config.repo).slice(0, 5);

  const resolved = await Promise.all(
    refs.map(async (ref) => {
      const label = `${ref.owner}/${ref.repo}#${ref.number}`;
      try {
        // The comments request is fired next to the issue request and thrown
        // away when the ref turns out not to be a real issue.
        const [issue, comments] = await Promise.all([
          fetchIssue(userId, ref.owner, ref.repo, ref.number),
          listIssueComments(userId, ref.owner, ref.repo, ref.number).then(
            (value) => ({ value }),
            (/** @type {any} */ error) => ({ error })
          )
        ]);
        if (!issue) return null;
        if (comments.error) {
          errors.push(`PR #${pr.number} issue ${label}: ${comments.error.message}`);
          return { label, repo: `${ref.owner}/${ref.repo}`, issue, report: null };
        }
        return {
          label,
          repo: `${ref.owner}/${ref.repo}`,
          issue,
          report: findE2EReport(comments.value)
        };
      } catch (e) {
        errors.push(`PR #${pr.number} issue ${label}: ${/** @type {any} */ (e).message}`);
        return null;
      }
    })
  );

  /** @type {Array<any>} */
  const linkedIssues = [];
  let e2eReport = null;
  for (const entry of resolved) {
    if (!entry) continue;
    linkedIssues.push({ ...entry.issue, repo: entry.repo });
    if (entry.report && (!e2eReport || entry.report.createdAt > e2eReport.createdAt)) {
      e2eReport = { ...entry.report, issue: entry.label };
    }
  }

  return { linkedIssues, e2eReport };
}

const REPORT_MAX_AGE_DAYS = 5;

/** @param {string|null|undefined} value */
function parseDate(value) {
  if (!value) return null;
  const str = String(value);
  const date = new Date(str.includes('T') || str.includes('Z') ? str : `${str.replace(' ', 'T')}Z`);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Merge checklist of one PR — every item must pass for the PR to be
 * mergeable. Evaluated at read time so time-based rules (report age) stay
 * correct without a rescan.
 * @param {any} pr - Cached PR row
 * @param {Array<any>} connectors - Overview connector groups (with flows + accountAvailable)
 * @returns {{items: Array<{key: string, label: string, status: 'pass'|'fail'|'warn', detail: string}>, ready: boolean, readyForTesting: boolean}}
 */
export function buildChecklist(pr, connectors) {
  /** @type {Array<{key: string, label: string, status: 'pass'|'fail'|'warn', detail: string}>} */
  const items = [];

  // 1. A service account for every touched connector exists on the instance
  const accountGroups = connectors.filter(
    (c) => c.name !== 'utils' && !c.name.startsWith('utils/')
  );
  const missingAccounts = accountGroups.filter((c) => c.accountAvailable === false);
  const unknownAccounts = accountGroups.filter((c) => c.accountAvailable == null);
  if (missingAccounts.length > 0) {
    items.push({
      key: 'account',
      label: 'Account',
      status: 'fail',
      detail: `No service account on the instance for: ${missingAccounts.map((c) => c.name).join(', ')}`
    });
  } else if (accountGroups.length === 0) {
    items.push({
      key: 'account',
      label: 'Account',
      status: 'pass',
      detail: 'No account needed for the touched connectors'
    });
  } else if (unknownAccounts.length > 0) {
    items.push({
      key: 'account',
      label: 'Account',
      status: 'warn',
      detail: `Account state unknown for: ${unknownAccounts.map((c) => c.name).join(', ')} — run an E2E scan`
    });
  } else {
    items.push({
      key: 'account',
      label: 'Account',
      status: 'pass',
      detail: 'Service account available for every touched connector'
    });
  }

  // 2. The PR closes a tracker issue
  /** @type {Array<any>} */
  const linkedIssues = pr.linkedIssues || [];
  if (linkedIssues.length === 0) {
    items.push({
      key: 'issue',
      label: 'Linked issue',
      status: 'fail',
      detail:
        'No closing issue reference (e.g. "Closes Appmixer-ai/appmixer-components#123") in the PR description'
    });
  } else {
    const open = linkedIssues.filter((issue) => issue.state === 'open');
    items.push({
      key: 'issue',
      label: 'Linked issue',
      status: open.length > 0 ? 'pass' : 'warn',
      detail:
        linkedIssues.map((issue) => `${issue.repo}#${issue.number} (${issue.state})`).join(', ') +
        (open.length === 0 ? ' — already closed' : '')
    });
  }

  // 3. The linked issue carries a fresh, fully green E2E report
  const report = pr.e2eReport;
  const reportDate = parseDate(report?.createdAt);
  const headDate = parseDate(pr.headCommittedAt);
  if (!report) {
    items.push({
      key: 'report',
      label: 'E2E report',
      status: 'fail',
      detail:
        linkedIssues.length === 0
          ? 'No E2E report — no issue linked yet'
          : 'No E2E report comment found on the linked issue'
    });
  } else if (!report.allPassed) {
    items.push({
      key: 'report',
      label: 'E2E report',
      status: 'fail',
      detail: `E2E report on ${report.issue} is not fully green`
    });
  } else if (!reportDate) {
    items.push({
      key: 'report',
      label: 'E2E report',
      status: 'warn',
      detail: `E2E report on ${report.issue} has no readable date`
    });
  } else {
    const ageDays = (Date.now() - reportDate.getTime()) / 86400000;
    if (ageDays > REPORT_MAX_AGE_DAYS) {
      items.push({
        key: 'report',
        label: 'E2E report',
        status: 'fail',
        detail: `E2E report is ${Math.floor(ageDays)} days old (max ${REPORT_MAX_AGE_DAYS})`
      });
    } else if (headDate && reportDate < headDate) {
      items.push({
        key: 'report',
        label: 'E2E report',
        status: 'fail',
        detail: 'E2E report predates the last commit of the PR — re-run the suite'
      });
    } else {
      items.push({
        key: 'report',
        label: 'E2E report',
        status: headDate ? 'pass' : 'warn',
        detail: headDate
          ? `Green E2E report on ${report.issue}, ${Math.floor(ageDays)}d old, newer than the last commit`
          : `Green E2E report on ${report.issue}, but the head commit date is unknown — rescan PRs`
      });
    }
  }

  // 4. CI checks on the head commit
  /** @type {Record<string, {status: 'pass'|'fail'|'warn', detail: string}>} */
  const ciDetails = {
    success: { status: 'pass', detail: 'All CI checks passed' },
    failure: { status: 'fail', detail: 'CI checks failed on the head commit' },
    pending: { status: 'warn', detail: 'CI checks still running' },
    none: { status: 'warn', detail: 'No CI checks on the head commit' }
  };
  const ci = ciDetails[pr.ciStatus] || { status: 'warn', detail: 'CI state unknown — rescan PRs' };
  items.push({ key: 'ci', label: 'CI checks', status: ci.status, detail: ci.detail });

  // 5. Not a draft, no merge conflict
  if (pr.draft) {
    items.push({ key: 'mergeable', label: 'Mergeable', status: 'fail', detail: 'PR is a draft' });
  } else if (pr.mergeable === false) {
    items.push({
      key: 'mergeable',
      label: 'Mergeable',
      status: 'fail',
      detail: `Merge conflict with ${pr.baseBranch || 'the base branch'}`
    });
  } else if (pr.mergeable == null) {
    items.push({
      key: 'mergeable',
      label: 'Mergeable',
      status: 'warn',
      detail: 'Mergeability unknown — rescan PRs'
    });
  } else {
    items.push({
      key: 'mergeable',
      label: 'Mergeable',
      status: 'pass',
      detail: 'No merge conflicts'
    });
  }

  // 6. Live flow state on the instance: flows from the PR deployed, all results green
  const allFlows = connectors.flatMap((c) => c.flows);
  const undeployed = allFlows.filter((f) => f.changedInPR && !f.flowId);
  const failed = allFlows.filter((f) => f.lastResult === 'failed');
  const neverRan = allFlows.filter((f) => !f.lastResult);
  if (allFlows.length === 0) {
    items.push({
      key: 'flows',
      label: 'Flows green',
      status: connectors.length === 0 ? 'warn' : 'fail',
      detail:
        connectors.length === 0
          ? 'PR touches no connector files'
          : 'No E2E flows exist for the touched connectors'
    });
  } else if (undeployed.length > 0) {
    items.push({
      key: 'flows',
      label: 'Flows green',
      status: 'fail',
      detail: `${undeployed.length} flow${undeployed.length > 1 ? 's' : ''} from this PR not deployed on the instance`
    });
  } else if (failed.length > 0) {
    items.push({
      key: 'flows',
      label: 'Flows green',
      status: 'fail',
      detail: `${failed.length} flow${failed.length > 1 ? 's' : ''} failing: ${failed
        .map((f) => f.flowName)
        .slice(0, 5)
        .join(', ')}`
    });
  } else if (neverRan.length > 0) {
    items.push({
      key: 'flows',
      label: 'Flows green',
      status: 'warn',
      detail: `${neverRan.length} flow${neverRan.length > 1 ? 's' : ''} never ran on the instance`
    });
  } else {
    items.push({
      key: 'flows',
      label: 'Flows green',
      status: 'pass',
      detail: `All ${allFlows.length} flow${allFlows.length > 1 ? 's' : ''} deployed and green on the instance`
    });
  }

  // "Ready for testing" is the earlier gate: the prerequisites for actually
  // running the E2E suite against this PR — a service account for every touched
  // connector and green CI on the head commit. Everything else (report, flows,
  // linked issue) is what the testing itself produces.
  /** @param {string} key */
  const passed = (key) => items.find((item) => item.key === key)?.status === 'pass';

  return {
    items,
    ready: items.every((item) => item.status === 'pass'),
    readyForTesting: passed('account') && passed('ci')
  };
}

/**
 * Join the PR cache with the e2e_flows cache of the caller's instance:
 * per PR → per touched connector → that connector's flows (deployment/sync/
 * result/account state) with flows changed by the PR flagged, plus test-flow
 * files that exist only in the PR ("new in PR").
 * @param {any} userId - User ID (email) or null for env credentials
 * @returns {Promise<{repo: string, prs: Array<any>, lastScanAt: string|null}>}
 */
export async function buildPROverview(userId) {
  const config = await getGitHubConfig(userId);
  const repoKey = `${config.owner}/${config.repo}`;
  const instanceUrl = await getInstanceUrl(userId);

  const [prs, flows, accountServiceList] = await Promise.all([
    getPRs(repoKey),
    getE2EFlows(instanceUrl),
    getAccountServices(instanceUrl)
  ]);
  const accountServices = new Set(accountServiceList);

  /**
   * Account availability for any connector — from the accounts snapshot taken
   * during the e2e scan (works for connectors with no cached flows, e.g. new
   * connectors added by a PR); falls back to the flow-cache value when no
   * snapshot exists yet. utils never authenticates → null (no badge).
   * @param {string} connector
   * @param {Array<any>} cachedFlows
   */
  const accountAvailability = (connector, cachedFlows) => {
    if (connector === 'utils' || connector.startsWith('utils/')) return null;
    if (accountServices.size > 0) {
      return connectorServices(connector).some((s) => accountServices.has(s));
    }
    return cachedFlows.find((f) => f.accountAvailable != null)?.accountAvailable ?? null;
  };

  /** @type {Map<string, Array<any>>} */
  const flowsByConnector = new Map();
  for (const flow of flows) {
    if (!flow.connector) continue;
    if (!flowsByConnector.has(flow.connector)) flowsByConnector.set(flow.connector, []);
    flowsByConnector.get(flow.connector).push(flow);
  }

  const overview = prs.map((pr) => {
    const changedNames = new Set(
      pr.testFlows.filter((tf) => tf.flowName && tf.status !== 'removed').map((tf) => tf.flowName)
    );
    const changedPaths = new Set(
      pr.testFlows.filter((tf) => tf.status !== 'removed').map((tf) => tf.path)
    );

    const connectors = pr.connectors.map((name) => {
      const connectorFlows = (flowsByConnector.get(name) || []).map((flow) => ({
        flowName: flow.flowName,
        connector: flow.connector,
        githubPath: flow.githubPath,
        githubUrl: flow.githubUrl,
        flowId: flow.flowId,
        stage: flow.stage,
        syncStatus: flow.syncStatus,
        lastResult: flow.lastResult,
        lastResultAt: flow.lastResultAt,
        changedInPR:
          changedNames.has(flow.flowName) ||
          (flow.githubPath ? changedPaths.has(flow.githubPath) : false),
        newInPR: false
      }));

      const knownNames = new Set(connectorFlows.map((f) => f.flowName));
      const knownPaths = new Set(connectorFlows.map((f) => f.githubPath).filter(Boolean));

      // Test-flow files added by the PR that the dev-branch cache doesn't know yet
      for (const tf of pr.testFlows) {
        if (tf.status === 'removed' || tf.connector !== name) continue;
        if (tf.flowName && knownNames.has(tf.flowName)) continue;
        if (knownPaths.has(tf.path)) continue;
        connectorFlows.push({
          flowName: tf.flowName || tf.path.split('/').pop(),
          connector: name,
          githubPath: tf.path,
          githubUrl: `https://github.com/${repoKey}/blob/${pr.headBranch}/${tf.path}`,
          flowId: null,
          stage: null,
          syncStatus: 'not_deployed',
          lastResult: null,
          lastResultAt: null,
          changedInPR: true,
          newInPR: true
        });
      }

      connectorFlows.sort((a, b) => a.flowName.localeCompare(b.flowName));

      return {
        name,
        accountAvailable: accountAvailability(name, flowsByConnector.get(name) || []),
        flows: connectorFlows
      };
    });

    const checklist = buildChecklist(pr, connectors);

    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      draft: pr.draft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      filesCount: pr.filesCount,
      testFlowCount: pr.testFlows.filter((tf) => tf.status !== 'removed').length,
      linkedIssues: pr.linkedIssues || [],
      e2eReport: pr.e2eReport || null,
      scannedAt: pr.scannedAt || null,
      checklist: checklist.items,
      readyToMerge: checklist.ready,
      readyForTesting: checklist.readyForTesting,
      connectors
    };
  });

  // Freshness of the cache as a whole — the oldest row, not the newest: with
  // per-PR refreshes a single fresh card must not make the whole list look
  // just scanned. A full scan rewrites every row, so it still reads "just now".
  const lastScanAt = prs.reduce((min, pr) => {
    return pr.scannedAt && (!min || pr.scannedAt < min) ? pr.scannedAt : min;
  }, /** @type {string|null} */ (null));

  return { repo: repoKey, prs: overview, lastScanAt };
}
