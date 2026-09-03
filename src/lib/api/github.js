/**
 * GitHub API client for fetching test-flow files from appmixer-connectors repository
 */

import {
  SANITY_GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REPO_BRANCH
} from '$env/static/private';
import { getUserSettings, SETTING_KEYS } from '$lib/db/settings.js';

const GITHUB_API_BASE = 'https://api.github.com';

// Default values from environment
const ENV_DEFAULTS = {
  owner: GITHUB_REPO_OWNER || 'clientIO',
  repo: GITHUB_REPO_NAME || 'appmixer-connectors',
  branch: GITHUB_REPO_BRANCH || 'dev'
};

/**
 * Get current GitHub repo configuration (from DB settings or env defaults)
 * @param {string} userId - User ID (email)
 * @returns {Promise<{owner: string, repo: string, branch: string, token: string}>}
 */
export async function getGitHubConfig(userId) {
  const settings = userId
    ? await getUserSettings(userId, [
        SETTING_KEYS.GITHUB_REPO_OWNER,
        SETTING_KEYS.GITHUB_REPO_NAME,
        SETTING_KEYS.GITHUB_REPO_BRANCH,
        SETTING_KEYS.GITHUB_TOKEN
      ])
    : {};

  // Custom token from DB overrides env token
  const token = settings[SETTING_KEYS.GITHUB_TOKEN] || SANITY_GITHUB_TOKEN || '';

  return {
    owner: settings[SETTING_KEYS.GITHUB_REPO_OWNER] || ENV_DEFAULTS.owner,
    repo: settings[SETTING_KEYS.GITHUB_REPO_NAME] || ENV_DEFAULTS.repo,
    branch: settings[SETTING_KEYS.GITHUB_REPO_BRANCH] || ENV_DEFAULTS.branch,
    token
  };
}

/**
 * Get headers for GitHub API requests
 * @param {string} [token] - Optional token to use for authentication
 * @returns {Object} Headers object with authentication if token is available
 */
function getGitHubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'appmixer-sanity-check'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

// Cache for GitHub API responses (tree structure)
// Cache key includes repo config to invalidate when settings change
let cachedTree = null;
let cachedTreeKey = null;
let treeCacheExpiry = null;
const TREE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the repository tree recursively
 * @param {{owner: string, repo: string, branch: string, token: string}} config
 * @returns {Promise<Array<{path: string, sha: string, url: string}>>}
 */
async function getRepoTree(config) {
  const cacheKey = `${config.owner}/${config.repo}/${config.branch}`;

  if (cachedTree && cachedTreeKey === cacheKey && treeCacheExpiry && Date.now() < treeCacheExpiry) {
    return cachedTree;
  }

  const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`;
  const response = await fetch(url, {
    headers: getGitHubHeaders(config.token)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub tree: ${response.status}`);
  }

  const data = await response.json();
  cachedTree = data.tree;
  cachedTreeKey = cacheKey;
  treeCacheExpiry = Date.now() + TREE_CACHE_TTL;

  return cachedTree;
}

/**
 * Find all test-flow files in the repository
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<{path: string, sha: string, connector: string, name: string}>>}
 */
export async function findTestFlowFiles(userId) {
  const config = await getGitHubConfig(userId);
  const tree = await getRepoTree(config);

  // Test-flow locations (same convention as the appmixer CLI):
  //   src/appmixer/<connector...>/artifacts/test-flows/test-flow-*.json  (canonical)
  //   src/appmixer/<connector...>/test-flow*.json                        (legacy, connector root)
  // Everything else under artifacts/ (ai-artifacts, generated intermediates) is ignored.
  const testFlowFiles = tree.filter((item) => {
    if (item.type !== 'blob') return false;
    if (!item.path.startsWith('src/appmixer/') || !item.path.endsWith('.json')) return false;
    if (!item.path.split('/').pop().startsWith('test-flow')) return false;
    if (item.path.includes('/artifacts/')) {
      return item.path.includes('/artifacts/test-flows/');
    }
    return true;
  });

  return testFlowFiles.map((file) => {
    // Connector = directory path between src/appmixer/ and the file
    // (minus the artifacts/test-flows suffix; handles nested connectors like microsoft/calendar)
    const dirParts = file.path.split('/').slice(2, -1);
    if (
      dirParts[dirParts.length - 2] === 'artifacts' &&
      dirParts[dirParts.length - 1] === 'test-flows'
    ) {
      dirParts.splice(-2, 2);
    }
    const connector = dirParts.join('/') || 'unknown';

    return {
      path: file.path,
      sha: file.sha,
      connector,
      url: `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${file.path}`
    };
  });
}

/**
 * Fetch the content of a file from GitHub
 * @param {string} userId - User ID (email)
 * @param {string} path - File path in repository
 * @returns {Promise<string>}
 */
