/**
 * GitHub API client for fetching test-flow files from appmixer-connectors repository
 */

import { GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REPO_BRANCH } from '$env/static/private';
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
    const settings = userId ? await getUserSettings(userId, [
        SETTING_KEYS.GITHUB_REPO_OWNER,
        SETTING_KEYS.GITHUB_REPO_NAME,
        SETTING_KEYS.GITHUB_REPO_BRANCH,
        SETTING_KEYS.GITHUB_TOKEN
    ]) : {};

    // Custom token from DB overrides env token
    const token = settings[SETTING_KEYS.GITHUB_TOKEN] || GITHUB_TOKEN || '';

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
        'Accept': 'application/vnd.github.v3+json',
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
 * Clear the GitHub tree cache (call when settings change)
 */
export function clearGitHubCache() {
    cachedTree = null;
    cachedTreeKey = null;
    treeCacheExpiry = null;
}

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

    // Filter for test-flow*.json files in src/appmixer directory
    const testFlowFiles = tree.filter(item =>
        item.type === 'blob' &&
        item.path.startsWith('src/appmixer/') &&
        item.path.includes('test-flow') &&
        item.path.endsWith('.json')
    );

    return testFlowFiles.map(file => {
        // Extract connector name from path: src/appmixer/<connector>/...
        const pathParts = file.path.split('/');
        const connector = pathParts[2] || 'unknown';

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
export async function fetchFileContent(userId, path) {
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
 * @returns {Promise<{name: string, flow: Object}>}
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
 * Get the SHA of a branch reference
 * @param {string} userId - User ID (email)
 * @param {string} branch - Branch name
 * @returns {Promise<string>} - SHA of the branch
 */
export async function getBranchSha(userId, branch) {
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

    const response = await fetch(
        `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/refs`,
        {
            method: 'POST',
            headers: {
                ...getGitHubHeaders(config.token),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ref: `refs/heads/${branchName}`,
                sha: baseSha
            })
        }
    );

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

    const response = await fetch(
        `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls`,
        {
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
        }
    );

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

    const response = await fetch(
        `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}`,
        {
            headers: getGitHubHeaders(config.token)
        }
    );

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
