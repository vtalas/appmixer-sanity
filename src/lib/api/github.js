/**
 * GitHub API client for fetching test-flow files from appmixer-connectors repository
 */

import { GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REPO_BRANCH } from '$env/static/private';
import { getSettings, SETTING_KEYS } from '$lib/db/settings.js';

const GITHUB_API_BASE = 'https://api.github.com';

// Default values from environment
const ENV_DEFAULTS = {
    owner: GITHUB_REPO_OWNER || 'clientIO',
    repo: GITHUB_REPO_NAME || 'appmixer-connectors',
    branch: GITHUB_REPO_BRANCH || 'dev'
};

/**
 * Get current GitHub repo configuration (from DB settings or env defaults)
 * @returns {Promise<{owner: string, repo: string, branch: string, token: string}>}
 */
export async function getGitHubConfig() {
    const settings = await getSettings([
        SETTING_KEYS.GITHUB_REPO_OWNER,
        SETTING_KEYS.GITHUB_REPO_NAME,
        SETTING_KEYS.GITHUB_REPO_BRANCH,
        SETTING_KEYS.GITHUB_TOKEN
    ]);

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
 * @returns {Promise<Array<{path: string, sha: string, connector: string, name: string}>>}
 */
export async function findTestFlowFiles() {
    const config = await getGitHubConfig();
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
 * @param {string} path - File path in repository
 * @returns {Promise<string>}
 */
export async function fetchFileContent(path) {
    const config = await getGitHubConfig();
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
 * @param {string} path - File path in repository
 * @returns {Promise<{name: string, flow: Object}>}
 */
export async function fetchTestFlowJson(path) {
    const content = await fetchFileContent(path);
    return JSON.parse(content);
}

/**
 * Get GitHub repository info
 * @returns {Promise<{owner: string, repo: string, branch: string, url: string}>}
 */
export async function getGitHubRepoInfo() {
    const config = await getGitHubConfig();
    return {
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        url: `https://github.com/${config.owner}/${config.repo}/tree/${config.branch}`
    };
}

/**
 * Build a map of flow name -> GitHub file info
 * @returns {Promise<Map<string, {path: string, sha: string, connector: string, url: string, content?: Object}>>}
 */
export async function buildFlowNameToGitHubMap() {
    const testFlowFiles = await findTestFlowFiles();
    const flowMap = new Map();

    // Fetch content for each file to get the flow name
    // We'll batch these to avoid rate limiting
    const BATCH_SIZE = 10;

    for (let i = 0; i < testFlowFiles.length; i += BATCH_SIZE) {
        const batch = testFlowFiles.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async (file) => {
                try {
                    const content = await fetchTestFlowJson(file.path);
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