async function fetchFileContent(userId, path) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`,
    {
      headers: getGitHubHeaders(config.token)
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch file ${path}: ${response.status}`);
  }

  const data = await response.json();

  // Content is base64 encoded
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return content;
}

/**
 * Fetch test-flow file and parse its JSON
 * @param {string} userId - User ID (email)
 * @param {string} path - File path in repository
 * @returns {Promise<any>}
 */
export async function fetchTestFlowJson(userId, path) {
  const content = await fetchFileContent(userId, path);
  return JSON.parse(content);
}

/**
 * Get GitHub repository info
 * @param {string} userId - User ID (email)
 * @returns {Promise<{owner: string, repo: string, branch: string, url: string}>}
 */
export async function getGitHubRepoInfo(userId) {
  const config = await getGitHubConfig(userId);
  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    url: `https://github.com/${config.owner}/${config.repo}/tree/${config.branch}`
  };
}

/**
 * Build a map of flow name -> GitHub file info
 * @param {string} userId - User ID (email)
 * @returns {Promise<Map<string, {path: string, sha: string, connector: string, url: string, content?: Object}>>}
 */
export async function buildFlowNameToGitHubMap(userId) {
  const testFlowFiles = await findTestFlowFiles(userId);
  const flowMap = new Map();

  // Fetch content for each file to get the flow name
  // We'll batch these to avoid rate limiting
  const BATCH_SIZE = 10;

  for (let i = 0; i < testFlowFiles.length; i += BATCH_SIZE) {
    const batch = testFlowFiles.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await fetchTestFlowJson(userId, file.path);
          return { file, content };
        } catch (e) {
          console.error(`Failed to fetch ${file.path}:`, e.message);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result && result.content.name) {
        flowMap.set(result.content.name, {
          ...result.file,
          content: result.content
        });
      }
    }
  }

  return flowMap;
}

/**
 * Generate a file path for a new flow in GitHub
 * @param {string} connector - Connector name (e.g., "box")
 * @param {string} flowName - Flow name (e.g., "E2E box - Upload File")
 * @returns {string} - Generated file path
 */
export function generateFlowPath(connector, flowName) {
  // Sanitize flow name for file system
  const safeName = flowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `src/appmixer/${connector}/test-flow-${safeName}.json`;
}

/**
 * List all open pull requests of the configured repository
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<{number: number, title: string, url: string, author: string, baseBranch: string, headBranch: string, headSha: string, draft: boolean, createdAt: string, updatedAt: string}>>}
 */
export async function listOpenPullRequests(userId) {
  const config = await getGitHubConfig(userId);
  const prs = [];

  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: getGitHubHeaders(config.token) }
    );
    if (!response.ok) {
      throw new Error(`Failed to list pull requests: ${response.status}`);
    }
    const batch = await response.json();
    for (const pr of batch) {
      prs.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user?.login || null,
        baseBranch: pr.base?.ref || null,
        headBranch: pr.head?.ref || null,
        headSha: pr.head?.sha || null,
        draft: !!pr.draft,
        body: pr.body || '',
        createdAt: pr.created_at,
        updatedAt: pr.updated_at
      });
    }
    if (batch.length < 100) break;
  }

  return prs;
}

/**
 * Fetch a single pull request. Returns the same fields as the list endpoint
 * plus `mergeable`, which the list endpoint doesn't compute — GitHub computes
 * it lazily, so null means "still computing" (unknown). `state` lets a
 * single-PR refresh notice that the PR was merged or closed meanwhile.
 * @param {string} userId - User ID (email)
 * @param {number} prNumber
 * @returns {Promise<{number: number, title: string, url: string, author: string|null, baseBranch: string|null, headBranch: string|null, headSha: string|null, draft: boolean, body: string, createdAt: string, updatedAt: string, state: string, merged: boolean, mergeable: boolean|null, mergeableState: string|null}>}
 */
export async function fetchPullRequestDetail(userId, prNumber) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls/${prNumber}`,
    { headers: getGitHubHeaders(config.token) }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch PR #${prNumber}: ${response.status}`);
  }
  const pr = await response.json();
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login || null,
    baseBranch: pr.base?.ref || null,
    headBranch: pr.head?.ref || null,
    headSha: pr.head?.sha || null,
    draft: !!pr.draft,
    body: pr.body || '',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    state: pr.state,
    merged: !!pr.merged_at,
    mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
    mergeableState: pr.mergeable_state || null
  };
}

/**
 * Committer date of a commit (needed to judge whether E2E results are newer
 * than the code being merged)
 * @param {string} userId - User ID (email)
 * @param {string} ref - Commit SHA
 * @returns {Promise<string|null>} ISO date or null
 */
export async function fetchCommitDate(userId, ref) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/commits/${ref}`,
    { headers: getGitHubHeaders(config.token) }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch commit ${ref}: ${response.status}`);
  }
  const commit = await response.json();
  return commit.commit?.committer?.date || commit.commit?.author?.date || null;
}

/**
 * Combined CI state of a commit: check runs (Actions & apps) merged with the
 * legacy commit status API.
 * @param {string} userId - User ID (email)
 * @param {string} ref - Commit SHA
 * @returns {Promise<'success'|'failure'|'pending'|'none'>}
 */
export async function fetchCommitCiState(userId, ref) {
  const config = await getGitHubConfig(userId);
  const headers = getGitHubHeaders(config.token);
  const base = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/commits/${ref}`;

  const [checksResponse, statusResponse] = await Promise.all([
    fetch(`${base}/check-runs?per_page=100`, { headers }),
    fetch(`${base}/status`, { headers })
  ]);
  if (!checksResponse.ok) {
    throw new Error(`Failed to fetch check runs of ${ref}: ${checksResponse.status}`);
  }
  if (!statusResponse.ok) {
    throw new Error(`Failed to fetch commit status of ${ref}: ${statusResponse.status}`);
  }
  const checks = await checksResponse.json();
  const status = await statusResponse.json();

  const states = [];
  for (const run of checks.check_runs || []) {
    if (run.status !== 'completed') states.push('pending');
    else if (
      run.conclusion === 'success' ||
      run.conclusion === 'neutral' ||
      run.conclusion === 'skipped'
    )
      states.push('success');
    else states.push('failure');
  }
  if (status.total_count > 0) states.push(status.state); // success | failure | pending

  if (states.length === 0) return 'none';
  if (states.includes('failure') || states.includes('error')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}

/**
 * Fetch one issue, possibly from a different repo than the configured one
 * (the issue tracker lives in appmixer-components while PRs live in
 * appmixer-connectors). Returns null when the issue doesn't exist.
 * @param {string} userId - User ID (email)
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<{number: number, title: string, state: string, url: string}|null>}
 */
export async function fetchIssue(userId, owner, repo, issueNumber) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`, {
    headers: getGitHubHeaders(config.token)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch issue ${owner}/${repo}#${issueNumber}: ${response.status}`);
  }
  const issue = await response.json();
  // The issues API also returns PRs — a closing ref must point at a real issue
  if (issue.pull_request) return null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url
  };
}

/**
 * List comments of an issue (up to 300, oldest first — GitHub default order)
 * @param {string} userId - User ID (email)
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<Array<{body: string, createdAt: string, url: string, author: string|null}>>}
 */
export async function listIssueComments(userId, owner, repo, issueNumber) {
  const config = await getGitHubConfig(userId);
  const comments = [];

  for (let page = 1; page <= 3; page++) {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { headers: getGitHubHeaders(config.token) }
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list comments of ${owner}/${repo}#${issueNumber}: ${response.status}`
      );
    }
    const batch = await response.json();
    for (const comment of batch) {
      comments.push({
        body: comment.body || '',
        createdAt: comment.created_at,
        url: comment.html_url,
        author: comment.user?.login || null
      });
    }
    if (batch.length < 100) break;
  }

  return comments;
}

/**
 * List changed files of a pull request (GitHub caps this listing at 3000 files)
 * @param {string} userId - User ID (email)
 * @param {number} prNumber
 * @returns {Promise<Array<{path: string, status: string, previousPath: string|null}>>}
 */
export async function listPullRequestFiles(userId, prNumber) {
  const config = await getGitHubConfig(userId);
  const files = [];

  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      { headers: getGitHubHeaders(config.token) }
    );
    if (!response.ok) {
      throw new Error(`Failed to list files of PR #${prNumber}: ${response.status}`);
    }
    const batch = await response.json();
    for (const file of batch) {
      files.push({
        path: file.filename,
        status: file.status, // added | modified | removed | renamed | ...
        previousPath: file.previous_filename || null
      });
    }
    if (batch.length < 100) break;
  }

  return files;
}

/**
 * Fetch and parse a JSON file at an arbitrary ref (branch or commit SHA)
 * @param {string} userId - User ID (email)
 * @param {string} path - File path in repository
 * @param {string} ref - Branch name or commit SHA
 * @returns {Promise<any>}
 */
export async function fetchJsonAtRef(userId, path, ref) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { headers: getGitHubHeaders(config.token) }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch file ${path}@${ref}: ${response.status}`);
  }

  const data = await response.json();
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}

/**
 * Connector root directories (relative to src/appmixer/) — every directory that
 * contains a bundle.json/service.json/package.json. Used to map an arbitrary
 * changed file path to its connector (handles nested connectors like
 * "microsoft/calendar" where "microsoft" is only a namespace).
 * @param {string} userId - User ID (email)
 * @returns {Promise<Set<string>>}
 */
export async function listConnectorRoots(userId) {
  const config = await getGitHubConfig(userId);
  const tree = await getRepoTree(config);

  const roots = new Set();
  for (const item of tree) {
    if (item.type !== 'blob' || !item.path.startsWith('src/appmixer/')) continue;
    const parts = item.path.split('/');
    const fileName = parts[parts.length - 1];
    if (fileName === 'bundle.json' || fileName === 'service.json' || fileName === 'package.json') {
      const root = parts.slice(2, -1).join('/');
      if (root) roots.add(root);
    }
  }
  return roots;
}

/**
 * Get the SHA of a branch reference
 * @param {string} userId - User ID (email)
 * @param {string} branch - Branch name
 * @returns {Promise<string>} - SHA of the branch
 */
async function getBranchSha(userId, branch) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/ref/heads/${branch}`,
    {
      headers: getGitHubHeaders(config.token)
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get branch SHA: ${response.status}`);
  }

  const data = await response.json();
  return data.object.sha;
}

/**
 * Create a new branch from a base branch
 * @param {string} userId - User ID (email)
 * @param {string} branchName - New branch name
 * @param {string} baseBranch - Base branch to create from
 * @returns {Promise<{ref: string, sha: string}>}
 */
export async function createBranch(userId, branchName, baseBranch) {
  const config = await getGitHubConfig(userId);
  const baseSha = await getBranchSha(userId, baseBranch);

  const response = await fetch(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/refs`, {
    method: 'POST',
    headers: {
      ...getGitHubHeaders(config.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create branch: ${error.message || response.status}`);
  }

  const data = await response.json();
  return {
    ref: data.ref,
    sha: data.object.sha
  };
}

/**
 * Get file info (including SHA) from GitHub
 * @param {string} userId - User ID (email)
 * @param {string} path - File path
 * @param {string} branch - Branch name
 * @returns {Promise<{sha: string, content: string} | null>}
 */
async function getFileInfo(userId, path, branch) {
  const config = await getGitHubConfig(userId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}?ref=${branch}`,
    {
      headers: getGitHubHeaders(config.token)
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to get file info: ${response.status}`);
  }

  const data = await response.json();
  return {
    sha: data.sha,
    content: Buffer.from(data.content, 'base64').toString('utf-8')
  };
}

/**
 * Create or update a file in GitHub
 * @param {string} userId - User ID (email)
 * @param {string} path - File path
 * @param {string} content - File content (will be base64 encoded)
 * @param {string} message - Commit message
 * @param {string} branch - Branch name
 * @returns {Promise<{sha: string, commit: {sha: string}}>}
 */
export async function createOrUpdateFile(userId, path, content, message, branch) {
  const config = await getGitHubConfig(userId);

  // Check if file exists to get its SHA (required for updates)
  const existingFile = await getFileInfo(userId, path, branch);

  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch
  };

  if (existingFile) {
    body.sha = existingFile.sha;
  }

  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        ...getGitHubHeaders(config.token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create/update file: ${error.message || response.status}`);
  }

  return response.json();
}

/**
 * Create a pull request
 * @param {string} userId - User ID (email)
 * @param {string} title - PR title
 * @param {string} body - PR description
 * @param {string} head - Head branch (source)
 * @param {string} base - Base branch (target)
 * @returns {Promise<{number: number, html_url: string}>}
 */
export async function createPullRequest(userId, title, body, head, base) {
  const config = await getGitHubConfig(userId);

  const response = await fetch(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls`, {
    method: 'POST',
    headers: {
      ...getGitHubHeaders(config.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title,
      body,
      head,
      base
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create PR: ${error.message || response.status}`);
  }

  return response.json();
}

/**
 * Verify GitHub token has write access to the repository
 * @param {string} userId - User ID (email)
 * @returns {Promise<{hasWriteAccess: boolean, error?: string}>}
 */
export async function verifyWriteAccess(userId) {
  const config = await getGitHubConfig(userId);

  if (!config.token) {
    return { hasWriteAccess: false, error: 'No GitHub token configured' };
  }

  const response = await fetch(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}`, {
    headers: getGitHubHeaders(config.token)
  });

  if (!response.ok) {
    return { hasWriteAccess: false, error: `Cannot access repository: ${response.status}` };
  }

  const data = await response.json();

  // Check if user has push permission
  if (!data.permissions?.push) {
    return { hasWriteAccess: false, error: 'Token does not have write access to this repository' };
  }

  return { hasWriteAccess: true };
}
